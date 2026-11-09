#!/usr/bin/env node
/**
 * Convierte los resultados de criterion (E2 y E3) en tablas versionables.
 *
 * criterion guarda cada medición en
 * `src-tauri/target/criterion/<grupo>/<funcion>/new/estimates.json`.
 * Este script los lee, les pone una etiqueta legible y escribe
 * `docs/perf/rust-bench.md` y `docs/perf/rust-bench.json`.
 *
 * Uso:
 *   npm run bench:rust
 *   node scripts/perf/criterion.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const criterionDir = resolve("src-tauri/target/criterion");
const outDir = resolve("docs/perf");

const LABELS = {
  "search_files_barrido/completo/1k": "Barrido completo · árbol 1k",
  "search_files_barrido/completo/5k-poda": "Barrido completo · árbol 5k + node_modules (poda)",
  "search_files_barrido/completo/20k": "Barrido completo · árbol 20k",
  "search_files_acierto/profundo-20k": "Acierto profundo · árbol 20k",
  "search_files_solo_carpetas/grupo-39-5k-poda": "Solo carpetas · árbol 5k + poda",
  "websearch_parse/duckduckgo-500kb": "Parser DuckDuckGo · página 500 KB",
  "websearch_parse/bing-500kb": "Parser Bing · página 500 KB",
  "websearch_parse/html-a-texto-500kb": "HTML a texto · página 500 KB",
};

const round = (value, digits = 2) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function humanMs(ns) {
  if (!Number.isFinite(ns)) return "—";
  const ms = ns / 1e6;
  if (ms >= 1000) return `${round(ms / 1000, 2)} s`;
  if (ms >= 1) return `${round(ms, 2)} ms`;
  return `${round(ms * 1000, 2)} µs`;
}

function findEstimates(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      findEstimates(path, found);
    } else if (entry === "estimates.json" && /[\\/]new[\\/]/.test(path)) {
      found.push(path);
    }
  }
  return found;
}

function throughputOf(benchmark) {
  if (!benchmark?.throughput) return null;
  const [unit, value] = Object.entries(benchmark.throughput)[0] ?? [];
  if (!unit || !value) return null;
  return { unit, value };
}

function main() {
  if (!existsSync(criterionDir)) {
    console.error(`No existe ${criterionDir}. Ejecute primero: npm run bench:rust`);
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const path of findEstimates(criterionDir)) {
    const id = path
      .slice(criterionDir.length + 1)
      .replace(/[\\/]new[\\/]estimates\.json$/, "")
      .replaceAll("\\", "/");
    const estimates = JSON.parse(readFileSync(path, "utf8"));
    const benchmarkPath = join(path.replace(/estimates\.json$/, "benchmark.json"));
    const benchmark = existsSync(benchmarkPath)
      ? JSON.parse(readFileSync(benchmarkPath, "utf8"))
      : null;
    const samplePath = join(path.replace(/estimates\.json$/, "sample.json"));
    const sample = existsSync(samplePath) ? JSON.parse(readFileSync(samplePath, "utf8")) : null;
    const throughput = throughputOf(benchmark);
    const median = estimates.median?.point_estimate ?? null;
    const mean = estimates.mean?.point_estimate ?? null;

    let rate = null;
    let rateUnit = "";
    if (throughput && median) {
      if (throughput.unit === "Bytes") {
        rate = round((throughput.value / (median / 1e9)) / 1e6, 2);
        rateUnit = "MB/s";
      } else {
        // Para árboles de archivos interesa el coste por entrada, no los
        // elementos por segundo (que son un número pequeño y poco legible).
        rate = round(median / throughput.value / 1e3, 2);
        rateUnit = "µs/entrada";
      }
    }

    rows.push({
      id,
      etiqueta: LABELS[id] ?? id,
      mediana_ns: round(median),
      media_ns: round(mean),
      ic95_bajo_ns: round(estimates.median?.confidence_interval?.lower_bound),
      ic95_alto_ns: round(estimates.median?.confidence_interval?.upper_bound),
      mediana: humanMs(median),
      throughput: rate,
      throughput_unit: rateUnit,
      muestras: Array.isArray(sample?.iters) ? sample.iters.length : null,
    });
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));

  const lines = [
    "# E2 y E3 · Benchmarks nativos (criterion)",
    "",
    `Generado: ${new Date().toISOString()}`,
    "",
    "Perfil `perf` (hereda de release: `opt-level = 3`, sin LTO). Cada fila",
    "resume la mediana de criterion con su intervalo de confianza del 95 %.",
    "",
    "| Benchmark | Mediana | IC 95 % | Media | Rendimiento |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const row of rows) {
    const ci =
      row.ic95_bajo_ns === null || row.ic95_alto_ns === null
        ? "—"
        : `${humanMs(row.ic95_bajo_ns)} – ${humanMs(row.ic95_alto_ns)}`;
    const rate = row.throughput === null ? "—" : `${row.throughput} ${row.throughput_unit}`;
    lines.push(`| ${row.etiqueta} | ${row.mediana} | ${ci} | ${humanMs(row.media_ns)} | ${rate} |`);
  }
  lines.push(
    "",
    "> El árbol de 20k tarda segundos porque `search_files` pide metadatos de",
    "> cada entrada (`symlink_metadata`) antes de comparar el nombre. El informe",
    "> de E2 explica el diagnóstico y su impacto.",
    "",
  );

  writeFileSync(join(outDir, "rust-bench.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "rust-bench.md"), `${lines.join("\n")}`, "utf8");

  console.log(`${rows.length} benchmarks leídos de ${criterionDir}`);
  for (const row of rows) {
    console.log(`  ${row.etiqueta.padEnd(52)} ${row.mediana.padStart(10)}`);
  }
  console.log(`\nEscrito en ${outDir}`);
}

main();
