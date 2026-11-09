//! Puente de credenciales de IA.
//!
//! Las claves viven en el `.env` de la raíz (ya cargado por `dotenvy` en
//! `run()`), no en el bundle del frontend. Ajustes puede pedirlas para mostrar
//! el estado, y el modelo de IA las resuelve en cada llamada.
//!
//! Se aceptan tanto los nombres «de backend» (`GROQ_API_KEY`) como los que Vite
//! expone en desarrollo (`VITE_GROQ_API_KEY`), en ese orden.

/// Variables que se consultan por proveedor, en orden de prioridad.
const PROVIDER_VARS: &[(&str, &[&str])] = &[
    (
        "gemini",
        &["GEMINI_API_KEY", "GOOGLE_API_KEY", "VITE_GEMINI_API_KEY"],
    ),
    ("groq", &["GROQ_API_KEY", "VITE_GROQ_API_KEY"]),
    ("openrouter", &["OPENROUTER_API_KEY", "VITE_OPENROUTER_API_KEY"]),
    ("mistral", &["MISTRAL_API_KEY", "VITE_MISTRAL_API_KEY"]),
];

/// Devuelve la clave de un proveedor leída del entorno, si existe.
///
/// `Ok(None)` significa «no configurada», no un error. Ollama no necesita clave
/// y siempre devuelve `None`.
#[tauri::command]
pub fn provider_env_key(provider: String) -> Result<Option<String>, String> {
    let Some((_, vars)) = PROVIDER_VARS.iter().find(|(id, _)| *id == provider) else {
        return Ok(None);
    };

    for var in *vars {
        if let Ok(value) = std::env::var(var) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(Some(trimmed.to_string()));
            }
        }
    }
    Ok(None)
}
