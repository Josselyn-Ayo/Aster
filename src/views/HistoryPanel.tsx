/**
 * HistoryPanel: consulta del historial (acciones y conversaciones) y de los
 * indicadores de evaluación del proyecto.
 *
 * Acciones: última N entradas del registro de auditoría, con estado, si hubo
 * confirmación y tiempo que tardó. Conversations: sesiones guardadas en este
 * dispositivo (texto, nunca audio). Evaluación: precisión de interpretación,
 * porcentaje de tareas ejecutadas correctamente, latencias por etapa y un
 * índice de usabilidad construido con los votos del usuario.
 */
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, AuditStats, MetricsSummary } from "../types/aster";
import { ASTER_ACTION_LABELS, ASTER_ACTIONS } from "../types/aster";
import { auditList, auditStats } from "../services/aster/commands";
import { clearAudit, clearMetrics, exportAudit, metricsSummary } from "../services/aster/audit";
import { statusLabel } from "../services/aster/format";
import { clearHistory, deleteSession, loadHistory, type ConversationSession } from "../services/history/store";

type Tab = "actions" | "conversations" | "evaluation";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "actions", label: "Acciones" },
  { id: "conversations", label: "Conversaciones" },
  { id: "evaluation", label: "Evaluación" },
];

/** Barra de progreso reutilizable para los indicadores. */
function Gauge({ label, value, hint }: { label: string; value: number; hint?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="rounded-xl border border-aster-border bg-aster-bg p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
          {label}
        </span>
        <span className="text-sm font-semibold text-aster-text">{pct.toFixed(0)} %</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-aster-surface2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-aster-accent to-aster-accent2"
          style={{ width: `${pct}%` }}
        />
      </div>
      {hint && <p className="mt-1.5 text-[11px] text-aster-muted">{hint}</p>}
    </div>
  );
}

/** Fila de latencia. */
function LatencyRow({ label, stats }: { label: string; stats: MetricsSummary["totalLatency"] }) {
  return (
    <tr className="border-b border-aster-border/60 last:border-0">
      <td className="py-1.5 text-xs text-aster-muted">{label}</td>
      <td className="py-1.5 text-right text-xs text-aster-text">{stats.p50Ms} ms</td>
      <td className="py-1.5 text-right text-xs text-aster-text">{stats.p95Ms} ms</td>
      <td className="py-1.5 text-right text-xs text-aster-text">{stats.meanMs} ms</td>
    </tr>
  );
}

export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("actions");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    try {
      const [list, tally] = await Promise.all([auditList({ limit: 60 }), auditStats()]);
      setEntries(list);
      setStats(tally);
    } catch (error) {
      console.error("[ASTER-historial] no se pudo cargar:", error);
    }
  }, []);

  useEffect(() => {
    void reload();
    setSessions(loadHistory());
  }, [reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (tab !== "evaluation") return;
    void metricsSummary()
      .then(setSummary)
      .catch((error) => console.error("[ASTER-métricas] no se pudo cargar:", error));
  }, [tab, entries.length]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      setNotice(label);
      window.setTimeout(() => setNotice(""), 4000);
    } catch (error) {
      setNotice(`Error: ${(error as Error).message}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-aster-border bg-aster-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-aster-border px-6 py-4">
          <div>
            <h2 className="font-display text-lg font-bold text-aster-text">Historial y evaluación</h2>
            <p className="text-xs text-aster-muted">
              Híbrido local + Atlas: sin conexión todo sigue en este dispositivo. Las grabaciones de voz nunca se almacenan.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-aster-border px-3 py-1.5 text-sm text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
          >
            Cerrar
          </button>
        </header>

        <nav className="flex gap-1 border-b border-aster-border px-6 py-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                tab === item.id
                  ? "bg-aster-accent/15 font-semibold text-aster-accent2"
                  : "text-aster-muted hover:text-aster-text"
              }`}
            >
              {item.label}
            </button>
          ))}
          {notice && <span className="ml-auto self-center text-xs text-aster-accent2">{notice}</span>}
        </nav>

        <div className="aster-scroll flex-1 overflow-y-auto p-6">
          {tab === "actions" && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => run("Historial exportado.", () => exportAudit("csv"))}
                  className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
                >
                  Exportar CSV
                </button>
                <button
                  onClick={() => run("Historial exportado.", () => exportAudit("json"))}
                  className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
                >
                  Exportar JSON
                </button>
                <button
                  onClick={() =>
                    run("Historial de acciones borrado.", async () => {
                      await clearAudit();
                      await reload();
                    })
                  }
                  className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
                >
                  Borrar historial de acciones
                </button>
              </div>

              {stats && (
                <p className="text-xs text-aster-muted">
                  {stats.total} acciones registradas · {stats.confirmedOperations} con confirmación
                  explícita · registro en <span className="font-mono">{stats.auditFile}</span>
                </p>
              )}

              {entries.length === 0 ? (
                <p className="text-sm text-aster-muted">
                  Todavía no hay acciones registradas. Pídele a Aster que haga algo y aparecerá aquí.
                </p>
              ) : (
                <ul className="space-y-2">
                  {entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="rounded-xl border border-aster-border bg-aster-bg p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-semibold text-aster-text">
                          {ASTER_ACTION_LABELS[entry.action as keyof typeof ASTER_ACTION_LABELS] ??
                            entry.label ??
                            entry.action}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 ${
                            entry.status === "success"
                              ? "bg-emerald-500/15 text-emerald-300"
                              : entry.status === "cancelled" || entry.status === "denied"
                                ? "bg-amber-500/15 text-amber-300"
                                : "bg-red-500/15 text-red-300"
                          }`}
                        >
                          {statusLabel(entry.status)}
                        </span>
                      </div>
                      <p className="mt-1 break-words text-aster-text/90">
                        {entry.summary || entry.target}
                      </p>
                      <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-aster-muted">
                        <span>{entry.timestamp.replace("T", " ").replace("Z", "")}</span>
                        <span>{entry.origin}</span>
                        <span>{entry.latencyMs} ms</span>
                        {entry.confirmed && <span className="text-amber-300">confirmada</span>}
                      </p>
                      {entry.error && <p className="mt-1 text-[11px] text-red-300">{entry.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === "conversations" && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() =>
                    run("Historial de conversaciones borrado.", async () => {
                      clearHistory();
                      setSessions([]);
                    })
                  }
                  className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
                >
                  Borrar conversaciones
                </button>
              </div>
              {sessions.length === 0 ? (
                <p className="text-sm text-aster-muted">No hay conversaciones guardadas.</p>
              ) : (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    className="rounded-xl border border-aster-border bg-aster-bg p-3 text-xs"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-aster-muted">
                        {session.startedAt.replace("T", " ").replace("Z", "")}
                      </span>
                      <button
                        onClick={() =>
                          run("Conversación eliminada.", async () => {
                            deleteSession(session.id);
                            setSessions(loadHistory());
                          })
                        }
                        className="text-aster-muted underline transition hover:text-red-300"
                      >
                        eliminar
                      </button>
                    </div>
                    <p className="mt-1 text-aster-text/90">{session.preview}</p>
                    <p className="mt-1 text-[11px] text-aster-muted">
                      {session.turns} mensajes
                    </p>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === "evaluation" && (
            <div className="space-y-5">
              {!summary || summary.interactions === 0 ? (
                <p className="text-sm text-aster-muted">
                  Todavía no hay interacciones registradas. Los indicadores se alimentan de cada
                  orden que le des a Aster.
                </p>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Gauge
                      label="Precisión de interpretación"
                      value={summary.interpretationAccuracy}
                      hint="Confianza media declarada por el modelo al clasificar la orden."
                    />
                    <Gauge
                      label="Tareas correctas"
                      value={summary.taskSuccessRate}
                      hint={`${summary.interactions} interacciones registradas.`}
                    />
                    <Gauge
                      label="Usabilidad"
                      value={summary.usabilityIndex}
                      hint={
                        summary.votedInteractions > 0
                          ? `${summary.votedInteractions} valoración(es) del usuario; ${summary.confirmationsAccepted}/${summary.confirmationsRequested} confirmaciones aceptadas.`
                          : "Sin valoraciones del usuario todavía: se alimentará de los votos 👍/👎."
                      }
                    />
                    <Gauge
                      label="Confirmaciones"
                      value={
                        summary.confirmationsRequested > 0
                          ? (summary.confirmationsAccepted / summary.confirmationsRequested) * 100
                          : 100
                      }
                      hint="Operaciones de escritura que el usuario confirmó."
                    />
                  </div>

                  <div className="rounded-xl border border-aster-border bg-aster-bg p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
                      Latencias (ms)
                    </h3>
                    <table className="mt-2 w-full text-right">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-widest text-aster-muted">
                          <th className="text-left font-normal">Etapa</th>
                          <th className="font-normal">p50</th>
                          <th className="font-normal">p95</th>
                          <th className="font-normal">media</th>
                        </tr>
                      </thead>
                      <tbody>
                        <LatencyRow label="Total percibida" stats={summary.totalLatency} />
                        <LatencyRow label="Voz (STT)" stats={summary.sttLatency} />
                        <LatencyRow label="Interpretación" stats={summary.interpretLatency} />
                        <LatencyRow label="Ejecución" stats={summary.executeLatency} />
                        <LatencyRow label="Respuesta (TTS)" stats={summary.ttsLatency} />
                      </tbody>
                    </table>
                  </div>

                  <div className="rounded-xl border border-aster-border bg-aster-bg p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
                      Por acción del catálogo
                    </h3>
                    <ul className="mt-2 space-y-1.5 text-xs">
                      {summary.perAction.map((row) => (
                        <li key={row.action} className="flex flex-wrap justify-between gap-2">
                          <span className="text-aster-text">
                            {ASTER_ACTION_LABELS[row.action as keyof typeof ASTER_ACTION_LABELS] ??
                              row.label ??
                              row.action}
                            {!row.inCatalog && (
                              <span className="ml-1 text-[10px] text-aster-muted">(fuera del catálogo)</span>
                            )}
                          </span>
                          <span className="text-aster-muted">
                            {row.count} uso(s) · {row.successRate.toFixed(0)} % correcto ·{" "}
                            {row.meanLatencyMs} ms
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 text-[11px] text-aster-muted">
                      Acciones del catálogo sin uso todavía:{" "}
                      {ASTER_ACTIONS.filter(
                        (action) => !summary.perAction.some((row) => row.action === action),
                      )
                        .map((action) => ASTER_ACTION_LABELS[action])
                        .join(", ") || "ninguna"}
                      .
                    </p>
                  </div>

                  <button
                    onClick={() =>
                      run("Métricas borradas.", async () => {
                        await clearMetrics();
                        setSummary(await metricsSummary());
                      })
                    }
                    className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
                  >
                    Borrar métricas
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
