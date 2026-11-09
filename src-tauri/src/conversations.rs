//! Colección `conversations`: historial de sesiones de chat en Atlas.
//!
//! El frontend sigue guardando en `localStorage` para lectura instantánea;
//! cada guardado se espeja aquí vía IPC (`conversation_save`) en segundo
//! plano. La lectura (`conversations_list`) es un comando `async`: intenta
//! Atlas primero y el frontend usa su copia local si falla.
use tauri::State;

use crate::model::ConversationSession;
use crate::state::AppState;

/// Registra una sesión para espejarla a Atlas (no espera a la red).
#[tauri::command]
pub fn conversation_save(
    state: State<'_, AppState>,
    session: ConversationSession,
) -> Result<String, String> {
    if session.id.trim().is_empty() {
        return Err("La sesión no tiene identificador.".to_string());
    }
    let id = session.id.clone();
    crate::db::spawn_mirror_conversation(&state, session);
    Ok(id)
}

/// Sesiones más recientes primero. Falla si Atlas no responde: el frontend
/// usa entonces su `localStorage`.
#[tauri::command]
pub async fn conversations_list(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<ConversationSession>, String> {
    let (client, db) = crate::db::ready_client(&state)
        .await
        .ok_or("Atlas no está disponible: se usa el historial local.".to_string())?;
    crate::db::fetch_conversations(&client, &db, limit.unwrap_or(100).clamp(1, 500) as i64).await
}

/// Elimina una sesión concreta (local ya quedó; Atlas en segundo plano).
#[tauri::command]
pub fn conversation_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    crate::db::spawn_remote_delete_conversation(&state, id);
    Ok(())
}

/// Vacía la colección `conversations` en Atlas (en segundo plano).
#[tauri::command]
pub fn conversations_clear(state: State<'_, AppState>) -> Result<(), String> {
    crate::db::spawn_remote_clear(&state, crate::db::COL_CONVERSATIONS);
    Ok(())
}
