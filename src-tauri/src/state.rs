//! Estado compartido del backend: perfil, registro de auditoría, métricas de
//! evaluación y operaciones de escritura «armadas» a la espera de confirmación.
//!
//! Persistencia híbrida: lo local (JSONL) es la fuente de verdad inmediata y
//! Mongo Atlas es el espejo en la nube (colecciones `audits`, `metrics`,
//! `profiles`, `conversations`). Si Atlas no responde, todo sigue en local.
//!
//! Archivos en el directorio de datos (`%APPDATA%\com.aster.assistant`):
//!
//! * `profile.json`  — perfil y permisos del usuario.
//! * `audit.jsonl`   — una línea JSON por acción ejecutada.
//! * `metrics.jsonl` — una línea JSON por interacción evaluada.
//! * `db_config.json` — URI y base de datos de Atlas (la URI también puede
//!   venir de la variable de entorno `MONGODB_URI`, que tiene prioridad).
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;

use crate::model::{AuditEntry, DbConfig, FileOpRequest, MetricRecord, PendingOperation, UserProfile};

const PROFILE_FILE: &str = "profile.json";
const AUDIT_FILE: &str = "audit.jsonl";
const METRICS_FILE: &str = "metrics.jsonl";
const DB_CONFIG_FILE: &str = "db_config.json";

/// Operación de escritura preparada: la ficha que ve el usuario más la
/// petición original, que solo se ejecuta si confirma.
#[derive(Debug, Clone)]
pub struct ArmedOperation {
    pub operation: PendingOperation,
    pub request: FileOpRequest,
    pub origin: String,
    pub created_at_ms: i64,
}

/// Estado interno, al que solo llega a través de [`AppState::read`] y
/// [`AppState::write`] para que el acceso quede siempre serializado.
pub struct Inner {
    pub profile: UserProfile,
    pub pending: HashMap<String, ArmedOperation>,
    pub audit: Vec<AuditEntry>,
    pub metrics: Vec<MetricRecord>,
}

/// Estado global de la aplicación, gestionado por Tauri.
pub struct AppState {
    dir: PathBuf,
    inner: Mutex<Inner>,
    mongo: Mutex<Option<mongodb::Client>>,
    mongo_retry: Mutex<Option<std::time::Instant>>,
    db_config: Mutex<DbConfig>,
}

impl AppState {
    /// Crea el estado leyendo lo que haya en disco. Un archivo corrupto no
    /// impide arrancar: se descarta y se empieza de cero.
    pub fn load(dir: PathBuf) -> Self {
        fs::create_dir_all(&dir).ok();

        let profile = read_json::<UserProfile>(&dir.join(PROFILE_FILE)).unwrap_or_default();
        let audit = read_jsonl::<AuditEntry>(&dir.join(AUDIT_FILE));
        let metrics = read_jsonl::<MetricRecord>(&dir.join(METRICS_FILE));
        let stored = read_json::<DbConfig>(&dir.join(DB_CONFIG_FILE)).unwrap_or_default();

        let state = Self {
            dir,
            inner: Mutex::new(Inner {
                profile,
                pending: HashMap::new(),
                audit,
                metrics,
            }),
            mongo: Mutex::new(None),
            mongo_retry: Mutex::new(None),
            db_config: Mutex::new(stored),
        };
        state.prune();
        // Conexión perezosa: no se bloquea el arranque si no hay internet.
        // El primer uso intentará conectar en segundo plano con timeout corto.
        state
    }

    /// Lectura del estado con el mutex tomado.
    pub fn read<T>(&self, f: impl FnOnce(&Inner) -> T) -> Result<T, String> {
        let guard = self.lock()?;
        Ok(f(&guard))
    }

    /// Modificación del estado. El cierre no puede fallar, así que su resultado
    /// solo refleja un mutex envenenado.
    pub fn write<T>(&self, f: impl FnOnce(&mut Inner) -> T) -> Result<T, String> {
        let mut guard = self.lock()?;
        Ok(f(&mut guard))
    }

    /// Modificación del estado donde el propio cierre puede fallar, por ejemplo
    /// al escribir un archivo de datos.
    pub fn try_write<T>(
        &self,
        f: impl FnOnce(&mut Inner) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.lock()?;
        f(&mut guard)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
        self.inner
            .lock()
            .map_err(|_| "El estado interno de ASTER está ocupado.".to_string())
    }

    /* -------------------- Perfil -------------------- */

    pub fn profile(&self) -> Result<UserProfile, String> {
        self.read(|inner| inner.profile.clone())
    }

    pub fn save_profile(&self, profile: &UserProfile) -> Result<(), String> {
        let path = self.dir.join(PROFILE_FILE);
        write_json(&path, profile)
    }

    /* -------------------- Archivos de datos -------------------- */

    pub fn audit_path(&self) -> PathBuf {
        self.dir.join(AUDIT_FILE)
    }

    pub fn metrics_path(&self) -> PathBuf {
        self.dir.join(METRICS_FILE)
    }

    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    /* -------------------- Mongo Atlas (híbrido) -------------------- */

    /// Configuración efectiva (env `MONGODB_URI`/`MONGODB_DB` > archivo).
    pub fn db_config(&self) -> DbConfig {
        let stored = self
            .db_config
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        crate::db::effective_config(&stored)
    }

    pub fn db_config_path(&self) -> PathBuf {
        self.dir.join(DB_CONFIG_FILE)
    }

    /// Guarda la configuración de Atlas (la URI nunca se registra en logs).
    pub fn save_db_config(&self, config: &DbConfig) -> Result<DbConfig, String> {
        let normalized = DbConfig {
            uri: config
                .uri
                .clone()
                .map(|u| u.trim().to_string())
                .filter(|u| !u.is_empty()),
            db_name: if config.db_name.trim().is_empty() {
                "aster".to_string()
            } else {
                config.db_name.trim().to_string()
            },
            enabled: config.enabled,
        };
        write_json(&self.db_config_path(), &normalized)?;
        // Al cambiar la URI se descarta el cliente anterior y el disyuntor,
        // para que el siguiente uso reintente de inmediato.
        if let Ok(mut slot) = self.mongo.lock() {
            *slot = None;
        }
        if let Ok(mut retry) = self.mongo_retry.lock() {
            *retry = None;
        }
        if let Ok(mut guard) = self.db_config.lock() {
            *guard = normalized.clone();
        }
        Ok(crate::db::effective_config(&normalized))
    }

    /// Cliente Mongo ya conectado, sin ningún I/O: nunca bloquea ni falla.
    pub fn cached_client(&self) -> Option<mongodb::Client> {
        self.mongo.lock().ok()?.clone()
    }

    /// Guarda un cliente recién conectado y limpia el disyuntor.
    pub fn cache_client(&self, client: mongodb::Client) {
        if let Ok(mut slot) = self.mongo.lock() {
            *slot = Some(client);
        }
        if let Ok(mut retry) = self.mongo_retry.lock() {
            *retry = None;
        }
    }

    /// ¿Atlas falló hace poco? Evita esperar timeouts de red en cada lectura
    /// cuando ya se sabe que está inalcanzable (disyuntor de 30 s).
    pub fn mongo_cooldown(&self) -> bool {
        match self.mongo_retry.lock() {
            Ok(guard) => guard
                .map(|until| std::time::Instant::now() < until)
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    /// Marca Atlas como inalcanzable durante el disyuntor.
    pub fn note_mongo_failure(&self) {
        if let Ok(mut guard) = self.mongo_retry.lock() {
            *guard = Some(std::time::Instant::now() + crate::db::RETRY_COOLDOWN);
        }
    }

    /* -------------------- Poda por retención -------------------- */

    /// Aplica la retención configurada: descarta entradas de auditoría y
    /// muestras de métricas más antiguas que lo permitido, y recorta el
    /// archivo si supera el tamaño máximo.
    pub fn prune(&self) {
        let _ = self.write(|inner| {
            let retention_days = inner.profile.retention_days.max(1);
            let cutoff_ms =
                chrono::Utc::now().timestamp_millis() - (retention_days as i64 * 86_400_000);
            let before = inner.audit.len();

            inner.audit.retain(|entry| {
                chrono::DateTime::parse_from_rfc3339(&entry.timestamp)
                    .map(|t| t.timestamp_millis() >= cutoff_ms)
                    .unwrap_or(true)
            });
            inner.metrics.retain(|sample| {
                chrono::DateTime::parse_from_rfc3339(&sample.timestamp)
                    .map(|t| t.timestamp_millis() >= cutoff_ms)
                    .unwrap_or(true)
            });

            let removed = before - inner.audit.len();
            if removed > 0 {
                write_jsonl(&self.audit_path(), &inner.audit).ok();
            }
        });
        self.trim_to_budget();
    }

    /// Reduce el archivo de auditoría al presupuesto de disco del perfil.
    fn trim_to_budget(&self) {
        let _ = self.write(|inner| {
            let max_bytes = (inner.profile.max_history_kb.max(16) as u64) * 1024;
            let path = self.audit_path();
            if let Ok(meta) = fs::metadata(&path) {
                if meta.len() <= max_bytes {
                    return;
                }
            }
            // Binary-search del sufijo más reciente que cabe en el presupuesto.
            let total = inner.audit.len();
            let mut low = 0usize;
            let mut high = total;
            while low < high {
                let mid = (low + high + 1) / 2;
                if serialized_len(&inner.audit[total - mid..]) <= max_bytes as usize {
                    low = mid;
                } else {
                    high = mid - 1;
                }
            }
            inner.audit.drain(..total - low);
            write_jsonl(&path, &inner.audit).ok();
        });
    }
}

/* ------------------------------------------------------------------ */
/* Lectura y escritura                                                 */
/* ------------------------------------------------------------------ */

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_jsonl<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear «{}»: {e}", parent.display()))?;
    }
    let serialized =
        serde_json::to_string_pretty(value).map_err(|e| format!("No se pudo serializar: {e}"))?;
    // Se escribe a un temporal y se renombra: un fallo a media escritura no
    // deja el perfil truncado.
    let tmp = path.with_extension("tmp");
    {
        let mut file =
            fs::File::create(&tmp).map_err(|e| format!("No se pudo escribir «{tmp:?}»: {e}"))?;
        file.write_all(serialized.as_bytes())
            .map_err(|e| format!("No se pudo escribir «{tmp:?}»: {e}"))?;
    }
    replace_file(&tmp, path).map_err(|e| format!("No se pudo guardar «{}»: {e}", path.display()))
}

pub fn write_jsonl<T: serde::Serialize>(path: &Path, items: &[T]) -> Result<(), String> {
    let mut buffer = String::new();
    for item in items {
        let line =
            serde_json::to_string(item).map_err(|e| format!("No se pudo serializar: {e}"))?;
        buffer.push_str(&line);
        buffer.push('\n');
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear «{}»: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut file =
            fs::File::create(&tmp).map_err(|e| format!("No se pudo escribir «{tmp:?}»: {e}"))?;
        file.write_all(buffer.as_bytes())
            .map_err(|e| format!("No se pudo escribir «{tmp:?}»: {e}"))?;
    }
    replace_file(&tmp, path).map_err(|e| format!("No se pudo guardar «{}»: {e}", path.display()))
}

/// Sustituye `dest` por `src` de forma atómica.
///
/// `std::fs::rename` no reemplaza un archivo existente en Windows, así que sin
/// esto el segundo guardado fallaría siempre.
fn replace_file(src: &Path, dest: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let (from, to) = wide_pair(src, dest)?;
        // SAFETY: ambas rutas son NUL-terminadas y válidas durante la llamada.
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
    }
    #[cfg(not(windows))]
    {
        fs::rename(src, dest)
    }
}

/// Devuelve ambas rutas como cadenas UTF-16 terminadas en NUL.
#[cfg(windows)]
fn wide_pair(src: &Path, dest: &Path) -> std::io::Result<(Vec<u16>, Vec<u16>)> {
    use std::os::windows::ffi::OsStrExt;

    let encode = |path: &Path| {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        wide
    };
    Ok((encode(src), encode(dest)))
}

/// Añade una sola línea JSON al final del archivo (O(1) por escritura).
/// Los registros de auditoría y métricas usan esto en cada acción: reescribir
/// el archivo completo en cada mensaje degradaba con el historial grande.
pub fn append_jsonl_line<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear «{}»: {e}", parent.display()))?;
    }
    let mut line =
        serde_json::to_string(value).map_err(|e| format!("No se pudo serializar: {e}"))?;
    line.push('\n');
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("No se pudo abrir «{}»: {e}", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("No se pudo escribir «{}»: {e}", path.display()))
}

pub fn serialized_len<T: serde::Serialize>(items: &[T]) -> usize {
    items
        .iter()
        .filter_map(|item| serde_json::to_string(item).ok())
        .map(|line| line.len() + 1)
        .sum()
}

/// Sello de tiempo actual en milisegundos, para caducar operaciones.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
