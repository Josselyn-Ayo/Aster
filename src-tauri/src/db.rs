//! Capa de persistencia híbrida: local (JSONL) + Mongo Atlas.
//!
//! Diseño:
//!
//! * Lo local **siempre** se escribe primero: si Atlas no responde (sin
//!   internet, IP no autorizada, cluster pausado) la app sigue funcionando.
//! * Cada escritura lanza además un espejo best-effort a Mongo con timeout
//!   corto (5 s) en una tarea en segundo plano. Un fallo de red nunca rompe
//!   ni retrasa la operación del usuario.
//! * Cada lectura intenta Mongo primero (comando `async`) y cae a local si no
//!   hay conexión. Un disyuntor de 30 s evita esperar timeouts repetidos.
//!
//! Regla de hilos (importante): los comandos IPC de Tauri se ejecutan dentro
//! de su runtime Tokio, así que aquí **nunca** se crea un `Runtime` propio ni
//! se llama a `block_on`: eso provoca el panic «there is no reactor running»
//! y tumba la app. Todo el I/O de red es `async` y los espejos usan
//! `tauri::async_runtime::spawn`.
//!
//! Colecciones (base `db_name`, por defecto `aster`):
//!
//! * `profiles` — un único documento `_id = "profile"` con el `UserProfile`.
//! * `audits` — `_id = <audit id>`, resto de campos igual que `AuditEntry`.
//! * `metrics` — `_id = <metric id>`, resto igual que `MetricRecord`.
//! * `conversations` — `_id = <session id>`, igual que `ConversationSession`.
//!
//! Configuración (orden de prioridad):
//!
//! 1. Variables de entorno `MONGODB_URI` / `MONGODB_DB` (dev con `.env`).
//! 2. Archivo `db_config.json` en el directorio de datos (Ajustes → Datos).
//! 3. Sin URI → modo exclusivamente local.
use std::time::Duration;

use futures_util::TryStreamExt;
use mongodb::bson::{doc, to_document, Document};
use mongodb::options::{ClientOptions, ResolverConfig};
use serde::{de::DeserializeOwned, Serialize};

use crate::model::{AuditEntry, ConversationSession, DbConfig, DbStatus, MetricRecord, UserProfile};
use crate::state::AppState;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const OP_TIMEOUT: Duration = Duration::from_secs(5);
/// Tope por intento de resolución DNS del SRV (por proveedor).
const SRV_TIMEOUT: Duration = Duration::from_secs(10);
/// Tras un fallo de red no se reintenta hasta pasado este tiempo.
pub const RETRY_COOLDOWN: Duration = Duration::from_secs(30);

pub const COL_AUDITS: &str = "audits";
pub const COL_METRICS: &str = "metrics";
pub const COL_PROFILES: &str = "profiles";
pub const COL_CONVERSATIONS: &str = "conversations";
pub const PROFILE_DOC_ID: &str = "profile";

/// URI efectiva: variable de entorno manda sobre el archivo.
pub fn effective_config(stored: &DbConfig) -> DbConfig {
    let mut out = stored.clone();
    let mut has_env_uri = false;
    if let Ok(value) = std::env::var("MONGODB_URI") {
        if !value.trim().is_empty() {
            out.uri = Some(value);
            has_env_uri = true;
        }
    }
    if let Ok(env_db) = std::env::var("MONGODB_DB") {
        if !env_db.trim().is_empty() {
            out.db_name = env_db;
        }
    }
    if out.db_name.trim().is_empty() {
        out.db_name = "aster".to_string();
    }
    // Una URI en el entorno es configuración deliberada (dev con `.env`):
    // reactiva Atlas aunque el archivo tenga `enabled = false` de haber
    // pulsado «Solo local» antes.
    if has_env_uri {
        out.enabled = true;
    }
    out
}

/// URI sin la contraseña, para mostrarla en la UI sin filtrar secretos.
#[allow(dead_code)]
pub fn redacted_uri(uri: &str) -> String {
    match uri.find('@') {
        Some(at) => {
            let scheme_end = uri.find("://").map(|i| i + 3).unwrap_or(0);
            let prefix = &uri[..scheme_end];
            let host = &uri[at + 1..];
            format!("{prefix}***@{host}")
        }
        None => "mongodb://***".to_string(),
    }
}

/// Resuelve la URI a `ClientOptions`.
///
/// Con `mongodb+srv://` el driver usa `trust-dns-resolver` y, por defecto, la
/// configuración DNS del sistema (`tokio_from_system_conf`). En algunas redes
/// de Windows esa configuración tiene servidores que no responden y la
/// resolución **se cuelga** (síntoma: «resolviendo SRV…» eterno). Para
/// evitarlo, en URIs `+srv` se resuelve primero con servidores DNS públicos
/// explícitos (Google y luego Cloudflare) y solo como último recurso se cae al
/// resolver del sistema.
async fn parse_options(uri: &str) -> Result<ClientOptions, String> {
    let is_srv = uri
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("mongodb+srv://");
    if !is_srv {
        return ClientOptions::parse(uri)
            .await
            .map_err(|e| format!("URI de Mongo no válida: {e}"));
    }

    let mut last_error = String::new();
    for (name, cfg) in [
        ("Google 8.8.8.8", ResolverConfig::google()),
        ("Cloudflare 1.1.1.1", ResolverConfig::cloudflare()),
    ] {
        match tokio::time::timeout(
            SRV_TIMEOUT,
            ClientOptions::parse_with_resolver_config(uri, cfg),
        )
        .await
        {
            Ok(Ok(opts)) => {
                eprintln!(
                    "[ASTER-mongo] SRV resuelto con DNS {name}: {} seed(s).",
                    opts.hosts.len()
                );
                return Ok(opts);
            }
            Ok(Err(e)) => {
                eprintln!("[ASTER-mongo] SRV con DNS {name} falló: {e}");
                last_error = e.to_string();
            }
            Err(_) => {
                eprintln!("[ASTER-mongo] SRV con DNS {name} agotó {SRV_TIMEOUT:?}.");
                last_error = format!("{name}: tiempo de espera");
            }
        }
    }

    // Último recurso: resolver del sistema (por si la red bloquea DNS públicos).
    match tokio::time::timeout(SRV_TIMEOUT, ClientOptions::parse(uri)).await {
        Ok(Ok(opts)) => {
            eprintln!(
                "[ASTER-mongo] SRV resuelto con DNS del sistema: {} seed(s).",
                opts.hosts.len()
            );
            Ok(opts)
        }
        Ok(Err(e)) => Err(format!(
            "No se pudo resolver el SRV de Atlas (DNS públicos: {last_error}; sistema: {e}). \
             Revisa la URI o prueba con otro DNS."
        )),
        Err(_) => Err(format!(
            "No se pudo resolver el SRV de Atlas (DNS públicos: {last_error}; \
             sistema: tiempo de espera). Revisa la URI o prueba con otro DNS."
        )),
    }
}

async fn connect_async(uri: &str) -> Result<mongodb::Client, String> {
    eprintln!("[ASTER-mongo] resolviendo SRV...");
    let mut opts = parse_options(uri).await?;
    opts.server_selection_timeout = Some(CONNECT_TIMEOUT);
    opts.connect_timeout = Some(CONNECT_TIMEOUT);
    opts.app_name = Some("ASTER-Desktop".to_string());
    mongodb::Client::with_options(opts).map_err(|e| format!("No se pudo crear el cliente: {e}"))
}

async fn ping_async(client: &mongodb::Client, db_name: &str) -> Result<(), String> {
    tokio::time::timeout(OP_TIMEOUT, client.database(db_name).run_command(doc! { "ping": 1 }, None))
        .await
        .map_err(|_| "Ping a Atlas agotó el tiempo de espera.".to_string())?
        .map(|_| ())
        .map_err(|e| format!("Ping a Atlas falló: {e}"))
}

/// Cliente listo para operar: cacheado si ya conectó, o conexión nueva con
/// ping de verificación. `None` si Atlas está desactivado, sin URI, en
/// periodo de disyuntor o inalcanzable (el llamador usa local entonces).
pub async fn ready_client(state: &AppState) -> Option<(mongodb::Client, String)> {
    let config = state.db_config();
    if !config.enabled {
        return None;
    }
    if config.uri.as_deref().map(|u| u.trim().is_empty()).unwrap_or(true) {
        return None;
    }
    let db = config.db_name.clone();
    if let Some(client) = state.cached_client() {
        return Some((client, db));
    }
    if state.mongo_cooldown() {
        return None;
    }
    let uri = config.uri.clone().unwrap_or_default();
    let client =
        match tokio::time::timeout(CONNECT_TIMEOUT, connect_async(&uri)).await {
            Ok(Ok(client)) => client,
            Ok(Err(e)) => {
                // Sin secretos: el error del driver no incluye la contraseña.
                eprintln!("[ASTER-mongo] conexión falló: {e}");
                state.note_mongo_failure();
                return None;
            }
            Err(_) => {
                eprintln!(
                    "[ASTER-mongo] conexión agotó el tiempo de espera ({} s).",
                    CONNECT_TIMEOUT.as_secs()
                );
                state.note_mongo_failure();
                return None;
            }
        };
    if let Err(e) = ping_async(&client, &db).await {
        eprintln!("[ASTER-mongo] ping falló: {e}");
        state.note_mongo_failure();
        return None;
    }
    state.cache_client(client.clone());
    Some((client, db))
}

/* ------------------------------------------------------------------ */
/* Documentos                                                          */
/* ------------------------------------------------------------------ */

/// Serializa un valor y fija `_id` para que la sincronización sea idempotente.
pub fn doc_with_id<T: Serialize>(value: &T, id: &str) -> Result<Document, String> {
    let mut doc = to_document(value).map_err(|e| format!("No se pudo serializar: {e}"))?;
    doc.insert("_id", id);
    Ok(doc)
}

async fn insert_doc(
    client: &mongodb::Client,
    db: &str,
    col: &str,
    doc: Document,
) -> Result<(), String> {
    tokio::time::timeout(
        OP_TIMEOUT,
        client.database(db).collection::<Document>(col).insert_one(doc, None),
    )
    .await
    .map_err(|_| format!("Insert en «{col}» agotó el tiempo de espera."))?
    .map(|_| ())
    .map_err(|e| format!("Insert en «{col}» falló: {e}"))
}

async fn upsert_doc(
    client: &mongodb::Client,
    db: &str,
    col: &str,
    id: &str,
    doc: Document,
) -> Result<(), String> {
    tokio::time::timeout(
        OP_TIMEOUT,
        client.database(db).collection::<Document>(col).replace_one(
            doc! { "_id": id },
            doc,
            mongodb::options::ReplaceOptions::builder().upsert(true).build(),
        ),
    )
    .await
    .map_err(|_| format!("Upsert en «{col}» agotó el tiempo de espera."))?
    .map(|_| ())
    .map_err(|e| format!("Upsert en «{col}» falló: {e}"))
}

/// Inserción masiva desordenada: rápida y tolerante a duplicados (`_id`
/// repetido = ya sincronizado). Devuelve cuántos se insertaron de verdad.
async fn bulk_insert(
    client: &mongodb::Client,
    db: &str,
    col: &str,
    docs: Vec<Document>,
) -> usize {
    if docs.is_empty() {
        return 0;
    }
    let opts = mongodb::options::InsertManyOptions::builder().ordered(false).build();
    match tokio::time::timeout(
        Duration::from_secs(30),
        client.database(db).collection::<Document>(col).insert_many(docs, opts),
    )
    .await
    {
        Ok(Ok(res)) => res.inserted_ids.len(),
        _ => 0,
    }
}

async fn find_docs<T>(
    client: &mongodb::Client,
    db: &str,
    col: &str,
    filter: Document,
    sort: Document,
    limit: i64,
    skip: u64,
) -> Result<Vec<T>, String>
where
    T: DeserializeOwned + Send + Sync,
{
    let collection = client.database(db).collection::<Document>(col);
    let find = collection.find(
        filter,
        mongodb::options::FindOptions::builder()
            .sort(sort)
            .limit(limit)
            .skip(skip)
            .build(),
    );
    let cursor = tokio::time::timeout(OP_TIMEOUT, find)
        .await
        .map_err(|_| format!("Consulta a «{col}» agotó el tiempo de espera."))?
        .map_err(|e| format!("Consulta a «{col}» falló: {e}"))?;
    let docs: Vec<Document> = cursor
        .try_collect()
        .await
        .map_err(|e| format!("Lectura de «{col}» falló: {e}"))?;
    let mut out = Vec::with_capacity(docs.len());
    for d in docs {
        if let Ok(v) = mongodb::bson::from_document::<T>(d) {
            out.push(v);
        }
    }
    Ok(out)
}

/* ------------------------------------------------------------------ */
/* Lecturas (comandos `async`: caen a local si Atlas no responde)      */
/* ------------------------------------------------------------------ */

pub async fn fetch_audits(
    client: &mongodb::Client,
    db: &str,
    action: Option<&str>,
    status: Option<&str>,
    origin: Option<&str>,
    limit: i64,
    skip: u64,
) -> Result<Vec<AuditEntry>, String> {
    let mut filter = Document::new();
    if let Some(a) = action.filter(|s| !s.trim().is_empty()) {
        filter.insert("action", a);
    }
    if let Some(s) = status.filter(|s| !s.trim().is_empty()) {
        filter.insert("status", s);
    }
    if let Some(o) = origin.filter(|s| !s.trim().is_empty()) {
        filter.insert("origin", o);
    }
    find_docs::<AuditEntry>(client, db, COL_AUDITS, filter, doc! { "timestamp": -1 }, limit, skip)
        .await
}

pub async fn fetch_all_audits(
    client: &mongodb::Client,
    db: &str,
) -> Result<Vec<AuditEntry>, String> {
    fetch_audits(client, db, None, None, None, 20_000, 0).await
}

pub async fn fetch_all_metrics(
    client: &mongodb::Client,
    db: &str,
) -> Result<Vec<MetricRecord>, String> {
    find_docs::<MetricRecord>(
        client,
        db,
        COL_METRICS,
        Document::new(),
        doc! { "timestamp": -1 },
        20_000,
        0,
    )
    .await
}

pub async fn fetch_conversations(
    client: &mongodb::Client,
    db: &str,
    limit: i64,
) -> Result<Vec<ConversationSession>, String> {
    find_docs::<ConversationSession>(
        client,
        db,
        COL_CONVERSATIONS,
        Document::new(),
        doc! { "endedAt": -1, "ended_at": -1 },
        limit,
        0,
    )
    .await
}

async fn delete_conversation(
    client: &mongodb::Client,
    db: &str,
    id: &str,
) -> Result<(), String> {
    tokio::time::timeout(
        OP_TIMEOUT,
        client.database(db).collection::<Document>(COL_CONVERSATIONS).delete_one(doc! { "_id": id }, None),
    )
    .await
    .map_err(|_| "Eliminar la conversación agotó el tiempo de espera.".to_string())?
    .map(|_| ())
    .map_err(|e| format!("No se pudo eliminar la conversación: {e}"))
}

async fn clear_collection(client: &mongodb::Client, db: &str, col: &str) -> Result<(), String> {
    tokio::time::timeout(
        OP_TIMEOUT,
        client.database(db).collection::<Document>(col).delete_many(doc! {}, None),
    )
    .await
    .map_err(|_| format!("Vaciar «{col}» agotó el tiempo de espera."))?
    .map(|_| ())
    .map_err(|e| format!("No se pudo vaciar «{col}»: {e}"))
}

async fn update_metric_vote(client: &mongodb::Client, db: &str, id: &str, vote: i8) -> bool {
    let col = client.database(db).collection::<Document>(COL_METRICS);
    let first = tokio::time::timeout(
        OP_TIMEOUT,
        col.update_one(
            doc! { "_id": id, "usabilityVote": { "$exists": false } },
            doc! { "$set": { "usabilityVote": i32::from(vote) } },
            None,
        ),
    )
    .await;
    let (matched, modified) = match first {
        Ok(Ok(res)) => (res.matched_count, res.modified_count),
        _ => return false,
    };
    if modified > 0 {
        return true;
    }
    if matched > 0 {
        return true;
    }
    // El campo puede existir como null (documentos antiguos).
    match tokio::time::timeout(
        OP_TIMEOUT,
        col.update_one(
            doc! { "_id": id, "usabilityVote": null },
            doc! { "$set": { "usabilityVote": i32::from(vote) } },
            None,
        ),
    )
    .await
    {
        Ok(Ok(res)) => res.modified_count > 0 || res.matched_count > 0,
        _ => false,
    }
}

/* ------------------------------------------------------------------ */
/* Espejos best-effort (tareas en segundo plano, nunca bloquean)       */
/* ------------------------------------------------------------------ */

/// Puerta de salida a segundo plano: solo si Atlas está activado,
/// configurado y fuera del disyuntor. Devuelve config + cliente cacheado.
fn bg_gate(state: &AppState) -> Option<(DbConfig, Option<mongodb::Client>)> {
    let cfg = state.db_config();
    if !cfg.enabled {
        return None;
    }
    if cfg.uri.as_deref().map(|u| u.trim().is_empty()).unwrap_or(true) {
        return None;
    }
    if state.mongo_cooldown() {
        return None;
    }
    Some((cfg, state.cached_client()))
}

/// Conecta dentro de la tarea en segundo plano (con timeout). No toca la
/// caché: los espejos son efímeros y no deben retrasar nada.
async fn bg_client(
    cfg: DbConfig,
    cached: Option<mongodb::Client>,
) -> Option<(mongodb::Client, String)> {
    let uri = cfg.uri.clone().filter(|u| !u.trim().is_empty())?;
    let db = cfg.db_name.clone();
    if let Some(client) = cached {
        return Some((client, db));
    }
    let client = match tokio::time::timeout(CONNECT_TIMEOUT, connect_async(&uri)).await {
        Ok(Ok(client)) => client,
        Ok(Err(e)) => {
            eprintln!("[ASTER-mongo] espejo: conexión falló: {e}");
            return None;
        }
        Err(_) => {
            eprintln!("[ASTER-mongo] espejo: tiempo de espera agotado.");
            return None;
        }
    };
    if let Err(e) = ping_async(&client, &db).await {
        eprintln!("[ASTER-mongo] espejo: ping falló: {e}");
        return None;
    }
    Some((client, db))
}

/// Auditoría: inserta y si el `_id` ya existe es que ya estaba sincronizada.
pub fn spawn_mirror_audit(state: &AppState, entry: AuditEntry) {
    let Some((cfg, cached)) = bg_gate(state) else { return };
    tauri::async_runtime::spawn(async move {
        let Some((client, db)) = bg_client(cfg, cached).await else { return };
        if let Ok(doc) = doc_with_id(&entry, &entry.id) {
            let _ = insert_doc(&client, &db, COL_AUDITS, doc).await;
        }
    });
}

pub fn spawn_mirror_metric(state: &AppState, record: MetricRecord) {
    let id = record.id.clone();
    let Some((cfg, cached)) = bg_gate(state) else { return };
    tauri::async_runtime::spawn(async move {
        let Some((client, db)) = bg_client(cfg, cached).await else { return };
        if let Ok(doc) = doc_with_id(&record, &id) {
            let _ = insert_doc(&client, &db, COL_METRICS, doc).await;
        }
    });
}

pub fn spawn_mirror_profile(state: &AppState, profile: UserProfile) {
    let Some((cfg, cached)) = bg_gate(state) else { return };
    tauri::async_runtime::spawn(async move {
        let Some((client, db)) = bg_client(cfg, cached).await else { return };
        if let Ok(mut doc) = to_document(&profile) {
            doc.insert("_id", PROFILE_DOC_ID);
            let _ = upsert_doc(&client, &db, COL_PROFILES, PROFILE_DOC_ID, doc).await;
        }
    });
}

pub fn spawn_mirror_conversation(state: &AppState, session: ConversationSession) {
    let Some((cfg, cached)) = bg_gate(state) else { return };
    tauri::async_runtime::spawn(async move {
        let Some((client, db)) = bg_client(cfg, cached).await else { return };
        if let Ok(doc) = doc_with_id(&session, &session.id) {
            let _ = upsert_doc(&client, &db, COL_CONVERSATIONS, &session.id, doc).await;
        }
    });
}

pub fn spawn_remote_clear(state: &AppState, col: &'static str) {
    let Some((cfg, cached)) = bg_gate(state) else { return };
    tauri::async_runtime::spawn(async move {
        let Some((client, db)) = bg_client(cfg, cached).await else { return };
        let _ = clear_collection(&client, &db, col).await;
    });
}

pub fn spawn_remote_delete_conversation(state: &AppState, id: String) {
    let Some((cfg, cached)) = bg_gate(state) else { return };
    tauri::async_runtime::spawn(async move {
        let Some((client, db)) = bg_client(cfg, cached).await else { return };
        let _ = delete_conversation(&client, &db, &id).await;
    });
}

pub fn spawn_remote_vote(state: &AppState, id: String, vote: i8) {
    let Some((cfg, cached)) = bg_gate(state) else { return };
    tauri::async_runtime::spawn(async move {
        let Some((client, db)) = bg_client(cfg, cached).await else { return };
        update_metric_vote(&client, &db, &id, vote).await;
    });
}

/* ------------------------------------------------------------------ */
/* Comandos IPC                                                        */
/* ------------------------------------------------------------------ */

/// Estado de la conexión (sin exponer la URI completa).
#[tauri::command]
pub async fn db_status(state: tauri::State<'_, AppState>) -> Result<DbStatus, String> {
    let config = state.db_config();
    let configured = config
        .uri
        .as_deref()
        .map(|u| !u.trim().is_empty())
        .unwrap_or(false);
    // Origen y vista previa sin secretos, para que la UI muestre qué hay activo.
    let from_env = std::env::var("MONGODB_URI")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let uri_source = if from_env {
        "env".to_string()
    } else if configured {
        "file".to_string()
    } else {
        "none".to_string()
    };
    let uri_preview = config
        .uri
        .as_deref()
        .map(redacted_uri)
        .unwrap_or_else(|| "—".to_string());
    if !config.enabled {
        return Ok(DbStatus {
            enabled: false,
            configured,
            connected: false,
            db_name: config.db_name.clone(),
            last_source: "local".to_string(),
            detail: "Modo local (Atlas desactivado en Ajustes).".to_string(),
            uri_source,
            uri_preview,
        });
    }
    if !configured {
        return Ok(DbStatus {
            enabled: true,
            configured: false,
            connected: false,
            db_name: config.db_name.clone(),
            last_source: "local".to_string(),
            detail: "Sin URI: modo local. Pega tu connection string de Atlas.".to_string(),
            uri_source,
            uri_preview,
        });
    }
    match ready_client(&state).await {
        Some(_) => Ok(DbStatus {
            enabled: true,
            configured: true,
            connected: true,
            last_source: "mongo".to_string(),
            detail: format!(
                "Atlas conectado · db «{}» · colecciones audits/metrics/profiles/conversations.",
                config.db_name
            ),
            db_name: config.db_name.clone(),
            uri_source,
            uri_preview,
        }),
        None => Ok(DbStatus {
            enabled: true,
            configured: true,
            connected: false,
            db_name: config.db_name.clone(),
            last_source: "local".to_string(),
            detail: "Atlas no responde (revisa IP autorizada y cluster): se usa local con reintento.".to_string(),
            uri_source,
            uri_preview,
        }),
    }
}

/// Guarda la configuración de Atlas. `uri` vacía = volver a modo local.
#[tauri::command]
pub async fn db_configure(
    state: tauri::State<'_, AppState>,
    uri: Option<String>,
    db_name: Option<String>,
    enabled: Option<bool>,
) -> Result<DbStatus, String> {
    let current = state.db_config();
    let next = DbConfig {
        uri: match uri {
            Some(u) if u.trim().is_empty() => None,
            Some(u) => Some(u.trim().to_string()),
            None => current.uri.clone(),
        },
        db_name: db_name
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .unwrap_or(current.db_name.clone()),
        enabled: enabled.unwrap_or(true),
    };
    state.save_db_config(&next)?;
    db_status(state).await
}

/// Migración local → Atlas: sube `profile.json`, `audit.jsonl` y
/// `metrics.jsonl` a sus colecciones. Idempotente (`_id` = id existente).
#[tauri::command]
pub async fn db_sync(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let (client, db) = ready_client(&state)
        .await
        .ok_or("Atlas no está disponible. Revisa la URI y la IP autorizada.".to_string())?;
    let (profile, audits, metrics) =
        state.read(|inner| (inner.profile.clone(), inner.audit.clone(), inner.metrics.clone()))?;

    // 1. Perfil (`_id = "profile"`).
    if let Ok(mut doc) = to_document(&profile) {
        doc.insert("_id", PROFILE_DOC_ID);
        let _ = upsert_doc(&client, &db, COL_PROFILES, PROFILE_DOC_ID, doc).await;
    }

    // 2. Auditoría y métricas en lotes desordenados (rápido y sin duplicados).
    let mut pushed_audits = 0usize;
    for chunk in audits.chunks(500) {
        let docs: Vec<Document> = chunk
            .iter()
            .filter_map(|entry| doc_with_id(entry, &entry.id).ok())
            .collect();
        pushed_audits += bulk_insert(&client, &db, COL_AUDITS, docs).await;
    }
    let mut pushed_metrics = 0usize;
    for chunk in metrics.chunks(500) {
        let docs: Vec<Document> = chunk
            .iter()
            .filter_map(|sample| doc_with_id(sample, &sample.id).ok())
            .collect();
        pushed_metrics += bulk_insert(&client, &db, COL_METRICS, docs).await;
    }

    // 3. Índices básicos (best-effort, con timeout).
    let _ = tokio::time::timeout(OP_TIMEOUT, async {
        let dbh = client.database(&db);
        let _ = dbh
            .collection::<Document>(COL_AUDITS)
            .create_index(
                mongodb::IndexModel::builder().keys(doc! { "timestamp": -1 }).build(),
                None,
            )
            .await;
        let _ = dbh
            .collection::<Document>(COL_METRICS)
            .create_index(
                mongodb::IndexModel::builder().keys(doc! { "timestamp": -1 }).build(),
                None,
            )
            .await;
        let _ = dbh
            .collection::<Document>(COL_CONVERSATIONS)
            .create_index(
                mongodb::IndexModel::builder().keys(doc! { "endedAt": -1 }).build(),
                None,
            )
            .await;
    })
    .await;

    Ok(serde_json::json!({
        "audits": audits.len(),
        "metrics": metrics.len(),
        "pushedAudits": pushed_audits,
        "pushedMetrics": pushed_metrics,
        "db": db,
    }))
}

/// Sube sesiones de conversación del `localStorage` a Atlas.
/// Lo llama el frontend después de `db_sync` con su historial local.
#[tauri::command]
pub async fn db_sync_conversations(
    state: tauri::State<'_, AppState>,
    sessions: Vec<ConversationSession>,
) -> Result<serde_json::Value, String> {
    let (client, db) = ready_client(&state)
        .await
        .ok_or("Atlas no está disponible.".to_string())?;
    let mut pushed = 0u32;
    for session in &sessions {
        if session.id.trim().is_empty() {
            continue;
        }
        if let Ok(doc) = doc_with_id(session, &session.id) {
            if upsert_doc(&client, &db, COL_CONVERSATIONS, &session.id, doc)
                .await
                .is_ok()
            {
                pushed += 1;
            }
        }
    }
    Ok(serde_json::json!({ "received": sessions.len(), "pushed": pushed, "db": db }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacted_uri_hides_credentials() {
        let shown = redacted_uri("mongodb+srv://user:secret@cluster0.x.mongodb.net/");
        assert!(!shown.contains("secret"), "la contraseña no debe mostrarse");
        assert!(shown.contains("cluster0.x.mongodb.net/"));
    }

    #[test]
    fn doc_with_id_sets_id() {
        let entry = AuditEntry {
            id: "abc".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            action: "conversation".to_string(),
            label: "Conversación".to_string(),
            status: "success".to_string(),
            target: String::new(),
            summary: "hola".to_string(),
            confirmed: false,
            origin: "ui".to_string(),
            latency_ms: 0,
            error: None,
        };
        let doc = doc_with_id(&entry, &entry.id).unwrap();
        assert_eq!(doc.get_str("_id").unwrap(), "abc");
    }
}
