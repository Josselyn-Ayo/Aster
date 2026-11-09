//! ASTER — Asistente Virtual Multimodal de Escritorio.
//!
//! Punto de entrada del backend nativo. Aquí se registra el estado global, se
//! crea la ventana principal y se expone el catálogo cerrado de acciones por
//! IPC.
//!
//! ## Salvaguardas de diseño
//!
//! 1. **Catálogo cerrado**: `invoke_handler` expone exactamente las acciones
//!    descritas en `policy::CATALOG` más la automatización multimedia. No hay
//!    comando genérico «ejecuta esto» ni «lee este archivo».
//! 2. **Sin shell**: no se registra el plugin `shell` de Tauri ni se añade el
//!    permiso correspondiente. Todo se abre con `ShellExecuteW` sobre un
//!    objetivo ya resuelto y validado por `paths`.
//! 3. **Confirmación obrigatória**: las dos acciones que escriben en el disco
//!    pasan por `prepare_file_operation` / `confirm_file_operation`, que
//!    revalida en el momento del clic.
//! 4. **Mínimo privilegio**: cada permiso del perfil se vuelve a comprobar en
//!    el backend, no solo en la interfaz.
mod audit;
mod ai;
mod automation;
mod commands;
mod conversations;
mod db;
mod files;
mod model;
mod paths;
mod policy;
mod screen;
mod state;
mod sysreport;
mod websearch;
mod win;

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use state::AppState;

/// Funciones internas que solo existen para los benchmarks de `cargo bench`.
///
/// Los módulos `files` y `websearch` son privados a propósito (catálogo
/// cerrado); este puente evita abrirlos enteros y deja claro que estas
/// funciones no forman parte de la API de la aplicación.
#[doc(hidden)]
pub mod bench_api {
    pub use crate::files::search_files;
    pub use crate::model::FileHit;
    pub use crate::websearch::{html_to_text, parse_bing, parse_duckduckgo, SearchHit};
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Carga `.env` de la raíz (MONGODB_URI, MONGODB_DB) al entorno del
    // proceso: sin esto el backend no vería las variables del archivo.
    dotenvy::dotenv().ok();
    // Diagnóstico sin secretos: confirma si el `.env` llegó al backend.
    match std::env::var("MONGODB_URI") {
        Ok(v) if !v.trim().is_empty() => eprintln!("[ASTER-mongo] URI configurada (db por entorno o archivo)."),
        _ => eprintln!("[ASTER-mongo] sin URI en el entorno: solo db_config.json o modo local."),
    }
    tauri::Builder::default()
        .setup(|app| {
            // El estado se crea aquí, cuando ya se conoce el directorio de
            // datos de la aplicación.
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("No se pudo resolver el directorio de datos: {e}"))?;
            app.manage(AppState::load(data_dir));

            // La ventana se construye desde Rust, no desde `tauri.conf.json`,
            // para poder registrar el manejador de permisos del WebView2.
            // WebView2 no muestra su propio diálogo de permisos: sin este
            // handler, `getUserMedia()` se rechaza en silencio y la entrada por
            // voz no funciona. Solo se concede el micrófono; todo lo demás
            // (cámara, ubicación, notificaciones) queda denegado.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("ASTER — Asistente Virtual Multimodal")
                .inner_size(1280.0, 820.0)
                .min_inner_size(940.0, 620.0)
                .resizable(true)
                .center()
                // Sin decoración nativa: el frontend dibuja su propia barra de
                // título integrada en el header (controles al hover).
                .decorations(false)
                .on_permission_request(|_webview, kind| match kind {
                    PermissionKind::Microphone => PermissionResponse::Allow,
                    _ => PermissionResponse::Deny,
                })
                .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            /* --- Catálogo cerrado de acciones --- */
            policy::open_authorized_app,
            sysreport::system_report,
            files::find_files,
            files::reveal_in_folder,
            files::prepare_file_operation,
            files::confirm_file_operation,
            files::cancel_file_operation,
            audit::audit_list,
            audit::audit_stats,
            /* --- Política y lista blanca --- */
            policy::policy_catalog,
            policy::policy_get,
            policy::policy_update,
            policy::policy_is_allowed,
            policy::policy_roots,
            policy::apps_scan,
            policy::app_set_allowed,
            policy::apps_allowed,
            /* --- Auditoría y métricas de evaluación --- */
            audit::audit_append,
            audit::audit_export,
            audit::audit_clear,
            audit::metrics_append,
            audit::metrics_rate,
            audit::metrics_summary,
            audit::metrics_clear,
            /* --- Mongo Atlas (híbrido local + nube) --- */
            db::db_status,
            db::db_configure,
            db::db_sync,
            db::db_sync_conversations,
            conversations::conversation_save,
            conversations::conversations_list,
            conversations::conversation_delete,
            conversations::conversations_clear,
            /* --- Automatización multimedia y visión --- */
            automation::play_youtube,
            automation::play_spotify,
            automation::launch_app,
            automation::open_url,
            screen::capture_screen_jpeg,
            screen::screen_count,
            /* --- Búsqueda en Internet sin cuota de modelo --- */
            websearch::web_search,
            /* --- Credenciales de IA (leídas del .env) --- */
            ai::provider_env_key,
            /* --- Utilidades --- */
            commands::get_system_info,
            commands::data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("No se pudo iniciar ASTER");
}
