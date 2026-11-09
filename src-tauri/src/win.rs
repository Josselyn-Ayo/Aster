//! Integración con Windows: apertura de objetivos, escaneo del menú Inicio y
//! estado de la batería.
//!
//! No se usa `cmd /c` ni `powershell`: todo se abre con `ShellExecuteW`, que
//! recibe un archivo o un URI ya resuelto. Es el mismo ejecutor que evita el
//! fallo clásico de `start "" "explorer.exe"` con rutas sin comillas.
use std::path::{Path, PathBuf};

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::GetLastError;
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::model::{AllowedApp, BatteryReport};
use crate::paths;

/* ------------------------------------------------------------------ */
/* Resolución de objetivos                                            */
/* ------------------------------------------------------------------ */

/// Carpetas del menú Inicio donde buscar instaladores de aplicaciones.
fn start_menu_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(program_data) = std::env::var("ProgramData") {
        dirs.push(
            PathBuf::from(program_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    if let Ok(app_data) = std::env::var("APPDATA") {
        dirs.push(
            PathBuf::from(app_data)
                .join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs"),
        );
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// Traduce un nombre común al ejecutable inequívoco del sistema.
/// Es una ayuda de resolución, no una vía de ejecución libre: el resultado
/// siempre pasa después por [`paths::ensure_launchable`].
fn system_target(app: &str) -> Option<&'static str> {
    const MAP: [(&str, &str); 16] = [
        ("bloc de notas", "notepad.exe"),
        ("notepad", "notepad.exe"),
        ("paint", "mspaint.exe"),
        ("calculadora", "calc.exe"),
        ("calculator", "calc.exe"),
        ("explorador de archivos", "explorer.exe"),
        ("explorador", "explorer.exe"),
        ("file explorer", "explorer.exe"),
        ("navegador", "explorer.exe"),
        ("browser", "explorer.exe"),
        ("google chrome", "chrome.exe"),
        ("chrome", "chrome.exe"),
        ("microsoft edge", "msedge.exe"),
        ("edge", "msedge.exe"),
        ("spotify", "spotify.exe"),
        ("word", "winword.exe"),
    ];
    let needle = app.trim().to_lowercase();
    MAP.iter()
        .find(|(key, _)| *key == needle)
        .map(|(_, value)| *value)
}

/// Busca un ejecutable en el `PATH` del proceso.
fn in_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return std::fs::canonicalize(&candidate).ok();
        }
    }
    None
}

/// Busca un acceso directo del menú Inicio con ese nombre.
/// Acepta tanto el nombre visible («Google Chrome») como una ruta .lnk
/// guardada antes («C:\…\Google Chrome.lnk»): en ese caso se compara por el
/// nombre del archivo, lo que permite re-resolver si el acceso directo se
/// movió tras una reinstalación. El recorrido es recursivo (3 niveles), igual
/// que el escaneo de aplicaciones.
fn in_start_menu(app: &str) -> Option<PathBuf> {
    let needle = app.trim().to_lowercase();
    let needle_stem = Path::new(needle.as_str())
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| needle.clone());
    let mut best: Option<PathBuf> = None;
    for dir in start_menu_dirs() {
        for path in list_files_depth(&dir, 3) {
            if path.extension().and_then(|e| e.to_str()) != Some("lnk") {
                continue;
            }
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if (stem == needle || stem == needle_stem) && best.is_none() {
                best = Some(path);
            }
        }
    }
    best
}

/** Resuelve un destino de la lista blanca a una ruta real del sistema. */
pub fn resolve_target(target: &str) -> Result<PathBuf, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("El destino está vacío.".to_string());
    }
    let candidate = Path::new(trimmed);

    // 1) Ruta explícita.
    if candidate.extension().is_some() {
        if let Ok(resolved) = std::fs::canonicalize(candidate) {
            paths::ensure_launchable(&resolved)?;
            return Ok(resolved);
        }
    }

    // 2) Nombre común traducido a ejecutable del sistema.
    let exe = if candidate.extension().is_some() {
        Some(trimmed)
    } else {
        system_target(trimmed)
    };
    if let Some(exe) = exe {
        if let Some(found) = in_path(exe) {
            paths::ensure_launchable(&found)?;
            return Ok(found);
        }
    }

    // 3) Acceso directo del menú Inicio con ese nombre.
    if let Some(lnk) = in_start_menu(trimmed) {
        return Ok(lnk);
    }

    Err(format!("No se encontró «{trimmed}» en el sistema."))
}

/**
 * Abre un objetivo ya autorizado con `ShellExecuteW`.
 * Devuelve la ruta resuelta, que es la que queda registrada en la auditoría.
 *
 * Los destinos del menú Inicio casi siempre contienen espacios
 * («C:\…\Start Menu\Programs\Google Chrome.lnk»), así que la ruta completa
 * se intenta primero tal cual: solo se separa «programa + argumentos» cuando
 * la ruta completa no resuelve (p. ej. «explorer.exe https://…»).
 */
pub fn launch_authorized(target: &str) -> Result<String, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("El destino está vacío.".to_string());
    }

    // 1) Destino entrecomillado: "C:\ruta con espacios\app.exe" args
    if let Some(stripped) = trimmed.strip_prefix('"') {
        if let Some(end) = stripped.find('"') {
            let program = stripped[..end].trim();
            let args = stripped[end + 1..].trim();
            let resolved = resolve_target(program)?.to_string_lossy().to_string();
            shell_execute(&resolved, args)?;
            return Ok(resolved);
        }
    }

    // 2) Ruta completa tal cual (con espacios). `resolve_target` ya
    // canonicaliza rutas explícitas, así que si resuelve no hay argumentos.
    let lower = trimmed.to_lowercase();
    let looks_like_path = trimmed.contains('\\')
        || trimmed.contains('/')
        || lower.ends_with(".lnk")
        || lower.ends_with(".exe");
    if looks_like_path {
        if let Ok(resolved) = resolve_target(trimmed) {
            let s = resolved.to_string_lossy().to_string();
            shell_execute(&s, "")?;
            return Ok(s);
        }
        // Si es una ruta absoluta y no resolvió, no partirla por el primer
        // espacio: eso la recortaba («C:\…\Start» en vez de la ruta completa)
        // y producía el error «No se encontró «C:\…\Start»».
        if Path::new(trimmed).is_absolute() || trimmed.starts_with("\\\\") {
            // `resolve_target` ya genera el mensaje con la ruta completa; se
            // vuelve a llamar para devolverlo (ahora con re-resolución por
            // nombre de .lnk incluida).
            return Err(resolve_target(trimmed).unwrap_err());
        }
    }

    // 3) URI sin ruta («spotify:search:…», «ms-photos:viewers»).
    if trimmed.contains(':') && !trimmed.contains('\\') && !trimmed.contains('/') {
        shell_execute(trimmed, "")?;
        return Ok(trimmed.to_string());
    }

    // 4) Ejecutable + argumentos («explorer.exe https://…»): se separa el
    // ejecutable del resto, que se pasa como parámetro a ShellExecuteW.
    let (program, args) = match trimmed.split_once(char::is_whitespace) {
        Some((program, rest)) if !rest.trim().is_empty() => (program.trim(), rest.trim()),
        _ => (trimmed, ""),
    };

    let resolved = if program.contains(':') && !program.contains('\\') {
        // Es un URI («spotify:search:…», «ms-photos:viewers»), no una ruta.
        program.to_string()
    } else {
        resolve_target(program)?.to_string_lossy().to_string()
    };

    shell_execute(&resolved, args)?;
    Ok(resolved)
}

/** Invoca a `ShellExecuteW`, el único mecanismo de apertura del backend. */
pub fn shell_execute(target: &str, args: &str) -> Result<(), String> {
    let verb = HSTRING::from("open");
    let file = HSTRING::from(target);
    let parameters = HSTRING::from(args);
    let directory = HSTRING::from("");

    // SAFETY: los cuatro HSTRING son punteros válidos y distintos, y
    // ShellExecuteW no retiene ninguno más allá de la llamada.
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(parameters.as_ptr()),
            PCWSTR(directory.as_ptr()),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecuteW devuelve un valor <= 32 cuando falla; el código concreto
    // se obtiene de GetLastError para poder explicárselo al usuario.
    if (result.0 as isize) <= 32 {
        let code = unsafe { GetLastError() };
        return Err(match code.0 {
            2 => "Windows no encontró el archivo.".to_string(),
            5 => "Windows denegó el acceso.".to_string(),
            8 => "no hay memoria suficiente para abrirlo.".to_string(),
            29 => "no se pudo instalar el acceso directo.".to_string(),
            _ => format!("error de Windows {}", code.0),
        });
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Menú Inicio                                                         */
/* ------------------------------------------------------------------ */

/** Lista los accesos directos del menú Inicio, con un recorrido acotado. */
pub fn scan_start_menu_apps() -> Vec<AllowedApp> {
    let mut apps: Vec<AllowedApp> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    'dirs: for dir in start_menu_dirs() {
        for path in list_files_depth(&dir, 3) {
            if path.extension().and_then(|e| e.to_str()) != Some("lnk") {
                continue;
            }
            let Some(display_name) = path.file_stem().map(|s| s.to_string_lossy().to_string())
            else {
                continue;
            };
            if display_name.is_empty() || seen.iter().any(|s| s == &display_name) {
                continue;
            }
            seen.push(display_name.clone());
            apps.push(AllowedApp {
                display_name,
                target: path.to_string_lossy().to_string(),
                allowed: false,
                source: "start_menu".to_string(),
            });
            if apps.len() >= 200 {
                break 'dirs;
            }
        }
    }
    apps
}

/// Recorrido propio y acotado: para tres niveles no hace falta `walkdir`.
fn list_files_depth(root: &Path, max_depth: u8) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // `metadata` no sigue enlaces simbólicos, así que un acceso directo
            // que apunte a un directorio no provoca un bucle.
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if depth < max_depth {
                    stack.push((path, depth + 1));
                }
            } else {
                out.push(path);
            }
        }
    }
    out
}

/* ------------------------------------------------------------------ */
/* Batería                                                             */
/* ------------------------------------------------------------------ */

/// Estado de la batería, o `None` si el equipo no la tiene (escritorio).
pub fn battery_report() -> Option<BatteryReport> {
    let mut status = SYSTEM_POWER_STATUS::default();
    // SAFETY: `status` es una estructura del tamaño que exige la API.
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return None;
    }

    let ac_line = status.ACLineStatus;
    let percent = if status.BatteryLifePercent < 255 {
        Some(status.BatteryLifePercent)
    } else {
        None
    };
    if percent.is_none() && ac_line == 255 {
        return None;
    }

    let status_text = match ac_line {
        0 => "descargando",
        1 => "conectada a la red",
        _ => "sin batería",
    };
    // `BatteryLifeTime` está en segundos; 0xFFFFFFFF significa «desconocido».
    let minutes = if status.BatteryLifeTime != u32::MAX {
        Some(status.BatteryLifeTime / 60)
    } else {
        None
    };
    Some(BatteryReport {
        status: status_text.to_string(),
        percent,
        minutes_remaining: minutes,
    })
}
