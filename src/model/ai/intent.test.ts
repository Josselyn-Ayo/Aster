/**
 * Tests del parseo de intenciones del modelo para las 8 acciones del catálogo.
 *
 * `parseRoutedIntent` es puro (sin API): verifica que cada JSON del modelo se
 * traduzca a la intención correcta, con reservas y confianzas sanas.
 */
import { describe, expect, it } from "vitest";
import { catalogInstructions, parseRoutedIntent } from "./chat";

describe("parseRoutedIntent: las 8 acciones", () => {
  it("1. open_authorized_app", () => {
    const routed = parseRoutedIntent(
      '{"type":"open_authorized_app","app":"Calculadora","confidence":0.9}',
      "abre la calculadora",
    );
    expect(routed).toEqual({
      intent: { type: "open_authorized_app", app: "Calculadora" },
      confidence: 0.9,
    });
  });

  it("2. web_search", () => {
    const routed = parseRoutedIntent(
      '{"type":"web_search","query":"precio del dólar","openSources":true,"confidence":0.8}',
      "busca el precio del dólar",
    );
    expect(routed).toEqual({
      intent: { type: "web_search", query: "precio del dólar", openSources: true },
      confidence: 0.8,
    });
  });

  it("3. system_info", () => {
    const routed = parseRoutedIntent(
      '{"type":"system_info","topic":"bateria","confidence":0.85}',
      "cuánta batería queda",
    );
    expect(routed).toEqual({
      intent: { type: "system_info", topic: "bateria" },
      confidence: 0.85,
    });
  });

  it("4. find_files", () => {
    const routed = parseRoutedIntent(
      '{"type":"find_files","query":"informe.pdf","scope":"documents","confidence":0.7}',
      "busca informe.pdf en documentos",
    );
    expect(routed).toEqual({
      intent: { type: "find_files", query: "informe.pdf", scope: "documents" },
      confidence: 0.7,
    });
  });

  it("4b. find_files con foldersOnly", () => {
    const routed = parseRoutedIntent(
      '{"type":"find_files","query":"Andi","scope":"downloads","foldersOnly":true,"confidence":0.8}',
      "busca la carpeta Andi en descargas",
    );
    expect(routed.intent).toMatchObject({
      type: "find_files",
      query: "Andi",
      scope: "downloads",
      foldersOnly: true,
    });
  });

  it("5. create_folder", () => {
    const routed = parseRoutedIntent(
      '{"type":"create_folder","path":"C:\\\\Users\\\\Ana\\\\Documents\\\\Pruebas","confidence":0.9}',
      "crea la carpeta Pruebas",
    );
    expect(routed.intent.type).toBe("create_folder");
    if (routed.intent.type === "create_folder") {
      expect(routed.intent.path).toContain("Pruebas");
    }
  });

  it("6. create_file", () => {
    const routed = parseRoutedIntent(
      '{"type":"create_file","path":"C:\\\\Users\\\\Ana\\\\Documents\\\\notas.txt","confidence":0.9}',
      "crea el archivo notas.txt",
    );
    expect(routed.intent.type).toBe("create_file");
    if (routed.intent.type === "create_file") {
      expect(routed.intent.path).toContain("notas.txt");
    }
  });

  it("7. move_files (filtra fuentes vacías)", () => {
    const routed = parseRoutedIntent(
      '{"type":"move_files","sources":["C:\\\\a.txt", "", 42],"destination":"C:\\\\Docs","confidence":0.75}',
      "mueve a.txt a Docs",
    );
    expect(routed).toEqual({
      intent: { type: "move_files", sources: ["C:\\a.txt"], destination: "C:\\Docs" },
      confidence: 0.75,
    });
  });

  it("8. action_history", () => {
    const routed = parseRoutedIntent(
      '{"type":"action_history","action":"move_files","limit":10,"confidence":0.9}',
      "qué archivos moví",
    );
    expect(routed).toEqual({
      intent: { type: "action_history", action: "move_files", limit: 10 },
      confidence: 0.9,
    });
  });
});

describe("parseRoutedIntent: reservas", () => {
  it("usa el texto del usuario cuando faltan campos", () => {
    const routed = parseRoutedIntent('{"type":"web_search","confidence":0.5}', "el clima");
    expect(routed).toEqual({
      intent: { type: "web_search", query: "el clima", openSources: false },
      confidence: 0.5,
    });
  });

  it("sujeta la confianza a [0,1] y usa 0.6 por defecto", () => {
    expect(
      parseRoutedIntent('{"type":"web_search","query":"x","confidence":2}', "x").confidence,
    ).toBe(1);
    expect(parseRoutedIntent('{"type":"web_search","query":"x"}', "x").confidence).toBe(0.6);
    expect(parseRoutedIntent('{"type":"conversation"}', "hola").confidence).toBe(0.5);
  });

  it("tipo desconocido -> conversación", () => {
    const routed = parseRoutedIntent('{"type":"volar","confidence":0.9}', "vuela");
    expect(routed.intent.type).toBe("conversation");
  });

  it("JSON roto -> conversación de baja confianza", () => {
    expect(parseRoutedIntent("no es json {", "hola")).toEqual({
      intent: { type: "conversation" },
      confidence: 0.4,
    });
  });

  it("automation/vision/image siguen funcionando", () => {
    expect(
      parseRoutedIntent('{"type":"automation","kind":"youtube","target":"rock"}', "x").intent,
    ).toEqual({ type: "automation", action: { kind: "youtube", target: "rock" } });
    expect(
      parseRoutedIntent('{"type":"vision","question":"q"}', "x").intent,
    ).toEqual({ type: "vision", question: "q" });
    expect(
      parseRoutedIntent('{"type":"image","prompt":"p"}', "x").intent,
    ).toEqual({ type: "image", prompt: "p" });
  });
});

describe("catalogInstructions: contexto acotado", () => {
  const context = {
    allowedRoots: ["C:\\Docs", "C:\\Desk"],
    allowedApps: Array.from({ length: 100 }, (_, i) => `App ${i}`),
  };

  it("trunca la lista blanca a 30 + aviso", () => {
    const lines = catalogInstructions(context, { wantsApps: true, wantsFiles: false }).join("\n");
    expect(lines).toContain("App 29");
    expect(lines).not.toContain("App 30");
    expect(lines).toContain("y 70 más");
  });

  it("omite apps y rutas cuando no se necesitan", () => {
    const lines = catalogInstructions(context, { wantsApps: false, wantsFiles: false }).join("\n");
    expect(lines).not.toContain("App 0");
    expect(lines).not.toContain("C:\\Docs");
  });

  it("incluye raíces solo si hay contexto de archivos", () => {
    const lines = catalogInstructions(context, { wantsApps: false, wantsFiles: true }).join("\n");
    expect(lines).toContain("C:\\Docs");
  });
});

describe("parseRoutedIntent: respuestas no estrictas", () => {
  it("acepta el JSON envuelto en un bloque ```json", () => {
    const routed = parseRoutedIntent(
      '```json\n{"type":"system_info","topic":"memoria","confidence":0.8}\n```',
      "¿cuánta memoria tengo?",
    );
    expect(routed.intent).toEqual({ type: "system_info", topic: "memoria" });
  });

  it("acepta texto alrededor del objeto JSON", () => {
    const routed = parseRoutedIntent(
      'Claro: {"type":"conversation"}\nEspero que ayude.',
      "hola",
    );
    expect(routed.intent.type).toBe("conversation");
  });
});
