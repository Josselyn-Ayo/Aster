#!/usr/bin/env node
/**
 * E5 — Resumen de las métricas reales de uso de ASTER.
 *
 * Lee `metrics.jsonl` y `audit.jsonl` del directorio de datos de la app
 * (`%APPDATA%\com.aster.assistant` por defecto), calcula estadísticas por
 * acción y deja los resultados versionables en `docs/perf/`:
 *
 * - `resumen-metricas.csv` / `resumen-metricas.md` / `resumen-metricas.json`
 * - `resumen-auditoria.csv` / `resumen-auditoria.md`
 * - `raw/metrics-anon.jsonl` / `raw/audit-anon.jsonl` (sin texto del usuario)
 *
 * Es un análisis **observacional**: las interacciones las generó el uso normal
 * de la aplicación, no un guion controlado. El informe separa las corridas
 * exitosas de las fallidas porque un error de cuota (429) deja latencias de
 * decenas de segundos que no describen el rendimiento normal.
 *
 * Uso:
 *   node scripts/perf/report.mjs
 *   node scripts/perf/report.mjs --data "C:\ruta\com.aster.assistant"
 *   node scripts/perf/report.mjs --out docs/perf
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* ------------------------------------------------------------------ */
/* Argumentos                                                          */
/* ------------------------------------------------------------------ */

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataDir = resolve(
  argValue("--data", process.env.ASTER_DATA_DIR ?? join(process.env.APPDATA ?? "", "com.aster.assistant")),
);
const outDir = resolve(argValue("--out", "docs/perf"));
const rawDir = join(outDir, "raw");

/* ------------------------------------------------------------------ */
/* Lectura de JSONL                                                    */
/* ------------------------------------------------------------------ */

/**
 * Lee un JSONL y devuelve `{ records, invalid }`. Un archivo ausente no es un
 * error: la app puede no haberse usado todavía y el informe debe explicarlo.
 */
function readJsonl(path) {
  if (!existsSync(path)) return { records: [], invalid: 0, missing: true };
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const records = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      invalid += 1;
    }
  }
  return { records, invalid, missing: false };
}

/* ------------------------------------------------------------------ */
/* Estadística descriptiva                                             */
/* ------------------------------------------------------------------ */

const round = (value, digits = 2) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

/** Percentil por rango más cercano (misma idea que `audit::percentile`). */
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function stats(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) {
    return { n: 0, mean: null, p50: null, p95: null, max: null };
  }
  const sum = clean.reduce((acc, v) => acc + v, 0);
  return {
    n: clean.length,
    mean: round(sum / clean.length),
    p50: round(percentile(clean, 0.5)),
    p95: round(percentile(clean, 0.95)),
    max: round(Math.max(...clean)),
  };
}

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/* ------------------------------------------------------------------ */
/* Métricas por acción                                                 */
/* ------------------------------------------------------------------ */

function summarizeMetrics(records) {
  const groups = new Map();
  for (const record of records) {
    const action = typeof record.action === "string" ? record.action : "(sin acción)";
    if (!groups.has(action)) groups.set(action, []);
    groups.get(action).push(record);
  }

  return [...groups.entries()]
    .map(([action, rows]) => {
      const successful = rows.filter((r) => r.success === true);
      const failed = rows.filter((r) => r.success !== true);
      const totalAll = stats(rows.map((r) => number(r.totalMs)));
      const totalOk = stats(successful.map((r) => number(r.totalMs)));
      const a = (field, source = rows) => stats(source.map((r) => number(r[field])));
      return {
        action,
        label: rows.find((r) => typeof r.label === "string")?.label ?? action,
        n: rows.length,
        ok: successful.length,
        failed: failed.length,
        successRate: rows.length ? round((successful.length / rows.length) * 100, 1) : null,
        totalAll,
        totalOk,
        interpret: a("interpretMs"),
        execute: a("executeMs"),
        stt: a("sttMs"),
        tts: a("ttsMs"),
      };
    })
    .sort((x, y) => y.n - x.n || x.action.localeCompare(y.action));
}

/* ------------------------------------------------------------------ */
/* Auditoría por acción                                                */
/* ------------------------------------------------------------------ */

function summarizeAudit(records) {
  const groups = new Map();
  for (const record of records) {
    const action = typeof record.action === "string" ? record.action : "(sin acción)";
    if (!groups.has(action)) groups.set(action, []);
    groups.get(action).push(record);
  }

  return [...groups.entries()]
    .map(([action, rows]) => {
      const statuses = {};
      for (const row of rows) {
        const status = typeof row.status === "string" ? row.status : "unknown";
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
      const latency = stats(rows.map((r) => number(r.latencyMs)));
      return {
        action,
        label: rows.find((r) => typeof r.label === "string")?.label ?? action,
        n: rows.length,
        statuses,
        latency,
        confirmed: rows.filter((r) => r.confirmed === true).length,
      };
    })
    .sort((x, y) => y.n - x.n || x.action.localeCompare(y.action));
}

/* ------------------------------------------------------------------ */
/* Salidas                                                             */
/* ------------------------------------------------------------------ */

const csvCell = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

function toCsv(headers, rows) {
  const lines = [headers.join(";")];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(";"));
  return `${lines.join("\r\n")}\r\n`;
}

function fmt(value, suffix = " ms") {
  return value === null || value === undefined ? "—" : `${value}${suffix}`;
}

function metricsMarkdown(summary, meta) {
  const lines = [
    "# E5 · Métricas reales de uso (observacional)",
    "",
    `Generado: ${new Date().toISOString()}`,
    `Origen: \`${meta.dataDir}\``,
    `Registros válidos: ${meta.metrics.records} (${meta.metrics.invalid} líneas ilegibles)`,
    "",
    "> Estas cifras provienen del uso normal de ASTER, no de un guion controlado.",
    "> Las columnas «todas» incluyen interacciones fallidas; las de 429 agotan el",
    "> tiempo de espera y elevan la media. La comparación principal usa «éxito».",
    "",
    "## Totales por acción",
    "",
    "| Acción | n | Éxito | % éxito | total p50 (todas) | total p95 (todas) | total p50 (éxito) | total p95 (éxito) | máx (éxito) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of summary) {
    lines.push(
      `| ${row.action} | ${row.n} | ${row.ok} | ${fmt(row.successRate, " %")} | ${fmt(
        row.totalAll.p50,
      )} | ${fmt(row.totalAll.p95)} | ${fmt(row.totalOk.p50)} | ${fmt(
        row.totalOk.p95,
      )} | ${fmt(row.totalOk.max)} |`,
    );
  }
  lines.push(
    "",
    "## Desglose por etapa (todas las interacciones)",
    "",
    "| Acción | interpret p50 | interpret p95 | execute p50 | execute p95 | TTS p50 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const row of summary) {
    lines.push(
      `| ${row.action} | ${fmt(row.interpret.p50)} | ${fmt(row.interpret.p95)} | ${fmt(
        row.execute.p50,
      )} | ${fmt(row.execute.p95)} | ${fmt(row.tts.p50)} |`,
    );
  }
  lines.push(
    "",
    "## Lectura",
    "",
    "- `interpretMs` es el enrutado (vía rápida local o router LLM).",
    "- `executeMs` es la ejecución: IPC nativo, búsqueda web o llamada de chat.",
    "- `totalMs` = STT + interpretación + ejecución + TTS.",
    "- El detalle por interacción está en `raw/metrics-anon.jsonl` (sin el texto dictado).",
    "",
  );
  return lines.join("\n");
}

function auditMarkdown(summary, meta) {
  const lines = [
    "# E5 · Auditoría de acciones (observacional)",
    "",
    `Registros válidos: ${meta.audit.records} (${meta.audit.invalid} líneas ilegibles)`,
    "",
    "| Acción | n | Estados | p50 | p95 | máx | Confirmadas |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const row of summary) {
    const states = Object.entries(row.statuses)
      .map(([status, count]) => `${status}: ${count}`)
      .join(", ");
    lines.push(
      `| ${row.action} | ${row.n} | ${states || "—"} | ${fmt(row.latency.p50)} | ${fmt(
        row.latency.p95,
      )} | ${fmt(row.latency.max)} | ${row.confirmed} |`,
    );
  }
  lines.push(
    "",
    "> Los tiempos de auditoría incluyen el trabajo del backend nativo (por ejemplo,",
    "> una búsqueda de archivos completa), por eso no son comparables con las",
    "> etapas del frontend.",
    "",
  );
  return lines.join("\n");
}

/** Clasifica un error sin conservar rutas, consultas ni texto del usuario. */
function errorKind(error) {
  if (typeof error !== "string" || !error.trim()) return "cancelled";
  const http = /"code"\s*:\s*(\d+)/.exec(error);
  if (http) return `http-${http[1]}`;
  if (/ya existe/i.test(error)) return "already-exists";
  if (/Solo se permiten direcciones/i.test(error)) return "invalid-url";
  if (/contents are required/i.test(error)) return "api-validation";
  if (/Ning[uú]n proveedor/i.test(error)) return "no-provider";
  if (/cuota/i.test(error)) return "quota";
  return "other";
}

/** Quita los campos que pueden contener datos personales. */
function anonymize(record, drop) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (drop.includes(key)) continue;
    out[key] = value;
  }
  if (typeof record.utterance === "string") out.utteranceChars = record.utterance.length;
  if ("error" in record) out.errorKind = errorKind(record.error);
  return out;
}

/* ------------------------------------------------------------------ */
/* Principal                                                           */
/* ------------------------------------------------------------------ */

function main() {
  const metricsPath = join(dataDir, "metrics.jsonl");
  const auditPath = join(dataDir, "audit.jsonl");
  const metricsRaw = readJsonl(metricsPath);
  const auditRaw = readJsonl(auditPath);

  const meta = {
    dataDir,
    metrics: { records: metricsRaw.records.length, invalid: metricsRaw.invalid, missing: metricsRaw.missing },
    audit: { records: auditRaw.records.length, invalid: auditRaw.invalid, missing: auditRaw.missing },
  };

  mkdirSync(rawDir, { recursive: true });

  const metricsSummary = summarizeMetrics(metricsRaw.records);
  const auditSummary = summarizeAudit(auditRaw.records);

  const metricsCsv = metricsSummary.map((row) => ({
    accion: row.action,
    etiqueta: row.label,
    n: row.n,
    exitos: row.ok,
    fallos: row.failed,
    exito_pct: row.successRate,
    total_todas_p50_ms: row.totalAll.p50,
    total_todas_p95_ms: row.totalAll.p95,
    total_todas_max_ms: row.totalAll.max,
    total_exito_p50_ms: row.totalOk.p50,
    total_exito_p95_ms: row.totalOk.p95,
    total_exito_max_ms: row.totalOk.max,
    interpret_p50_ms: row.interpret.p50,
    interpret_p95_ms: row.interpret.p95,
    execute_p50_ms: row.execute.p50,
    execute_p95_ms: row.execute.p95,
    tts_p50_ms: row.tts.p50,
  }));

  const METRIC_COLUMNS = [
    "accion",
    "etiqueta",
    "n",
    "exitos",
    "fallos",
    "exito_pct",
    "total_todas_p50_ms",
    "total_todas_p95_ms",
    "total_todas_max_ms",
    "total_exito_p50_ms",
    "total_exito_p95_ms",
    "total_exito_max_ms",
    "interpret_p50_ms",
    "interpret_p95_ms",
    "execute_p50_ms",
    "execute_p95_ms",
    "tts_p50_ms",
  ];
  writeFileSync(join(outDir, "resumen-metricas.csv"), toCsv(METRIC_COLUMNS, metricsCsv), "utf8");
  writeFileSync(join(outDir, "resumen-metricas.md"), metricsMarkdown(metricsSummary, meta), "utf8");
  writeFileSync(
    join(outDir, "resumen-metricas.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), meta, metrics: metricsSummary }, null, 2)}\n`,
    "utf8",
  );

  const auditCsv = auditSummary.map((row) => ({
    accion: row.action,
    etiqueta: row.label,
    n: row.n,
    estados: Object.entries(row.statuses)
      .map(([status, count]) => `${status}:${count}`)
      .join(" "),
    p50_ms: row.latency.p50,
    p95_ms: row.latency.p95,
    max_ms: row.latency.max,
    confirmadas: row.confirmed,
  }));
  const AUDIT_COLUMNS = ["accion", "etiqueta", "n", "estados", "p50_ms", "p95_ms", "max_ms", "confirmadas"];
  writeFileSync(join(outDir, "resumen-auditoria.csv"), toCsv(AUDIT_COLUMNS, auditCsv), "utf8");
  writeFileSync(join(outDir, "resumen-auditoria.md"), auditMarkdown(auditSummary, meta), "utf8");

  writeFileSync(
    join(rawDir, "metrics-anon.jsonl"),
    metricsRaw.records.map((r) => JSON.stringify(anonymize(r, ["utterance", "error"]))).join("\n") + (metricsRaw.records.length ? "\n" : ""),
    "utf8",
  );
  writeFileSync(
    join(rawDir, "audit-anon.jsonl"),
    auditRaw.records.map((r) => JSON.stringify(anonymize(r, ["target", "summary"]))).join("\n") + (auditRaw.records.length ? "\n" : ""),
    "utf8",
  );

  /* Consola */
  console.log(`Datos: ${dataDir}`);
  if (metricsRaw.missing) {
    console.warn("AVISO: no existe metrics.jsonl; se escribieron tablas vacías.");
  }
  if (auditRaw.missing) {
    console.warn("AVISO: no existe audit.jsonl; se escribió la tabla vacía.");
  }
  console.log(
    `Métricas: ${metricsRaw.records.length} registros (${metricsRaw.invalid} ilegibles) · Auditoría: ${auditRaw.records.length} registros (${auditRaw.invalid} ilegibles)`,
  );

  console.log("\nAcción                 n   éxito  total p50  total p95  (solo éxito p50/p95)");
  for (const row of metricsSummary) {
    console.log(
      `${row.action.padEnd(22)} ${String(row.n).padStart(3)}  ${String(row.successRate ?? "—").padStart(5)}%  ${String(
        row.totalAll.p50 ?? "—",
      ).padStart(8)}  ${String(row.totalAll.p95 ?? "—").padStart(8)}  ${String(row.totalOk.p50 ?? "—").padStart(7)} / ${String(
        row.totalOk.p95 ?? "—",
      ).padStart(7)}`,
    );
  }

  console.log(`\nEscrito en ${outDir}`);
}

main();
