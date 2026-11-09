//! Modelos de datos del catálogo cerrado de acciones de ASTER.
//!
//! Todos los structs se serializan en `camelCase` porque es el formato que
//! espera el frontend TypeScript (`src/types/aster.ts`). El contrato es
//! bidireccional: lo que entra por IPC se deserializa aquí y lo que sale se
//! serializa con los mismos nombres de campo.
use serde::{Deserialize, Serialize};

/* ------------------------------------------------------------------ */
/* Catálogo y perfil                                                   */
/* ------------------------------------------------------------------ */

/** Entrada del catálogo con el estado de permiso del perfil. */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub action: String,
    pub label: String,
    pub requires_confirmation: bool,
    pub mutates_filesystem: bool,
    pub enabled: bool,
}

/** Aplicación propuesta o autorizada por el usuario. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedApp {
    pub display_name: String,
    pub target: String,
    pub allowed: bool,
    /// `core` si es una propuesta por defecto; si no, describe el origen real.
    pub source: String,
}

/** Carpeta donde el asistente puede buscar y operar. */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootEntry {
    pub path: String,
    pub label: String,
    pub exists: bool,
}

/** Perfil de usuario: una única cuenta local, sin gestión multiusuario. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub user_name: String,
    #[serde(default)]
    pub permissions: std::collections::HashMap<String, bool>,
    #[serde(default)]
    pub allowed_apps: Vec<AllowedApp>,
    #[serde(default)]
    pub extra_roots: Vec<String>,
    pub retention_days: u32,
    pub max_history_kb: u32,
    pub created_at: String,
}

impl Default for UserProfile {
    fn default() -> Self {
        Self {
            user_name: whoami(),
            permissions: std::collections::HashMap::new(),
            allowed_apps: default_allowed_apps(),
            extra_roots: Vec::new(),
            retention_days: 30,
            max_history_kb: 2_048,
            created_at: now_iso(),
        }
    }
}

/// Aplicaciones propuestas por defecto, con su destino.
///
/// Ninguna viene autorizada: el usuario decide cuáles puede abrir el
/// asistente (principio de mínimo privilegio). `source: "core"` las distingue
/// de las que se detectan en el menú Inicio.
pub fn default_allowed_apps() -> Vec<AllowedApp> {
    [
        ("Navegador", "explorer.exe https://"),
        ("Explorador de archivos", "explorer.exe"),
        ("Bloc de notas", "notepad.exe"),
        ("Paint", "mspaint.exe"),
        ("Calculadora", "calc.exe"),
    ]
    .into_iter()
    .map(|(display_name, target)| AllowedApp {
        display_name: display_name.to_string(),
        target: target.to_string(),
        allowed: false,
        source: "core".to_string(),
    })
    .collect()
}

/** Campos del perfil modificables desde Ajustes. */
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePatch {
    pub user_name: Option<String>,
    pub permissions: Option<std::collections::HashMap<String, bool>>,
    pub extra_roots: Option<Vec<String>>,
    pub retention_days: Option<u32>,
    pub max_history_kb: Option<u32>,
}

/** Resultado de abrir una aplicación autorizada. */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppLaunchOutcome {
    /// `success`, `denied` o `error`.
    pub status: String,
    pub message: String,
    pub resolved_target: String,
}

/* ------------------------------------------------------------------ */
/* Archivos                                                            */
/* ------------------------------------------------------------------ */

/** Petición de búsqueda de archivos y carpetas. */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindFilesRequest {
    pub query: String,
    pub scope: Option<String>,
    pub root: Option<String>,
    pub limit: Option<u32>,
    #[serde(default)]
    pub folders_only: bool,
}

/** Resultado de la búsqueda de archivos y carpetas. */
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub is_directory: bool,
    pub size_bytes: u64,
    pub size_label: String,
    pub modified_at: String,
    pub scope: String,
}

/// Operación de escritura pendiente de confirmar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOperation {
    pub id: String,
    pub action: String,
    pub title: String,
    pub summary: String,
    pub details: Vec<String>,
    pub requires_confirmation: bool,
    pub expires_at: String,
}

/// Petición de escritura, todavía sin ejecutar.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileOpRequest {
    CreateFolder {
        path: String,
    },
    CreateFile {
        path: String,
    },
    Move {
        sources: Vec<String>,
        destination: String,
    },
}

impl FileOpRequest {
    /// Acción del catálogo a la que pertenece la operación.
    pub fn action(&self) -> &'static str {
        match self {
            Self::CreateFolder { .. } => "create_folder",
            Self::CreateFile { .. } => "create_file",
            Self::Move { .. } => "move_files",
        }
    }
}

/// Desenlace de una operación de escritura.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpOutcome {
    /// `success`, `error`, `cancelled` o `denied`.
    pub status: String,
    pub message: String,
    pub affected: Vec<String>,
    pub audit_id: String,
}

/* ------------------------------------------------------------------ */
/* Información del sistema                                             */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryReport {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes_remaining: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskReport {
    pub letter: String,
    pub label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_percent: f32,
    pub total_label: String,
    pub free_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessReport {
    pub pid: u32,
    pub name: String,
    pub memory_bytes: u64,
    pub memory_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemReport {
    pub os_name: String,
    pub os_version: String,
    pub build: String,
    pub architecture: String,
    pub hostname: String,
    pub user: String,
    pub cpu: String,
    pub cpu_threads: usize,
    pub memory_total_bytes: u64,
    pub memory_available_bytes: u64,
    pub memory_used_percent: f32,
    pub uptime_seconds: u64,
    pub uptime_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<BatteryReport>,
    pub disks: Vec<DiskReport>,
    pub screens: usize,
    pub processes: Vec<ProcessReport>,
    pub generated_at: String,
}

/* ------------------------------------------------------------------ */
/* Auditoría                                                           */
/* ------------------------------------------------------------------ */

/** Datos que envía el frontend para registrar una acción. */
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditInput {
    pub action: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub confirmed: bool,
    #[serde(default = "default_origin")]
    pub origin: String,
    #[serde(default)]
    pub latency_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
}

fn default_status() -> String {
    "success".to_string()
}

fn default_origin() -> String {
    "ui".to_string()
}

/** Entrada del registro de auditoría. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub timestamp: String,
    pub action: String,
    pub label: String,
    pub status: String,
    pub target: String,
    pub summary: String,
    pub confirmed: bool,
    pub origin: String,
    pub latency_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/** Filtros del historial de acciones. */
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    #[serde(default = "default_limit")]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    pub action: Option<String>,
    pub status: Option<String>,
    pub origin: Option<String>,
}

fn default_limit() -> u32 {
    100
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionTally {
    pub action: String,
    pub label: String,
    pub total: u32,
    pub success: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusTally {
    pub status: String,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditStats {
    pub total: u32,
    pub by_action: Vec<ActionTally>,
    pub by_status: Vec<StatusTally>,
    pub confirmed_operations: u32,
    /// Operaciones que una guarda del backend impidió antes de tocar el disco.
    pub guarded_operations: u32,
    pub audit_file: String,
    pub oldest: Option<String>,
    pub newest: Option<String>,
}

/* ------------------------------------------------------------------ */
/* Métricas de evaluación                                              */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricInput {
    pub action: String,
    pub origin: String,
    pub stt_ms: f64,
    pub interpret_ms: f64,
    pub execute_ms: f64,
    pub tts_ms: f64,
    pub total_ms: f64,
    pub confidence: f64,
    pub success: bool,
    pub confirmation_requested: bool,
    pub confirmation_accepted: bool,
    #[serde(default)]
    pub usability_vote: Option<i8>,
    #[serde(default)]
    pub utterance: String,
    #[serde(default)]
    pub error: Option<String>,
}

/// Muestra persistida de una interacción completa.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricRecord {
    pub id: String,
    pub timestamp: String,
    pub action: String,
    pub label: String,
    pub origin: String,
    pub stt_ms: f64,
    pub interpret_ms: f64,
    pub execute_ms: f64,
    pub tts_ms: f64,
    pub total_ms: f64,
    pub confidence: f64,
    pub success: bool,
    pub confirmation_requested: bool,
    pub confirmation_accepted: bool,
    pub usability_vote: Option<i8>,
    pub utterance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LatencyStats {
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionMetrics {
    pub action: String,
    pub label: String,
    pub count: u32,
    pub success: u32,
    pub success_rate: f32,
    pub mean_latency_ms: f64,
    pub in_catalog: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSummary {
    pub interactions: u32,
    pub task_success_rate: f32,
    pub interpretation_accuracy: f32,
    pub user_rating_rate: Option<f32>,
    pub voted_interactions: u32,
    pub total_latency: LatencyStats,
    pub interpret_latency: LatencyStats,
    pub execute_latency: LatencyStats,
    pub stt_latency: LatencyStats,
    pub tts_latency: LatencyStats,
    pub confirmations_requested: u32,
    pub confirmations_accepted: u32,
    pub usability_index: f32,
    pub per_action: Vec<ActionMetrics>,
    pub metrics_file: String,
}

/* ------------------------------------------------------------------ */
/* Base de datos (Mongo Atlas, modo híbrido)                             */
/* ------------------------------------------------------------------ */

/** Configuración de la conexión a Mongo Atlas. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConfig {
    #[serde(default)]
    pub uri: Option<String>,
    #[serde(default = "default_db_name")]
    pub db_name: String,
    #[serde(default = "default_db_enabled")]
    pub enabled: bool,
}

fn default_db_name() -> String {
    "aster".to_string()
}

fn default_db_enabled() -> bool {
    true
}

impl Default for DbConfig {
    fn default() -> Self {
        // `MONGODB_URI` / `MONGODB_DB` permiten configurar sin tocar la UI
        // (útil en dev con `.env`). Si no hay URI, el modo es local.
        let uri = std::env::var("MONGODB_URI")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let db_name = std::env::var("MONGODB_DB")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(default_db_name);
        Self {
            enabled: uri.is_some(),
            uri,
            db_name,
        }
    }
}

/// Estado de la conexión, para la pantalla de datos.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStatus {
    pub enabled: bool,
    pub configured: bool,
    pub connected: bool,
    pub db_name: String,
    /// Origen de los datos en la última lectura: `mongo`, `local` o `none`.
    pub last_source: String,
    pub detail: String,
    /// De dónde sale la URI: `env` (`.env`), `file` (`db_config.json`) o `none`.
    pub uri_source: String,
    /// Vista sin secretos (`mongodb+srv://***@host/…`) para mostrar en la UI.
    pub uri_preview: String,
}

/** Mensaje de chat persistido en la colección `conversations`. */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub timestamp: String,
}

/** Sesión de conversación persistida en Mongo (`conversations`). */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSession {
    pub id: String,
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub ended_at: String,
    #[serde(default)]
    pub turns: u32,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub messages: Vec<ConversationMessage>,
}

/* ------------------------------------------------------------------ */
/* Utilidades compartidas                                              */
/* ------------------------------------------------------------------ */

/// Marca de tiempo ISO-8601 en UTC, el formato que usa el frontend.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Nombre del usuario del sistema operativo.
pub fn whoami() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "usuario".to_string())
}

/// Nombre legible de un tamaño en bytes.
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// Duración legible a partir de segundos.
pub fn human_duration(seconds: u64) -> String {
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if days > 0 {
        format!("{days} d {hours} h {minutes} min")
    } else if hours > 0 {
        format!("{hours} h {minutes} min")
    } else {
        format!("{minutes} min")
    }
}
