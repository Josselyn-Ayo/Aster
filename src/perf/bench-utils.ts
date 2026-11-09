/**
 * Utilidades compartidas por los benchmarks de frontend (E1 y E4).
 *
 * `vitest` 5 ya no exporta `bench`, así que la medición se hace con
 * `tinybench` (la misma librería que usaba internamente) dentro de un `it()`.
 * Los resultados se imprimen y se anexan a `docs/perf/raw/frontend-bench.jsonl`
 * para que el informe pueda citarlos sin copiar cifras a mano.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Bench, Statistics } from "tinybench";

export interface BenchRow {
  suite: string;
  tarea: string;
  opsPorSegundo: number;
  mediaMs: number;
  medianaMs: number;
  p95Ms: number;
  maxMs: number;
  muestras: number;
}

const OUTPUT = resolve("docs/perf/raw/frontend-bench.jsonl");

function round(value: number, digits = 4): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

/** Percentil por rango más cercano sobre muestras ya ordenadas por tinybench. */
function percentile(samples: number[] | undefined, fraction: number): number {
  if (!samples?.length) return Number.NaN;
  const index = Math.min(samples.length - 1, Math.ceil(fraction * samples.length) - 1);
  return samples[Math.max(0, index)];
}

function collect(suite: string, bench: Bench): BenchRow[] {
  return bench.tasks.map((task) => {
    const result = task.result;
    const stats: Statistics | undefined =
      result && "latency" in result ? result.latency : undefined;
    return {
      suite,
      tarea: task.name,
      opsPorSegundo: Math.round(
        result && "throughput" in result ? result.throughput.mean : 0,
      ),
      mediaMs: round(stats?.mean ?? Number.NaN),
      medianaMs: round(stats?.p50 ?? Number.NaN),
      p95Ms: round(percentile(stats?.samples, 0.95)),
      maxMs: round(stats?.max ?? Number.NaN),
      muestras: stats?.samplesCount ?? 0,
    };
  });
}

/** Ejecuta el bench, imprime una tabla y persiste las filas en JSONL. */
export async function runBench(suite: string, bench: Bench): Promise<BenchRow[]> {
  await bench.run();
  const rows = collect(suite, bench);

  console.log(`\n### ${suite}`);
  console.table(
    rows.map(({ suite: _suite, ...row }) => row),
  );

  try {
    mkdirSync(dirname(OUTPUT), { recursive: true });
    for (const row of rows) {
      appendFileSync(
        OUTPUT,
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...row })}\n`,
        "utf8",
      );
    }
  } catch (error) {
    // Un fallo al escribir no debe invalidar la medición.
    console.warn(`No se pudo guardar ${OUTPUT}:`, error);
  }

  return rows;
}
