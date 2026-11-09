//! Registro de auditoría y métricas de evaluación.
//!
//! Dos archivos append-only en el directorio de datos de la app:
//!
//! * `audit.jsonl` — una línea por acción intentada. Se registra **siempre**:
//!   también cuando se deniega, se cancela o falla. Una denegación es
//!   precisamente la línea más interesante para un informe de seguridad.
//! * `metrics.jsonl` — una línea por interacción, con las latencias por etapa
//!   que alimentan los indicadores de usabilidad y rendimiento.
use std::collections::HashMap;

use tauri::State;

use crate::model::{
    human_size, ActionMetrics, ActionTally, AuditEntry, AuditInput, AuditQuery, AuditStats,
    LatencyStats, MetricInput, MetricRecord, MetricsSummary, StatusTally,
};
use crate::policy::{action_label, is_catalog_action};
use crate::state::{append_jsonl_line, write_jsonl, AppState, Inner};

/// Máximo de latencias que se guardan por etapa, para que el archivo no crezca
/// sin límite aunque el usuario no limpie los datos.
const MAX_METRIC_SAMPLES: usize = 20_000;

/* ------------------------------------------------------------------ */
/* Auditoría                                                           */
/* ------------------------------------------------------------------ */

/** Añade una entrada al registro y la persiste. */
pub fn append(state: &AppState, input: AuditInput) -> Result<AuditEntry, String> {
    let entry = AuditEntry {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: crate::model::now_iso(),
        action: input.action.clone(),
        label: action_label(&input.action),
        status: input.status,
        target: input.target,
        summary: input.summary,
        confirmed: input.confirmed,
        origin: input.origin,
        latency_ms: input.latency_ms,
        error: input.error.filter(|e| !e.trim().is_empty()),
    };

    let path = state.audit_path();
    state.try_write(|inner: &mut Inner| {
        inner.audit.push(entry.clone());
        // Append O(1): no se reescribe el historial completo en cada acción.
        append_jsonl_line(&path, &entry)
    })?;
    // Espejo best-effort a Atlas en segundo plano: un fallo de red nunca
    // rompe ni retrasa la acción (ver `db::spawn_mirror_audit`).
    crate::db::spawn_mirror_audit(state, entry.clone());
    Ok(entry)
}

/// Registra una acción ejecutada, rechazada o cancelada (entrada IPC).
#[tauri::command]
pub fn audit_append(state: State<'_, AppState>, entry: AuditInput) -> Result<AuditEntry, String> {
    append(&state, entry)
}

/// Historial de acciones, de la más reciente a la más antigua.
#[tauri::command]
pub async fn audit_list(
    state: State<'_, AppState>,
    query: AuditQuery,
) -> Result<Vec<AuditEntry>, String> {
    // Híbrido: si Atlas responde, se lee de `audits`; si no, del JSONL local.
    if let Some((client, db)) = crate::db::ready_client(&state).await {
        if let Ok(rows) = crate::db::fetch_audits(
            &client,
            &db,
            query.action.as_deref(),
            query.status.as_deref(),
            query.origin.as_deref(),
            query.limit.clamp(1, 1_000) as i64,
            query.offset as u64,
        )
        .await
        {
            return Ok(rows);
        }
    }
    state.read(|inner: &Inner| {
        let mut rows: Vec<AuditEntry> = inner
            .audit
            .iter()
            .rev()
            .filter(|entry| match query.action.as_deref() {
                Some(filter) if !filter.trim().is_empty() => entry.action == filter,
                _ => true,
            })
            .filter(|entry| match query.status.as_deref() {
                Some(filter) if !filter.trim().is_empty() => entry.status == filter,
                _ => true,
            })
            .filter(|entry| match query.origin.as_deref() {
                Some(filter) if !filter.trim().is_empty() => entry.origin == filter,
                _ => true,
            })
            .cloned()
            .collect();

        let offset = query.offset as usize;
        if offset > 0 {
            rows = rows.into_iter().skip(offset).collect();
        }
        rows.truncate(query.limit.clamp(1, 1_000) as usize);
        rows
    })
}

/// Resumen agregado del historial, para la pantalla de historial.
#[tauri::command]
pub async fn audit_stats(state: State<'_, AppState>) -> Result<AuditStats, String> {
    if let Some((client, db)) = crate::db::ready_client(&state).await {
        if let Ok(remote) = crate::db::fetch_all_audits(&client, &db).await {
            return Ok(summarize(&remote, &atlas_label(&db)));
        }
    }
    state.read(|inner: &Inner| {
        summarize(
            &inner.audit,
            &state.audit_path().to_string_lossy().to_string(),
        )
    })
}

fn atlas_label(db: &str) -> String {
    format!("atlas:{db}/audits")
}

fn summarize(entries: &[crate::model::AuditEntry], source: &str) -> AuditStats {
    summarize_impl(entries, source)
}

fn summarize_impl(entries: &[crate::model::AuditEntry], source: &str) -> AuditStats {
    let mut by_action: HashMap<String, ActionTally> = HashMap::new();
    let mut by_status: HashMap<String, u32> = HashMap::new();
    let mut confirmed = 0u32;
    let mut guarded = 0u32;
    let mut oldest: Option<String> = None;
    let mut newest: Option<String> = None;

    for entry in entries {
            let tally = by_action
                .entry(entry.action.clone())
                .or_insert_with(|| ActionTally {
                    action: entry.action.clone(),
                    label: entry.label.clone(),
                    total: 0,
                    success: 0,
                });
            tally.total += 1;
            if entry.status == "success" {
                tally.success += 1;
            }
            *by_status.entry(entry.status.clone()).or_insert(0) += 1;
            if entry.confirmed {
                confirmed += 1;
            }
            // Una denegación significa que una guarda del backend detuvo la
            // acción: es el indicador de que el confinement funciona.
            if entry.status == "denied" {
                guarded += 1;
            }
            match &oldest {
                Some(current) if current <= &entry.timestamp => {}
                _ => oldest = Some(entry.timestamp.clone()),
            }
            match &newest {
                Some(current) if current >= &entry.timestamp => {}
                _ => newest = Some(entry.timestamp.clone()),
            }
        }

        let mut actions: Vec<ActionTally> = by_action.into_values().collect();
        actions.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.label.cmp(&b.label)));

        AuditStats {
            total: entries.len() as u32,
            by_action: actions,
            by_status: by_status
                .into_iter()
                .map(|(status, total)| StatusTally { status, total })
                .collect(),
            confirmed_operations: confirmed,
            guarded_operations: guarded,
            audit_file: source.to_string(),
            oldest,
            newest,
        }
}

/// Exporta el historial a CSV o JSON y devuelve la ruta del archivo.
#[tauri::command]
pub fn audit_export(state: State<'_, AppState>, format: String) -> Result<String, String> {
    let entries = state.read(|inner: &Inner| inner.audit.clone())?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let dir = state.data_dir().join("exports");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear la carpeta de exports: {e}"))?;

    let (name, contents) = match format.to_lowercase().as_str() {
        "json" => (
            format!("aster-audit-{stamp}.json"),
            serde_json::to_string_pretty(&entries)
                .map_err(|e| format!("No se pudo serializar: {e}"))?,
        ),
        _ => (
            "aster-audit-".to_string() + &stamp + ".csv",
            to_csv(&entries),
        ),
    };

    let path = dir.join(name);
    std::fs::write(&path, contents).map_err(|e| format!("No se pudo escribir el archivo: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// Serializa el historial a CSV con cabecera y campos entrecomillados.
fn to_csv(entries: &[AuditEntry]) -> String {
    let mut out = String::from(
        "id,timestamp,action,label,status,target,summary,confirmed,origin,latency_ms,error\n",
    );
    for entry in entries {
        let fields = [
            entry.id.clone(),
            entry.timestamp.clone(),
            entry.action.clone(),
            entry.label.clone(),
            entry.status.clone(),
            entry.target.clone(),
            entry.summary.clone(),
            entry.confirmed.to_string(),
            entry.origin.clone(),
            entry.latency_ms.to_string(),
            entry.error.clone().unwrap_or_default(),
        ];
        let row: Vec<String> = fields.iter().map(|f| quote(f)).collect();
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

/// Escapa un campo CSV: duplica las comillas y envuelve el valor.
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Borra el historial de acciones. Es un derecho del usuario sobre sus datos.
#[tauri::command]
pub fn audit_clear(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.audit_path();
    state.try_write(|inner: &mut Inner| {
        inner.audit.clear();
        write_jsonl(&path, &inner.audit)
    })?;
    // Limpieza best-effort en Atlas en segundo plano: el local ya quedó.
    crate::db::spawn_remote_clear(&state, crate::db::COL_AUDITS);
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Métricas                                                            */
/* ------------------------------------------------------------------ */

/// Guarda una muestra de métricas de una interacción completa.
pub fn record(state: &AppState, sample: MetricInput) -> Result<(String, String), String> {
    let record = MetricRecord {
        id: uuid::Uuid::new_v4().to_string(),
        timestamp: crate::model::now_iso(),
        action: sample.action.clone(),
        label: action_label(&sample.action),
        origin: sample.origin,
        stt_ms: sample.stt_ms,
        interpret_ms: sample.interpret_ms,
        execute_ms: sample.execute_ms,
        tts_ms: sample.tts_ms,
        total_ms: sample.total_ms,
        confidence: sample.confidence,
        success: sample.success,
        confirmation_requested: sample.confirmation_requested,
        confirmation_accepted: sample.confirmation_accepted,
        usability_vote: sample.usability_vote,
        utterance: sample.utterance,
        error: sample.error.filter(|e| !e.trim().is_empty()),
    };
    let (id, timestamp) = (record.id.clone(), record.timestamp.clone());

    let path = state.metrics_path();
    state.try_write(|inner: &mut Inner| {
        inner.metrics.push(record.clone());
        if inner.metrics.len() > MAX_METRIC_SAMPLES {
            // Solo al recortar el tope se reescribe el archivo (infrecuente).
            let excess = inner.metrics.len() - MAX_METRIC_SAMPLES;
            inner.metrics.drain(..excess);
            write_jsonl(&path, &inner.metrics)
        } else {
            append_jsonl_line(&path, &record)
        }
    })?;
    crate::db::spawn_mirror_metric(state, record.clone());
    Ok((id, timestamp))
}

/// Registra una muestra de métricas (entrada IPC).
#[tauri::command]
pub fn metrics_append(
    state: State<'_, AppState>,
    sample: MetricInput,
) -> Result<serde_json::Value, String> {
    let (id, timestamp) = record(&state, sample)?;
    Ok(serde_json::json!({ "id": id, "timestamp": timestamp }))
}

/// Asocia una valoración de usabilidad (±1) a una interacción ya registrada.
#[tauri::command]
pub fn metrics_rate(state: State<'_, AppState>, id: String, vote: i8) -> Result<(), String> {
    if !(-1..=1).contains(&vote) {
        return Err("La valoración debe ser 1 o -1.".to_string());
    }
    let path = state.metrics_path();
    state.try_write(|inner: &mut Inner| {
        let sample = inner
            .metrics
            .iter_mut()
            .find(|sample| sample.id == id)
            .ok_or("No se encontró esa interacción registrada.")?;
        if sample.usability_vote.is_some() {
            return Err("Esta interacción ya tiene una valoración.".to_string());
        }
        sample.usability_vote = Some(vote);
        write_jsonl(&path, &inner.metrics)
    })?;
    crate::db::spawn_remote_vote(&state, id.clone(), vote);
    Ok(())
}

/// Borra todas las muestras de métricas.
#[tauri::command]
pub fn metrics_clear(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.metrics_path();
    state.try_write(|inner: &mut Inner| {
        inner.metrics.clear();
        write_jsonl(&path, &inner.metrics)
    })?;
    crate::db::spawn_remote_clear(&state, crate::db::COL_METRICS);
    Ok(())
}

/// Indicadores de evaluación del proyecto.
#[tauri::command]
pub async fn metrics_summary(state: State<'_, AppState>) -> Result<MetricsSummary, String> {
    if let Some((client, db)) = crate::db::ready_client(&state).await {
        if let Ok(remote) = crate::db::fetch_all_metrics(&client, &db).await {
            if !remote.is_empty() {
                return Ok(summarize_metrics(&remote, &format!("atlas:{db}/metrics")));
            }
            // Si Atlas está vacío pero hay local, se sigue al local.
            let local_len = state.read(|inner| inner.metrics.len())?;
            if local_len == 0 {
                return Ok(empty_summary_atlas(&db));
            }
        }
    }
    state.read(|inner: &Inner| {
        summarize_metrics(
            &inner.metrics,
            &state.metrics_path().to_string_lossy().to_string(),
        )
    })
}

fn summarize_metrics(samples: &[MetricRecord], source: &str) -> MetricsSummary {
        let interactions = samples.len() as u32;
        if interactions == 0 {
            return MetricsSummary {
                interactions: 0,
                task_success_rate: 0.0,
                interpretation_accuracy: 0.0,
                user_rating_rate: Some(0.0),
                voted_interactions: 0,
                total_latency: LatencyStats::default(),
                interpret_latency: LatencyStats::default(),
                execute_latency: LatencyStats::default(),
                stt_latency: LatencyStats::default(),
                tts_latency: LatencyStats::default(),
                confirmations_requested: 0,
                confirmations_accepted: 0,
                usability_index: 0.0,
                per_action: Vec::new(),
                metrics_file: source.to_string(),
            };
        }

        let successes = samples.iter().filter(|s| s.success).count() as u32;
        let voted: Vec<&MetricRecord> = samples
            .iter()
            .filter(|s| s.usability_vote.is_some())
            .collect();
        let positives = voted.iter().filter(|s| s.usability_vote == Some(1)).count() as u32;

        let mean_confidence =
            samples.iter().map(|s| s.confidence).sum::<f64>() / interactions as f64;

        // Confirmaciones aceptadas / solicitadas, sobre las que las hubo.
        let requested = samples.iter().filter(|s| s.confirmation_requested).count() as u32;
        let accepted = samples.iter().filter(|s| s.confirmation_accepted).count() as u32;

        let mut per_action: HashMap<String, (u32, u32, f64)> = HashMap::new();
        for sample in samples {
            let row = per_action
                .entry(sample.action.clone())
                .or_insert((0, 0, 0.0));
            row.0 += 1;
            if sample.success {
                row.1 += 1;
            }
            row.2 += sample.total_ms;
        }
        let mut per_action: Vec<ActionMetrics> = per_action
            .into_iter()
            .map(|(action, (count, success, total_ms))| ActionMetrics {
                label: action_label(&action),
                in_catalog: is_catalog_action(&action),
                success_rate: (success as f64 / count as f64 * 100.0) as f32,
                mean_latency_ms: round(total_ms / count as f64),
                count,
                success,
                action,
            })
            .collect();
        per_action.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.action.cmp(&b.action)));

        MetricsSummary {
            interactions,
            task_success_rate: percent(successes, interactions),
            interpretation_accuracy: (mean_confidence.clamp(0.0, 1.0) * 100.0) as f32,
            user_rating_rate: Some(percent(voted.len() as u32, interactions)),
            voted_interactions: voted.len() as u32,
            total_latency: latency(samples, |s| s.total_ms),
            interpret_latency: latency(samples, |s| s.interpret_ms),
            execute_latency: latency(samples, |s| s.execute_ms),
            stt_latency: latency(samples, |s| s.stt_ms),
            tts_latency: latency(samples, |s| s.tts_ms),
            confirmations_requested: requested,
            confirmations_accepted: accepted,
            // Sin votos del usuario todavía el índice es 0 y la interfaz lo
            // explica: se alimenta de los botones 👍/👎 del chat.
            usability_index: percent(positives, voted.len() as u32),
            per_action,
            metrics_file: source.to_string(),
        }
}

fn empty_summary_atlas(db: &str) -> MetricsSummary {
    MetricsSummary {
        interactions: 0,
        task_success_rate: 0.0,
        interpretation_accuracy: 0.0,
        user_rating_rate: Some(0.0),
        voted_interactions: 0,
        total_latency: LatencyStats::default(),
        interpret_latency: LatencyStats::default(),
        execute_latency: LatencyStats::default(),
        stt_latency: LatencyStats::default(),
        tts_latency: LatencyStats::default(),
        confirmations_requested: 0,
        confirmations_accepted: 0,
        usability_index: 0.0,
        per_action: Vec::new(),
        metrics_file: format!("atlas:{db}/metrics"),
    }
}

/// Porcentaje redondeado, evitando divisiones por cero.
fn percent(part: u32, total: u32) -> f32 {
    if total == 0 {
        0.0
    } else {
        (part as f32 / total as f32 * 1000.0).round() / 10.0
    }
}

/// Estadísticos de latencia de una etapa: media, mediana, p95 y máximo.
fn latency(samples: &[MetricRecord], pick: impl Fn(&MetricRecord) -> f64) -> LatencyStats {
    if samples.is_empty() {
        return LatencyStats::default();
    }
    let mut values: Vec<f64> = samples.iter().map(&pick).filter(|v| *v >= 0.0).collect();
    if values.is_empty() {
        return LatencyStats::default();
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let sum: f64 = values.iter().sum();

    LatencyStats {
        mean_ms: round(sum / values.len() as f64),
        p50_ms: percentile(&values, 0.50),
        p95_ms: percentile(&values, 0.95),
        max_ms: round(values[values.len() - 1]),
    }
}

/// Percentil con interpolación lineal sobre la muestra ordenada.
fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    if sorted.len() == 1 {
        return round(sorted[0]);
    }
    let position = fraction * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        return round(sorted[lower]);
    }
    let weight = position - lower as f64;
    round(sorted[lower] * (1.0 - weight) + sorted[upper] * weight)
}

fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Tamaño en disco de los dos registros, para la pantalla de datos.
pub fn storage_summary(state: &AppState) -> String {
    let audit = std::fs::metadata(state.audit_path())
        .map(|m| m.len())
        .unwrap_or(0);
    let metrics = std::fs::metadata(state.metrics_path())
        .map(|m| m.len())
        .unwrap_or(0);
    format!(
        "{} de acciones, {} de métricas",
        human_size(audit),
        human_size(metrics)
    )
}
