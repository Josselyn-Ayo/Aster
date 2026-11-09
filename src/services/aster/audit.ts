/**
 * Registro de auditoría y métricas de evaluación (lado frontend).
 *
 * Todas las acciones del catálogo pasan por `recordAction`, que escribe una
 * línea en `audit.jsonl` dentro de la carpeta de datos de la aplicación. Las
 * operaciones que modifican archivos se registran **siempre**, tanto si se
 * ejecutan como si el usuario las cancela o el backend las rechaza.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AuditEntry,
  AuditInput,
  AuditStats,
  MetricInput,
  MetricsSummary,
} from "../../types/aster";

/** Registra una acción ejecutada, rechazada o cancelada. */
export function recordAction(entry: AuditInput): Promise<AuditEntry> {
  return invoke("audit_append", {
    entry: {
      action: entry.action,
      target: entry.target ?? "",
      summary: entry.summary ?? "",
      status: entry.status ?? "success",
      confirmed: entry.confirmed ?? false,
      origin: entry.origin ?? "ui",
      latencyMs: entry.latencyMs ?? 0,
      error: entry.error ?? null,
    },
  });
}

/** Registra una muestra de métricas de una interacción completa. */
export function recordMetric(sample: MetricInput): Promise<{ id: string; timestamp: string }> {
  return invoke("metrics_append", {
    sample: {
      action: sample.action,
      origin: sample.origin,
      sttMs: sample.sttMs,
      interpretMs: sample.interpretMs,
      executeMs: sample.executeMs,
      ttsMs: sample.ttsMs,
      totalMs: sample.totalMs,
      confidence: sample.confidence,
      success: sample.success,
      confirmationRequested: sample.confirmationRequested,
      confirmationAccepted: sample.confirmationAccepted,
      usabilityVote: sample.usabilityVote ?? null,
      utterance: sample.utterance,
      error: sample.error ?? null,
    },
  });
}

/** Asocia una valoración de usabilidad (±1) a una interacción registrada. */
export function rateInteraction(metricId: string, vote: 1 | -1): Promise<void> {
  return invoke("metrics_rate", { id: metricId, vote });
}

/** Indicadores de evaluación: precisión, % de acierto, latencia y usabilidad. */
export function metricsSummary(): Promise<MetricsSummary> {
  return invoke("metrics_summary");
}

/** Exporta el historial de acciones a CSV o JSON para los informes. */
export function exportAudit(format: "csv" | "json"): Promise<string> {
  return invoke("audit_export", { format });
}

/** Borra el historial de acciones (derecho del usuario sobre sus datos). */
export function clearAudit(): Promise<void> {
  return invoke("audit_clear");
}

/** Borra todas las muestras de métricas. */
export function clearMetrics(): Promise<void> {
  return invoke("metrics_clear");
}

export type { AuditStats };
