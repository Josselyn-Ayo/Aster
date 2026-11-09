//! Comandos utilitarios que no pertenecen al catálogo de acciones.
use tauri::State;

use crate::audit;
use crate::state::AppState;

/// Metadatos del sistema y del propio registro de acciones.
///
/// Es el comando de diagnóstico que usa la pantalla de evaluación: por un
/// lado el entorno real, por otro cuánto se ha acumulado de datos locales.
#[tauri::command]
pub fn get_system_info(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let profile = state.profile()?;
    Ok(serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "user": profile.user_name,
        "dataDir": state.data_dir().to_string_lossy(),
        "auditFile": state.audit_path().to_string_lossy(),
        "metricsFile": state.metrics_path().to_string_lossy(),
        "storage": audit::storage_summary(&state),
        "screens": crate::screen::screen_count(),
    }))
}

/// Ruta del directorio de datos de la aplicación.
#[tauri::command]
pub fn data_dir(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.data_dir().to_string_lossy().to_string())
}
