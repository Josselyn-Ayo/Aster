/**
 * E4 — Coste de orquestación de `AsterController` sin red ni IPC.
 *
 * Se sustituyen los módulos de IA, IPC, automatización, auditoría e historial
 * por dobles de prueba. Así se mide solo el trabajo propio del controlador
 * (estado, mensajes, formateo, auditoría y métricas) y se separa del tiempo de
 * red del proveedor o del backend nativo.
 *
 * Ejecutar con `npm run bench`.
 */
import { Bench } from "tinybench";
import { describe, it, vi } from "vitest";

import { runBench } from "../perf/bench-utils";

const h = vi.hoisted(() => ({
  state: {
    intent: { type: "open_authorized_app", app: "Calculadora" } as unknown,
    confidence: 0.95,
  },
}));

vi.mock("../model/ai", () => ({
  interpret: async () => ({ intent: h.state.intent, confidence: h.state.confidence }),
  chat: async () => ({ text: "Respuesta de prueba del asistente." }),
  describeScreen: async () => ({ text: "Pantalla de prueba." }),
  generateImage: async () => ({ text: "Imagen.", imageDataUrl: "data:image/png;base64,AA==" }),
  webSearch: async () => ({
    answer: "Respuesta sintetizada de la búsqueda.",
    sources: [{ title: "Fuente de prueba", uri: "https://example.com" }],
  }),
}));

vi.mock("../services/automation/system", () => ({
  executeAutomation: async () => "Automatización ejecutada.",
  openUrl: async () => "https://example.com",
}));

vi.mock("../services/aster/commands", () => ({
  getProfile: async () => null,
  allowedRoots: async () => [],
  listAllowedApps: async () => [],
  openAuthorizedApp: async () => ({
    status: "success",
    message: "He abierto Calculadora.",
    resolvedTarget: "calc.exe",
  }),
  systemReport: async () => ({}),
  findFiles: async () => [
    {
      path: "C:\\Users\\dgcis\\Documents\\tesis.pdf",
      name: "tesis.pdf",
      isDirectory: false,
      sizeBytes: 1024,
      sizeLabel: "1 KB",
      modifiedAt: "2026-11-01T10:00:00Z",
      scope: "documents",
    },
  ],
  prepareFileOperation: async () => ({
    id: "op-1",
    action: "create_folder",
    title: "Crear carpeta",
    summary: "Crear carpeta en Documentos",
    details: [],
    requiresConfirmation: true,
    expiresAt: "2026-11-01T10:02:00Z",
  }),
  confirmFileOperation: async () => ({ status: "success", message: "Hecho.", affected: [] }),
  cancelFileOperation: async () => undefined,
  auditList: async () => [],
  auditStats: async () => ({
    total: 0,
    byAction: [],
    byStatus: [],
    confirmedOperations: 0,
    guardedOperations: 0,
    auditFile: "audit.jsonl",
  }),
  revealInFolder: async () => "",
}));

vi.mock("../services/aster/audit", () => ({
  recordAction: async () => ({ id: "a1", timestamp: "2026-11-01T10:00:00Z" }),
  recordMetric: async () => ({ id: "m1", timestamp: "2026-11-01T10:00:00Z" }),
  rateInteraction: async () => undefined,
}));

vi.mock("../services/history/store", () => ({
  saveCurrentSession: () => undefined,
}));

import { AsterController } from "./AsterController";

const speech = {
  start: async () => undefined,
  stopListening: () => undefined,
  say: async () => undefined,
  cancelSpeech: () => undefined,
  markProcessing: () => undefined,
  markIdle: () => undefined,
};

/**
 * Cada iteración crea un controlador nuevo para no acumular mensajes en el
 * historial (eso mediría el crecimiento del array, no el coste de la orden).
 */
function run(intent: unknown, text: string): Promise<void> {
  h.state.intent = intent;
  const controller = new AsterController();
  controller.setSpeech(speech);
  return controller.sendText(text);
}

describe("E4 · orquestación del controlador", () => {
  it("cuatro tipos de orden, sin red ni IPC", async () => {
    const bench = new Bench({ time: 500, warmupTime: 150, retainSamples: true });

    bench.add("abrir app autorizada", async () => {
      await run({ type: "open_authorized_app", app: "Calculadora" }, "abre la calculadora");
    });
    bench.add("buscar archivos", async () => {
      await run(
        { type: "find_files", query: "tesis", scope: "documents", foldersOnly: false },
        "busca tesis.pdf en documentos",
      );
    });
    bench.add("búsqueda web ya sintetizada", async () => {
      await run({ type: "web_search", query: "clima en Quito" }, "busca el clima en Quito");
    });
    bench.add("conversación", async () => {
      await run({ type: "conversation" }, "cuéntame algo interesante");
    });

    await runBench("E4-AsterController", bench);
  });
});
