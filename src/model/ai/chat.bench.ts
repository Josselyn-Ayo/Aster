/**
 * E1 — Enrutado local (0 tokens).
 *
 * Mide las funciones puras que resuelven una orden sin consultar al modelo:
 * `fastRoute`, `extractFileSearch` y `parseRoutedIntent`. Son la promesa de
 * diseño «cero llamadas para los casos obvios»; si alguna se degrada, este
 * benchmark lo muestra antes de que el usuario lo note.
 *
 * Ejecutar con `npm run bench` (no forma parte de `npm test`).
 */
import { Bench } from "tinybench";
import { describe, it } from "vitest";

import { runBench } from "../../perf/bench-utils";
import { extractFileSearch, fastRoute, parseRoutedIntent } from "./chat";

const context = {
  allowedRoots: [
    "C:\\Users\\dgcis\\Documents",
    "C:\\Users\\dgcis\\Downloads",
    "C:\\Users\\dgcis\\Desktop",
  ],
  allowedApps: ["Google Chrome", "Spotify", "Calculadora", "Word", "Excel", "Notepad"],
};

const orders = [
  ["app", "Abre Google Chrome"],
  ["archivo", "busca tesis.pdf en documentos"],
  ["carpeta", "busca la carpeta Andi"],
  ["web", "busca el clima en Quito"],
  ["charla", "hola, ¿cómo estás?"],
  ["historial", "qué hiciste"],
  ["sistema", "resumen del sistema"],
] as const;

const fileQueries = [
  "busca tesis.pdf en documentos",
  "encuentra el archivo notas.txt",
  "busca la carpeta Andi",
  "en descargas factura 2026",
  "busca .pdf en escritorio",
] as const;

const ROUTER_JSON =
  '{"type":"find_files","query":"tesis","scope":"documents","foldersOnly":false,"confidence":0.92}';

function newBench(): Bench {
  return new Bench({ time: 500, warmupTime: 150, retainSamples: true });
}

describe("E1 · enrutado local", () => {
  it("fastRoute: 7 órdenes del catálogo", async () => {
    const bench = newBench();
    for (const [name, text] of orders) {
      bench.add(name, () => {
        fastRoute(text, context);
      });
    }
    bench.add("lote de 7", () => {
      for (const [, text] of orders) fastRoute(text, context);
    });
    await runBench("E1-fastRoute", bench);
  });

  it("extractFileSearch: 5 consultas de archivos", async () => {
    const bench = newBench();
    for (const [index, text] of fileQueries.entries()) {
      bench.add(`caso-${index + 1}`, () => {
        extractFileSearch(text);
      });
    }
    await runBench("E1-extractFileSearch", bench);
  });

  it("parseRoutedIntent: respuesta del router", async () => {
    const bench = newBench();
    bench.add("find_files válido", () => {
      parseRoutedIntent(ROUTER_JSON, "busca la tesis");
    });
    bench.add("conversación", () => {
      parseRoutedIntent('{"type":"conversation"}', "cuéntame algo");
    });
    bench.add("JSON roto", () => {
      parseRoutedIntent("{esto no es json}", "haz algo");
    });
    await runBench("E1-parseRoutedIntent", bench);
  });
});
