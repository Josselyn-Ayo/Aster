//! Automatización multimedia y apertura de direcciones web.
//!
//! Son las acciones que existían antes del catálogo cerrado y siguen siendo
//! útiles, pero ahora pasan por las mismas guardas que el resto: solo se abren
//! esquemas `http`/`https`/`spotify`, el texto se valida contra los
//! metacaracteres de shell y nunca se invoca un intérprete de comandos.
use crate::model::AppLaunchOutcome;
use crate::paths;
use crate::policy;
use crate::state::AppState;
use crate::win;
use tauri::State;

/// Abre YouTube con una búsqueda.
#[tauri::command]
pub fn play_youtube(query: String) -> Result<(), String> {
    let term = paths::clean_text(&query, "búsqueda")?;
    let url = format!(
        "https://www.youtube.com/results?search_query={}",
        paths::percent_encode(&term)
    );
    win::shell_execute(&url, "")
}

/// Busca o reproduce en Spotify.
///
/// Acepta tanto una URI `spotify:…` como una consulta de búsqueda, que se
/// convierte en `spotify:search:<consulta>`.
#[tauri::command]
pub fn play_spotify(uri_or_query: String) -> Result<(), String> {
    let raw = paths::clean_text(&uri_or_query, "consulta")?;
    let uri = if raw.to_lowercase().starts_with("spotify:") {
        raw.clone()
    } else {
        // Spotify no acepta espacios ni caracteres de control en el esquema.
        format!("spotify:search:{}", paths::percent_encode(&raw))
    };
    win::shell_execute(&uri, "")
}

/// Abre una dirección web en el navegador del sistema.
///
/// Solo se admiten `http` y `https`: cualquier otro esquema podría abrir
/// archivos locales, Preferencias del sistema o ejecutar un script.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let safe = paths::ensure_web_url(&url)?;
    win::shell_execute(&safe, "")
}

/// Abre una aplicación, pero solo si el usuario la marcó como autorizada.
///
/// Es la misma puerta que usa `open_authorized_app`: el catálogo cerrado es la
/// única vía que llega a `ShellExecuteW`, así que ni el usuario ni el modelo
/// pueden lanzar nada que no se haya habilitado en Ajustes.
#[tauri::command]
pub fn launch_app(
    app_name: String,
    state: State<'_, AppState>,
) -> Result<AppLaunchOutcome, String> {
    let profile = state.profile()?;
    // La vía automation también respeta el permiso del catálogo: desactivar
    // «Abrir aplicación autorizada» en el perfil bloquea ambas vías.
    policy::ensure_permitted(&profile, "open_authorized_app")?;
    let Some(app) = policy::authorized_target_app(&profile, &app_name) else {
        return Err(format!(
            "«{app_name}» no está en la lista de aplicaciones autorizadas. Habilítala en Ajustes → Aplicaciones autorizadas."
        ));
    };
    win::launch_authorized(&app.target).map(|resolved_target| AppLaunchOutcome {
        status: "success".to_string(),
        message: format!("He abierto {}.", app.display_name),
        resolved_target,
    })
}
