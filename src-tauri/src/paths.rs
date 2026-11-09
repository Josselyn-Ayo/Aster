//! Guardas de seguridad: el único punto por el que pasa todo lo que el modelo
//! propone para tocar el sistema.
//!
//! El asistente ejecuta un catálogo cerrado de acciones y nunca shell. Estas
//! funciones concentran los controles que lo hacen así:
//!
//! * **Anti-shell**: se rechazan metacaracteres, prefijos de intérprete de
//!   comandos, extensiones de script y binarios de consola (`cmd`, `powershell`,
//!   `wscript`, `certutil`…). Nada llega a `ShellExecuteW` sin pasar antes por
//!   [`ensure_launchable`].
//! * **Confinamiento en las carpetas autorizadas**: toda ruta se normaliza, se
//!   canonicaliza y se comprueba contra las raíces permitidas, de modo que ni
//!   `..`, ni enlaces simbólicos, ni rutas absolutas inventadas saquen la
//!   operación fuera del directorio autorizado.
//! * **Zonas prohibidas**: aunque una raíz se configurase mal, se rechaza
//!   cualquier ruta bajo `Windows`, `Program Files` o el registro de reciclaje.
use std::path::{Component, Path, PathBuf};

/// Metacaracteres de intérprete de comandos. Aparecen en casi cualquier
/// intento de inyectar una orden («abre chrome y & del C:\…»).
const SHELL_METACHARS: [char; 12] = [
    ';', '&', '|', '<', '>', '^', '`', '$', '!', '\n', '\r', '\u{0}',
];

/// Caracteres que Windows prohíbe dentro de un nombre de archivo. `:` solo se
/// tolera como separador de unidad (`C:\`), y por eso se comprueba aparte.
const ILLEGAL_PATH_CHARS: [char; 7] = ['<', '>', '"', '|', '?', '*', '\u{0}'];

/// Nombres reservados por el dispositivo: no existen como archivo, pero el
/// resolvedor de rutas los traduce y permitiría escribir fuera de la raíz.
const RESERVED_STEMS: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Extensiones que ejecutarían código. Un acceso directo del menú Inicio que
/// apunte a una de ellas se considera un intento de ejecución libre.
const SCRIPT_EXTS: [&str; 14] = [
    "bat", "cmd", "com", "ps1", "psm1", "ps1xml", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta",
    "scr",
];

/// Binarios de consola o de administración: abrirlos equivale a darle un
/// intérprete de comandos al modelo.
const SHELL_BINARIES: [&str; 30] = [
    "cmd",
    "command",
    "powershell",
    "powershell_ise",
    "pwsh",
    "wscript",
    "cscript",
    "mshta",
    "rundll32",
    "regsvr32",
    "reg",
    "regedit",
    "schtasks",
    "sc",
    "certutil",
    "bitsadmin",
    "wmic",
    "net",
    "netsh",
    "msiexec",
    "installutil",
    "forfiles",
    "fsutil",
    "mklink",
    "takeown",
    "icacls",
    "cipher",
    "wsl",
    "bash",
    "conhost",
];

/// Carpetas del sistema que nunca deben ser raíz ni destino, aunque el perfil
/// se configure mal.
const FORBIDDEN_DIRS: [&str; 7] = [
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "$recycle.bin",
    "system volume information",
    "recovery",
];

/* ------------------------------------------------------------------ */
/* Texto libre                                                         */
/* ------------------------------------------------------------------ */

/**
 * Rechaza cualquier texto que pueda inyectar una orden de shell.
 * Se aplica a consultas de búsqueda, nombres de aplicación y rutas.
 */
pub fn ensure_plain_text(input: &str, field: &str) -> Result<(), String> {
    clean_text(input, field).map(|_| ())
}

/** Igual que [`ensure_plain_text`], pero devuelve el texto ya recortado. */
pub fn clean_text(input: &str, field: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(format!("El campo «{field}» está vacío."));
    }
    if trimmed.len() > 4096 {
        return Err(format!("El campo «{field}» es demasiado largo."));
    }
    if let Some(bad) = trimmed.chars().find(|c| SHELL_METACHARS.contains(c)) {
        return Err(format!(
            "El campo «{field}» contiene el carácter prohibido «{bad}»: no se permite construir órdenes de shell."
        ));
    }
    if trimmed.starts_with('-') {
        return Err(format!(
            "El campo «{field}» no puede empezar por «-»: evitaría que el modelo inyecte opciones de línea de comandos."
        ));
    }
    Ok(trimmed.to_string())
}

/** Última palabra relevante de un texto libre, para compararla con el denylist. */
fn candidate_names(input: &str) -> Vec<String> {
    input
        .replace('/', "\\")
        .split(|c: char| c == '\\' || c == ' ' || c == ',' || c == ';' || c == '&' || c == '|')
        .filter(|part| !part.trim().is_empty())
        .map(|part| {
            Path::new(part)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

/// ¿El texto apunta a un intérprete de comandos o a un script? */
pub fn is_shell_reference(input: &str) -> bool {
    let lower = input.to_lowercase();
    candidate_names(&lower).iter().any(|name| {
        SHELL_BINARIES.contains(&name.as_str())
            || SCRIPT_EXTS
                .iter()
                .any(|ext| lower.ends_with(&format!(".{ext}")))
    })
}

/**
 * Última barrera antes de lanzar un proceso: el objetivo no puede ser un
 * intérprete, un script ni un ejecutable de consola.
 */
pub fn ensure_launchable(target: &Path) -> Result<(), String> {
    if is_shell_reference(&target.to_string_lossy()) {
        return Err(format!(
            "«{}» es un intérprete o un script: ASTER no ejecuta comandos, solo aplicaciones autorizadas.",
            target.display()
        ));
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */

/** Normalización léxica y validación de sintaxis de una ruta. */
pub fn normalize_path(input: &str, field: &str) -> Result<PathBuf, String> {
    ensure_plain_text(input, field)?;

    if let Some(bad) = input.chars().find(|c| ILLEGAL_PATH_CHARS.contains(c)) {
        return Err(format!(
            "La ruta «{input}» contiene el carácter prohibido «{bad}»."
        ));
    }
    if input.starts_with("\\\\?\\") || input.starts_with("//?/") {
        return Err("No se aceptan rutas con prefijo de dispositivo (\\\\?\\).".to_string());
    }

    let candidate = PathBuf::from(input);
    if !candidate.is_absolute() {
        return Err(format!(
            "La ruta «{input}» debe ser absoluta y estar dentro de una carpeta autorizada."
        ));
    }

    // Se recorren los componentes para impedir `..` y el prefijo `\\` (UNC),
    // que permitirían saltar a otro recurso de la red.
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Prefix(prefix) => {
                if prefix.as_os_str().is_empty() {
                    return Err("Ruta sin unidad.".to_string());
                }
                normalized.push(prefix.as_os_str());
            }
            Component::RootDir => normalized.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!(
                    "La ruta «{input}» sube de nivel («..»): solo se puede trabajar dentro de las carpetas autorizadas."
                ));
            }
            Component::Normal(part) => {
                let name = part.to_string_lossy();
                if name.ends_with(' ') || name.ends_with('.') {
                    return Err(format!(
                        "El nombre «{name}» termina en espacio o punto: Windows lo recortaría y la ruta real sería otra."
                    ));
                }
                let stem = name.split('.').next().unwrap_or_default().to_lowercase();
                if RESERVED_STEMS.contains(&stem.as_str()) {
                    return Err(format!(
                        "«{name}» es un nombre reservado de Windows y no puede usarse como carpeta."
                    ));
                }
                normalized.push(part);
            }
        }
    }

    if is_forbidden_system_path(&normalized) {
        return Err(format!(
            "«{input}» apunta a una zona protegida del sistema (Windows, Program Files o el registro de reciclaje)."
        ));
    }
    Ok(normalized)
}

/// ¿La ruta cae en una carpeta protegida del sistema operativo? */
pub fn is_forbidden_system_path(path: &Path) -> bool {
    path.components().any(|c| {
        let name = c.as_os_str().to_string_lossy().to_lowercase();
        FORBIDDEN_DIRS.contains(&name.as_str())
    })
}

/** Canonicaliza las raíces que existen; ignora las que no. */
pub fn canonical_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .collect()
}

/**
 * Quita el prefijo verbatim de Windows (`\\?\`) que `std::fs::canonicalize`
 * añade en Windows.
 *
 * Las rutas que se muestran al usuario o que vuelven al frontend deben tener la
 * forma normal (`C:\Users\…`), no `\\?\C:\Users\…`: el prefijo rompe las
 * comparaciones con rutas sin canonicalizar y `resolve_in_roots` lo rechaza.
 */
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        // Los recursos de red vuelven a su forma `\\servidor\recurso`.
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/** Las rutas canónicas están dentro de al menos una de las raíces permitidas. */
fn inside_roots(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/**
 * Resuelve una ruta del modelo dentro de las carpetas autorizadas.
 *
 * `allow_missing_leaf` permite que la última parte todavía no exista (es el
 * caso de `create_folder`). La comprobación se hace sobre la ruta canónica
 * cuando existe y sobre la padre canónica cuando no, de modo que un enlace
 * simbólico no pueda sacar la operación de la raíz.
 */
pub fn resolve_in_roots(
    input: &str,
    roots: &[PathBuf],
    allow_missing_leaf: bool,
) -> Result<PathBuf, String> {
    let normalized = normalize_path(input, "ruta")?;
    if roots.is_empty() {
        return Err("No hay ninguna carpeta autorizada configurada.".to_string());
    }

    let existing = std::fs::canonicalize(&normalized);
    let (probe, resolved) = match (&existing, allow_missing_leaf) {
        (Ok(path), _) => (path.clone(), path.clone()),
        (Err(_), true) => match normalized.parent() {
            Some(parent) => {
                let canonical_parent = std::fs::canonicalize(parent).map_err(|_| {
                    format!(
                        "La carpeta «{}» no existe o no es accesible.",
                        parent.display()
                    )
                })?;
                (canonical_parent.clone(), normalized.clone())
            }
            None => return Err("La ruta no tiene una carpeta padre válida.".to_string()),
        },
        (Err(_), false) => {
            return Err(format!("La ruta «{input}» no existe."));
        }
    };

    if !inside_roots(&probe, roots) {
        return Err(format!(
            "«{input}» está fuera de las carpetas autorizadas. Solo se puede trabajar en: {}.",
            roots
                .iter()
                .map(|r| r.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if is_forbidden_system_path(&resolved) {
        return Err(format!(
            "«{input}» apunta a una zona protegida del sistema operativo."
        ));
    }
    Ok(resolved)
}

    /** Normaliza las raíces adicionales del perfil, descartando las inválidas. */
    pub fn sanitize_extra_roots(extra: &[String]) -> Vec<PathBuf> {
        extra
            .iter()
            .filter_map(|raw| normalize_path(raw, "carpeta autorizada").ok())
            .collect()
    }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_references_are_detected() {
        assert!(is_shell_reference("cmd"));
        assert!(is_shell_reference("C:\\Windows\\System32\\cmd.exe"));
        assert!(is_shell_reference("script.bat"));
        assert!(!is_shell_reference("notepad.exe"));
        assert!(!is_shell_reference("C:\\Apps\\Google Chrome.lnk"));
    }

    #[test]
    fn plain_text_rejects_injection() {
        assert!(ensure_plain_text("hola mundo", "campo").is_ok());
        assert!(ensure_plain_text("a & del C:\\", "campo").is_err());
        assert!(ensure_plain_text("-rf", "campo").is_err());
        assert!(ensure_plain_text("   ", "campo").is_err());
    }

    #[test]
    fn normalize_rejects_escapes() {
        assert!(normalize_path("relativa\\x", "ruta").is_err());
        assert!(normalize_path("C:\\Docs\\..\\x", "ruta").is_err());
        assert!(normalize_path("C:\\Windows\\x", "ruta").is_err());
    }

    #[test]
    fn web_url_only_allows_http() {
        assert!(ensure_web_url("https://example.com").is_ok());
        assert!(ensure_web_url("file:///C:/x").is_err());
        assert!(ensure_web_url("https://a b.com").is_err());
    }

    #[test]
    fn strip_verbatim_removes_windows_prefix() {
        // Ruta canonicalizada típica de Windows.
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\C:\Users\me\Downloads")),
            PathBuf::from(r"C:\Users\me\Downloads")
        );
        // Recursos de red.
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\server\share\file.txt")),
            PathBuf::from(r"\\server\share\file.txt")
        );
        // Una ruta normal se deja intacta.
        assert_eq!(
            strip_verbatim(Path::new(r"C:\Users\me\Downloads")),
            PathBuf::from(r"C:\Users\me\Downloads")
        );
    }
}

/* ------------------------------------------------------------------ */
/* Esquemas de URI                                                     */
/* ------------------------------------------------------------------ */

/// Solo se permiten `http` y `https`. Así el modelo no puede abrir `file:`,
/// `javascript:` ni esquemas internos del sistema como `ms-settings:`.
pub fn ensure_web_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    ensure_plain_text(trimmed, "URL")?;
    let lower = trimmed.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!(
            "Solo se permiten direcciones http:// o https://. «{trimmed}» usa otro esquema."
        ));
    }
    // Credenciales embebidas o espacios son el patrón clásico de inyección de
    // URL en un campo de texto libre; se rechazan.
    if trimmed.contains('@') || trimmed.contains(char::is_whitespace) {
        return Err("La URL no es válida.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Porcentaje de URL codificado para consultas de búsqueda.
pub fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
