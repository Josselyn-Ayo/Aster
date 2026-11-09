/**
 * Presentación en lenguaje natural de los resultados del catálogo de acciones.
 *
 * Los datos llegan del backend ya validados; aquí solo se convierten en frases
 * que Aster puede leer en voz alta y mostrar en la burbuja del chat.
 */
import type { AuditEntry, AuditStats, FileHit, SystemReport } from "../../types/aster";

/** Resume el informe del sistema según lo que se haya preguntado. */
export function formatSystemReport(report: SystemReport, topic?: string): string {
  const focus = (topic ?? "").toLowerCase();
  const lines: string[] = [];

  if (!focus || /resumen|general|equipo|portatil|pc/.test(focus)) {
    lines.push(`${report.osName}${report.osVersion ? ` ${report.osVersion}` : ""}`);
    lines.push(`Equipo ${report.hostname}, usuario ${report.user}.`);
  }
  if (!focus || /resumen|general|hardware|procesador|cpu/.test(focus)) {
    lines.push(`Procesador ${report.cpu} con ${report.cpuThreads} hilos.`);
  }
  if (!focus || /resumen|general|memoria|ram|hardware/.test(focus)) {
    lines.push(`Memoria: ${report.memoryUsedPercent} % en uso de ${(report.memoryTotalBytes / 1024 ** 3).toFixed(1)} GB.`);
  }
  if (!focus || /disco|almacenamiento|espacio|discos/.test(focus)) {
    lines.push(
      report.disks
        .map((d) => `${d.label} ${d.freeLabel} libres de ${d.totalLabel}`)
        .join("; ") || "No se detectaron unidades.",
    );
  }
  if (!focus || /bateria|batería|energia|energía/.test(focus)) {
    lines.push(
      report.battery
        ? `Batería: ${report.battery.status}${
            report.battery.percent !== undefined ? ` (${report.battery.percent} %)` : ""
          }.`
        : "Batería: el equipo no tiene batería detectada.",
    );
  }
  if (/proceso|programa|tarea/.test(focus)) {
    lines.push(
      report.processes.length
        ? `Procesos con más memoria: ${report.processes
            .map((p) => `${p.name} (${p.memoryLabel})`)
            .join(", ")}.`
        : "No se pudieron leer los procesos.",
    );
  }
  if (!focus || /resumen|general|tiempo|encendido|uptime/.test(focus)) {
    lines.push(`Encendido desde hace ${report.uptimeLabel}. Pantallas conectadas: ${report.screens}.`);
  }

  return lines.join(" ");
}

/** Presenta los resultados de la búsqueda de archivos. */
export function formatFileHits(hits: FileHit[], query: string): string {
  if (hits.length === 0) {
    return `No encontré nada que coincida con «${query}» en las carpetas autorizadas.`;
  }
  const folders = hits.filter((h) => h.isDirectory).length;
  const files = hits.length - folders;
  const breakdown = [
    folders ? `${folders} carpeta${folders === 1 ? "" : "s"}` : null,
    files ? `${files} archivo${files === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" y ");
  const first = hits.slice(0, 5).map((h) => h.path);
  const rest = hits.length > 5 ? ` Y ${hits.length - 5} más en la lista.` : "";
  return `Encontré ${breakdown} para «${query}». Los primeros: ${first.join("; ")}.${rest}`;
}

/** Presenta el historial de acciones reciente. */
export function formatHistory(
  entries: AuditEntry[],
  stats: AuditStats,
  actionFilter?: string,
): string {
  if (entries.length === 0) {
    return actionFilter
      ? `No hay acciones registradas de tipo «${actionFilter}» todavía.`
      : "Todavía no hay acciones registradas en el historial.";
  }
  const lines = entries
    .slice(0, 8)
    .map((entry) => {
      const icon =
        entry.status === "success"
          ? "✓"
          : entry.status === "cancelled"
            ? "⊘"
            : entry.status === "denied"
              ? "⊘"
              : "✕";
      const confirmed = entry.confirmed ? " (confirmada)" : "";
      return `${icon} ${entry.label}: ${entry.summary || entry.target}${confirmed}`;
    });
  const footer = `En total: ${stats.total} acciones registradas, ${stats.byStatus
    .map((s) => `${s.total} ${statusLabel(s.status)}`)
    .join(", ")}.`;
  return `${lines.join(". ")}. ${footer}`;
}

/** Traduce el estado de auditoría a un texto legible. */
export function statusLabel(status: string): string {
  switch (status) {
    case "success":
      return "correctas";
    case "error":
      return "con error";
    case "denied":
      return "denegadas";
    case "cancelled":
      return "canceladas";
    case "pending":
      return "pendientes";
    default:
      return status;
  }
}

/** Presenta las fuentes de una búsqueda en Internet como enlaces clicables. */
export function formatSearchSources(sources: Array<{ title: string; uri: string }>): string {
  if (sources.length === 0) return "";
  const links = sources.map((s) => {
    const title = s.title.replace(/[\[\]]/g, "(").trim() || s.uri;
    return `[${title}](${s.uri})`;
  });
  return `\n\nFuentes: ${links.join("; ")}`;
}
