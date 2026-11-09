//! Política de seguridad: el catálogo cerrado de acciones, los permisos del
//! perfil, las carpetas autorizadas y la lista blanca de aplicaciones.
//!
//! Este módulo es la autoridad. Ningún otro puede abrir una aplicación, leer una
//! ruta ni saltarse un permiso: todos consultan [`State`] y respetan el
//! resultado. El frontend solo pinta el resultado; nunca decide.
use std::path::{Path, PathBuf};

use tauri::State;

use crate::model::{
    AllowedApp, AppLaunchOutcome, CatalogEntry, ProfilePatch, RootEntry, UserProfile,
};
use crate::paths;
use crate::state::{AppState, Inner};
use crate::win;

/// Definición estática del catálogo: nombre interno, etiqueta, si exige
/// confirmación y si modifica el sistema de archivos.
pub const CATALOG: [(&str, &str, bool, bool); 8] = [
    (
        "open_authorized_app",
        "Abrir aplicación autorizada",
        false,
        false,
    ),
    ("web_search", "Búsqueda en Internet", false, false),
    ("system_info", "Información del sistema", false, false),
    ("find_files", "Buscar archivos y carpetas", false, false),
    ("create_folder", "Crear carpeta", true, true),
    ("create_file", "Crear archivo", true, true),
    ("move_files", "Mover archivos y carpetas", true, true),
    ("action_history", "Historial de acciones", false, false),
];

/// Acciones que no pertenecen al catálogo pero que el asistente sí puede
/// ejecutar (conversación, visión, imágenes y automatización multimedia).
/// Aparecen en el historial para poder evaluarlas, pero no se pueden activar
/// ni desactivar.
const EXTRA_LABELS: [(&str, &str); 5] = [
    ("conversation", "Conversación"),
    ("vision", "Visión de la pantalla"),
    ("image", "Generación de imagen"),
    ("automation:youtube", "YouTube"),
    ("automation:spotify", "Spotify"),
];

/// Etiquetas de acciones fuera del catálogo que se registran con prefijo.
const EXTRA_PREFIX_LABELS: [(&str, &str); 3] = [
    ("automation:launch_app", "Abrir aplicación"),
    ("automation:open_url", "Abrir dirección web"),
    ("web_search:open_sources", "Búsqueda con fuentes abiertas"),
];

/// Etiqueta legible de cualquier acción registrada.
pub fn action_label(action: &str) -> String {
    if let Some((_, label, ..)) = CATALOG.iter().find(|(id, ..)| *id == action) {
        return label.to_string();
    }
    if let Some((_, label)) = EXTRA_LABELS.iter().find(|(id, ..)| *id == action) {
        return label.to_string();
    }
    if let Some((_, label)) = EXTRA_PREFIX_LABELS
        .iter()
        .find(|(id, ..)| action.starts_with(id))
    {
        return format!("{label} ({action})");
    }
    action.to_string()
}

/// ¿La acción forma parte del catálogo cerrado?
pub fn is_catalog_action(action: &str) -> bool {
    CATALOG.iter().any(|(id, ..)| *id == action)
}

/* ------------------------------------------------------------------ */
/* Carpetas autorizadas                                                */
/* ------------------------------------------------------------------ */

/// Carpeta conocida del sistema, si el resolvedor la devuelve.
fn known_folder(id: known_folders::KnownFolder) -> Option<PathBuf> {
    known_folders::get_known_folder_path(id)
}

/// Raíces por defecto: las carpetas personales del usuario, resueltas con la
/// API de Windows para respetar la redirección de OneDrive.
pub fn default_roots() -> Vec<(&'static str, PathBuf)> {
    let mut roots = Vec::new();
    let candidates: [(&'static str, known_folders::KnownFolder); 5] = [
        ("Escritorio", known_folders::KnownFolder::Desktop),
        ("Documentos", known_folders::KnownFolder::Documents),
        ("Descargas", known_folders::KnownFolder::Downloads),
        ("Imágenes", known_folders::KnownFolder::Pictures),
        ("Música", known_folders::KnownFolder::Music),
    ];
    for (label, id) in candidates {
        if let Some(path) = known_folder(id) {
            if path.is_dir() {
                roots.push((label, path));
            }
        }
    }
    roots
}

/// Resuelve el ámbito pedido a las carpetas sobre las que se puede buscar.
pub fn roots_for_scope(profile: &UserProfile, scope: Option<&str>) -> Vec<PathBuf> {
    let wanted = scope.unwrap_or("all").to_lowercase();
    let mut roots: Vec<PathBuf> = Vec::new();
    for (label, path) in default_roots() {
        let key = label.to_lowercase();
        let matches = match wanted.as_str() {
            "all" => true,
            "desktop" => key == "escritorio",
            "documents" => key == "documentos",
            "downloads" => key == "descargas",
            "pictures" => key == "imágenes",
            "music" => key == "música",
            _ => true,
        };
        if matches {
            roots.push(path);
        }
    }
    // Las carpetas adicionales del perfil solo entran en la búsqueda global.
    if wanted == "all" {
        roots.extend(paths::sanitize_extra_roots(&profile.extra_roots));
    }
    roots.into_iter().filter(|p| p.is_dir()).collect()
}

/// Todas las carpetas autorizadas (las del sistema más las del perfil).
pub fn all_roots(profile: &UserProfile) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = default_roots().into_iter().map(|(_, p)| p).collect();
    roots.extend(paths::sanitize_extra_roots(&profile.extra_roots));
    roots.into_iter().filter(|p| p.is_dir()).collect()
}

/* ------------------------------------------------------------------ */
/* Comprobación de permisos                                            */
/* ------------------------------------------------------------------ */

/** ¿El perfil permite esta acción del catálogo? */
pub fn ensure_permitted(profile: &UserProfile, action: &str) -> Result<(), String> {
    if !is_catalog_action(action) {
        return Err(format!("«{action}» no pertenece al catálogo de ASTER."));
    }
    // Ausencia de entrada significa «permitido»: solo se guarda lo que el
    // usuario ha desactivado explícitamente.
    if profile.permissions.get(action) == Some(&false) {
        return Err(format!(
            "La acción «{}» está desactivada en tu perfil. Actívala en Ajustes → Perfil.",
            action_label(action)
        ));
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Comandos IPC                                                        */
/* ------------------------------------------------------------------ */

/// Catálogo cerrado con el estado de permiso de cada acción.
#[tauri::command]
pub fn policy_catalog(state: State<'_, AppState>) -> Result<Vec<CatalogEntry>, String> {
    let profile = state.profile()?;
    Ok(CATALOG
        .iter()
        .map(
            |(action, label, requires_confirmation, mutates_filesystem)| CatalogEntry {
                action: action.to_string(),
                label: label.to_string(),
                requires_confirmation: *requires_confirmation,
                mutates_filesystem: *mutates_filesystem,
                enabled: profile.permissions.get(*action) != Some(&false),
            },
        )
        .collect())
}

/// Perfil completo del usuario.
#[tauri::command]
pub fn policy_get(state: State<'_, AppState>) -> Result<UserProfile, String> {
    state.profile()
}

/// Carpetas autorizadas, con su etiqueta y si existen de verdad.
#[tauri::command]
pub fn policy_roots(state: State<'_, AppState>) -> Result<Vec<RootEntry>, String> {
    let profile = state.profile()?;
    let mut entries: Vec<RootEntry> = default_roots()
        .into_iter()
        .map(|(label, path)| RootEntry {
            exists: path.is_dir(),
            path: path.to_string_lossy().to_string(),
            label: label.to_string(),
        })
        .collect();

    for raw in &profile.extra_roots {
        let label = Path::new(raw)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| raw.clone());
        entries.push(RootEntry {
            exists: Path::new(raw).is_dir(),
            path: raw.clone(),
            label,
        });
    }
    Ok(entries)
}

/// Actualiza el perfil. Solo acepta claves del catálogo en `permissions`.
#[tauri::command]
pub fn policy_update(
    state: State<'_, AppState>,
    patch: ProfilePatch,
) -> Result<UserProfile, String> {
    paths::ensure_plain_text(patch.user_name.as_deref().unwrap_or("perfil"), "nombre")?;

    let updated = state.try_write(|inner: &mut Inner| {
        let profile = &mut inner.profile;

        if let Some(name) = patch.user_name {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > 60 {
                return Err("El nombre debe tener entre 1 y 60 caracteres.".to_string());
            }
            profile.user_name = name.to_string();
        }

        if let Some(perms) = patch.permissions {
            for (action, enabled) in perms {
                if !is_catalog_action(&action) {
                    return Err(format!("«{action}» no pertenece al catálogo de ASTER."));
                }
                profile.permissions.insert(action, enabled);
            }
        }

        if let Some(extra) = patch.extra_roots {
            // Se filtran las rutas que no superan las guardas: es preferible
            // ignorar una entrada dudosa a dejar el perfil en un estado inválido.
            profile.extra_roots = paths::sanitize_extra_roots(&extra)
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
        }

        if let Some(days) = patch.retention_days {
            profile.retention_days = days.clamp(1, 365);
        }
        if let Some(kb) = patch.max_history_kb {
            profile.max_history_kb = kb.clamp(16, 1_048_576);
        }
        let snapshot = profile.clone();
        state.save_profile(&snapshot)?;
        Ok(snapshot)
    })?;

    state.prune();
    // Espejo best-effort a Atlas en segundo plano (`profiles/_id="profile"`).
    crate::db::spawn_mirror_profile(&state, updated.clone());
    Ok(updated)
}

/// ¿El perfil permite esta acción? Lo consulta el frontend antes de ofrecer
/// una acción en la interfaz, pero el backend vuelve a comprobarlo al ejecutar.
#[tauri::command]
pub fn policy_is_allowed(state: State<'_, AppState>, action: String) -> Result<bool, String> {
    let profile = state.profile()?;
    Ok(ensure_permitted(&profile, &action).is_ok())
}

/* ------------------------------------------------------------------ */
/* Lista blanca de aplicaciones                                        */
/* ------------------------------------------------------------------ */

/** Devuelve la entrada autorizada que corresponde a ese nombre, si existe. */
pub fn authorized_target_app(profile: &UserProfile, display_name: &str) -> Option<AllowedApp> {
    let needle = display_name.trim().to_lowercase();
    profile
        .allowed_apps
        .iter()
        .find(|app| app.allowed && app.display_name.trim().to_lowercase() == needle)
        .cloned()
}

/** Devuelve el destino configurado de una aplicación autorizada. */
pub fn authorized_target(profile: &UserProfile, display_name: &str) -> Option<String> {
    authorized_target_app(profile, display_name).map(|app| app.target)
}

/// Aplica la lista blanca: lanza solo objetivos ya autorizados, y siempre tras
/// [`paths::ensure_launchable`], que bloquea intérpretes y scripts.
#[tauri::command]
pub fn open_authorized_app(
    state: State<'_, AppState>,
    app_name: String,
) -> Result<AppLaunchOutcome, String> {
    paths::ensure_plain_text(&app_name, "aplicación")?;
    let profile = state.profile()?;
    ensure_permitted(&profile, "open_authorized_app")?;

    let Some(target) = authorized_target(&profile, &app_name) else {
        let authorized: Vec<&str> = profile
            .allowed_apps
            .iter()
            .filter(|a| a.allowed)
            .map(|a| a.display_name.as_str())
            .collect();
        let message = if authorized.is_empty() {
            format!(
                "«{app_name}» no está autorizada. Todavía no has autorizado ninguna aplicación: actívalas en Ajustes → Aplicaciones autorizadas."
            )
        } else {
            format!(
                "«{app_name}» no está autorizada. Puedes abrir: {}. Añádela en Ajustes → Aplicaciones autorizadas.",
                authorized.join(", ")
            )
        };
        return Ok(AppLaunchOutcome {
            status: "denied".to_string(),
            message,
            resolved_target: String::new(),
        });
    };

    match win::launch_authorized(&target) {
        Ok(resolved) => Ok(AppLaunchOutcome {
            status: "success".to_string(),
            message: format!("He abierto {app_name}."),
            resolved_target: resolved,
        }),
        Err(error) => Ok(AppLaunchOutcome {
            status: "error".to_string(),
            message: format!("No se pudo abrir «{app_name}»: {error}"),
            resolved_target: target,
        }),
    }
}

/// Detecta las aplicaciones instaladas para que el usuario pueda autorizarlas.
#[tauri::command]
pub fn apps_scan(state: State<'_, AppState>) -> Result<Vec<AllowedApp>, String> {
    let profile = state.profile()?;
    let mut merged = profile.allowed_apps.clone();

    for detected in win::scan_start_menu_apps() {
        let known = merged.iter().any(|app| {
            app.display_name
                .eq_ignore_ascii_case(&detected.display_name)
        });
        if !known {
            merged.push(detected);
        }
    }

    Ok(merged)
}

/// Marca o desmarca una aplicación de la lista blanca.
#[tauri::command]
pub fn app_set_allowed(
    state: State<'_, AppState>,
    display_name: String,
    target: String,
    allowed: bool,
) -> Result<UserProfile, String> {
    paths::ensure_plain_text(&display_name, "aplicación")?;
    paths::ensure_plain_text(&target, "destino")?;

    // Autorizar un intérprete de comandos convertiría la lista blanca en una
    // puerta trasera, así que se comprueba antes de guardar.
    if allowed && paths::is_shell_reference(&target) {
        return Err(format!(
            "«{display_name}» apunta a un intérprete o a un script. ASTER no autoriza comandos, solo aplicaciones."
        ));
    }

    let updated = state.try_write(|inner: &mut Inner| {
        let profile = &mut inner.profile;
        match profile
            .allowed_apps
            .iter_mut()
            .find(|app| app.display_name.eq_ignore_ascii_case(&display_name))
        {
            Some(app) => {
                app.allowed = allowed;
                // Se actualiza el destino para que una reinstalación no deje
                // la autorización apuntando a un ejecutable que ya no existe.
                app.target = target;
            }
            None => profile.allowed_apps.push(AllowedApp {
                display_name: display_name.trim().to_string(),
                target,
                allowed,
                source: "start_menu".to_string(),
            }),
        }
        let snapshot = profile.clone();
        state.save_profile(&snapshot)?;
        Ok(snapshot)
    })?;
    crate::db::spawn_mirror_profile(&state, updated.clone());
    Ok(updated)
}

/// Aplicaciones actualmente autorizadas.
#[tauri::command]
pub fn apps_allowed(state: State<'_, AppState>) -> Result<Vec<AllowedApp>, String> {
    let profile = state.profile()?;
    Ok(profile
        .allowed_apps
        .into_iter()
        .filter(|app| app.allowed)
        .collect())
}
