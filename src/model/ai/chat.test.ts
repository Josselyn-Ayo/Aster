/**
 * Tests del enrutado local de ASTER (sin llamadas a la API).
 *
 * `fastRoute` debe resolver los casos obvios sin gastar tokens y devolver
 * `null` cuando conviene consultar al modelo.
 */
import { describe, expect, it } from "vitest";
import { fastRoute, extractFileSearch, isQuotaError } from "./chat";

const context = {
  allowedRoots: ["C:\\Users\\Ana\\Documents", "C:\\Users\\Ana\\Downloads"],
  allowedApps: ["Google Chrome", "Bloc de notas", "Calculadora"],
};

describe("fastRoute", () => {
  it("resuelve YouTube sin LLM", () => {
    const routed = fastRoute("Reproduce en YouTube: música para programar", context);
    expect(routed?.intent.type).toBe("automation");
    if (routed?.intent.type === "automation") {
      expect(routed.intent.action.kind).toBe("youtube");
    }
  });

  it("resuelve Spotify sin LLM", () => {
    const routed = fastRoute("Reproduce en Spotify: jazz", context);
    expect(routed?.intent.type).toBe("automation");
    if (routed?.intent.type === "automation") {
      expect(routed.intent.action.kind).toBe("spotify");
    }
  });

  it("resuelve visión de pantalla sin LLM", () => {
    const routed = fastRoute("¿Qué ves en mi pantalla?", context);
    expect(routed?.intent.type).toBe("vision");
  });

  it("resuelve generación de imágenes sin LLM", () => {
    const routed = fastRoute("Dibuja un dragón futurista", context);
    expect(routed?.intent.type).toBe("image");
  });

  it("resuelve 'abre X' contra la lista blanca", () => {
    const routed = fastRoute("Abre Google Chrome", context);
    expect(routed).toMatchObject({
      intent: { type: "open_authorized_app", app: "Google Chrome" },
    });
  });

  it("resuelve 'abre X' con prefijo de invocación ('Asisther, abre Google Chrome')", () => {
    const routed = fastRoute("Asisther, abre Google Chrome.", context);
    expect(routed).toMatchObject({
      intent: { type: "open_authorized_app", app: "Google Chrome" },
    });
  });

  it("resuelve URLs directas como open_url", () => {
    const routed = fastRoute("Abre https://example.com/docs", context);
    expect(routed?.intent.type).toBe("automation");
    if (routed?.intent.type === "automation") {
      expect(routed.intent.action.kind).toBe("open_url");
    }
  });

  it("ataja la charla simple como conversación", () => {
    expect(fastRoute("hola", context)?.intent.type).toBe("conversation");
    expect(fastRoute("gracias", context)?.intent.type).toBe("conversation");
  });

  it("resuelve saludos formales como conversación (0 tokens)", () => {
    expect(fastRoute("buenos días", context)?.intent.type).toBe("conversation");
    expect(fastRoute("buenas tardes", context)?.intent.type).toBe("conversation");
    expect(fastRoute("muchas gracias", context)?.intent.type).toBe("conversation");
  });

  it("resuelve búsqueda en internet explícita como web_search (0 tokens)", () => {
    const routed = fastRoute("busca en internet el precio del bitcoin", context);
    expect(routed?.intent.type).toBe("web_search");
    if (routed?.intent.type === "web_search") {
      expect(routed.intent.query).toContain("bitcoin");
    }
  });

  it("resuelve búsqueda en google como web_search (0 tokens)", () => {
    const routed = fastRoute("busca en google últimas noticias de tecnología", context);
    expect(routed?.intent.type).toBe("web_search");
  });

  it("resuelve búsqueda de archivos local como find_files (0 tokens)", () => {
    const routed = fastRoute("busca en descargas estudios de casos", context);
    expect(routed?.intent.type).toBe("find_files");
    if (routed?.intent.type === "find_files") {
      expect(routed.intent.scope).toBe("downloads");
      expect(routed.intent.query).toContain("estudios");
    }
  });

  it("resuelve 'busca tesis.pdf en documentos' como find_files (0 tokens)", () => {
    const routed = fastRoute("busca tesis.pdf en documentos", context);
    expect(routed?.intent.type).toBe("find_files");
    if (routed?.intent.type === "find_files") {
      expect(routed.intent.scope).toBe("documents");
      expect(routed.intent.query).toContain("tesis.pdf");
    }
  });

  it("resuelve 'encuentra el archivo notas.txt' como find_files (0 tokens)", () => {
    const routed = fastRoute("encuentra el archivo notas.txt", context);
    expect(routed?.intent.type).toBe("find_files");
    if (routed?.intent.type === "find_files") {
      expect(routed.intent.query).toContain("notas.txt");
    }
  });

  it("resuelve un nombre de archivo suelto como find_files (0 tokens)", () => {
    const routed = fastRoute("hola.pdf", context);
    expect(routed?.intent.type).toBe("find_files");
    if (routed?.intent.type === "find_files") {
      expect(routed.intent.query).toBe("hola.pdf");
      expect(routed.intent.scope).toBe("all");
    }
  });

  it("resuelve una extensión suelta con ámbito como find_files (0 tokens)", () => {
    const routed = fastRoute(".PDF en descargas", context);
    expect(routed?.intent.type).toBe("find_files");
    if (routed?.intent.type === "find_files") {
      expect(routed.intent.query).toBe(".PDF");
      expect(routed.intent.scope).toBe("downloads");
    }
  });

  it("no trata 'abre hola.pdf' como búsqueda de archivos", () => {
    expect(fastRoute("abre hola.pdf", context)?.intent.type).not.toBe("find_files");
  });

  it("busca solo carpetas cuando se pide una carpeta", () => {
    const routed = fastRoute("Busca la carpeta Andi en Descargas", context);
    expect(routed?.intent.type).toBe("find_files");
    if (routed?.intent.type === "find_files") {
      expect(routed.intent.query).toBe("Andi");
      expect(routed.intent.scope).toBe("downloads");
      expect(routed.intent.foldersOnly).toBe(true);
    }
  });

  it("no filtra por carpetas cuando se pide un archivo", () => {
    const routed = fastRoute("busca planes.pdf en descargas", context);
    expect(routed?.intent.type).toBe("find_files");
    if (routed?.intent.type === "find_files") {
      expect(routed.intent.foldersOnly).toBe(false);
    }
  });

  it("resuelve historial de acciones (0 tokens)", () => {
    const routed = fastRoute("historial", context);
    expect(routed?.intent.type).toBe("action_history");
  });

  it("resuelve 'qué hiciste' como action_history (0 tokens)", () => {
    const routed = fastRoute("qué hiciste", context);
    expect(routed?.intent.type).toBe("action_history");
  });

  it("resuelve 'muestra las últimas acciones' como action_history (0 tokens)", () => {
    const routed = fastRoute("muestra las últimas acciones", context);
    expect(routed?.intent.type).toBe("action_history");
  });

  it("resuelve 'resumen del sistema' como system_info (0 tokens)", () => {
    const routed = fastRoute("resumen del sistema", context);
    expect(routed?.intent.type).toBe("system_info");
  });

  it("resuelve batería como system_info:bateria (0 tokens)", () => {
    const routed = fastRoute("dime cuánta batería queda", context);
    expect(routed?.intent.type).toBe("system_info");
    if (routed?.intent.type === "system_info") {
      expect(routed.intent.topic).toBe("bateria");
    }
  });

  it("resuelve creación de carpeta simple (0 tokens)", () => {
    const routed = fastRoute("crea una carpeta llamada Proyectos", context);
    expect(routed?.intent.type).toBe("create_folder");
    if (routed?.intent.type === "create_folder") {
      // Sin ámbito se usa Documentos, como indica el catálogo.
      expect(routed.intent.path).toBe("C:\\Users\\Ana\\Documents\\Proyectos");
    }
  });

  it("crea la carpeta dentro del ámbito indicado", () => {
    const routed = fastRoute("crea una carpeta llamada Pruebas en Documentos", context);
    expect(routed?.intent.type).toBe("create_folder");
    if (routed?.intent.type === "create_folder") {
      expect(routed.intent.path).toBe("C:\\Users\\Ana\\Documents\\Pruebas");
    }
  });

  it("crea un archivo con extensión en el ámbito indicado", () => {
    const routed = fastRoute("crea un archivo llamado notas.txt en Descargas", context);
    expect(routed?.intent.type).toBe("create_file");
    if (routed?.intent.type === "create_file") {
      expect(routed.intent.path).toBe("C:\\Users\\Ana\\Downloads\\notas.txt");
    }
  });

  it("resuelve 'busca el clima en Quito' como web_search (0 tokens)", () => {
    const routed = fastRoute("busca el clima en Quito", context);
    expect(routed?.intent.type).toBe("web_search");
    if (routed?.intent.type === "web_search") {
      expect(routed.intent.query).toBe("el clima en Quito");
    }
  });

  it("no confunde búsqueda de archivo con búsqueda en internet", () => {
    const routed = fastRoute("busca en internet música clásica", context);
    expect(routed?.intent.type).toBe("web_search");
  });

  it("devuelve null en lo ambiguo (pide LLM)", () => {
    expect(fastRoute("organiza mis archivos", context)).toBeNull();
  });
});

describe("extractFileSearch", () => {
  it("extrae ámbito al principio: 'en descargas X'", () => {
    const r = extractFileSearch("busca en descargas estudios de casos metodológicos");
    expect(r?.scope).toBe("downloads");
    expect(r?.query).toContain("estudios");
  });

  it("extrae ámbito al principio: 'descargas X' (sin preposición)", () => {
    const r = extractFileSearch("busca descargas informe.pdf");
    expect(r?.scope).toBe("downloads");
    expect(r?.query).toContain("informe.pdf");
  });

  it("extrae ámbito al final: 'X en documentos'", () => {
    const r = extractFileSearch("busca tesis en documentos");
    expect(r?.scope).toBe("documents");
    expect(r?.query).toBe("tesis");
  });

  it("extrae sin ámbito (scope=all)", () => {
    const r = extractFileSearch("encuentra el archivo notas.txt");
    expect(r?.scope).toBe("all");
    expect(r?.query).toContain("notas.txt");
  });

  it("limpia artículo 'el archivo' del query", () => {
    const r = extractFileSearch("busca el archivo reporte.pdf");
    expect(r?.query).toBe("reporte.pdf");
  });

  it("limpia artículo 'la carpeta' del query", () => {
    const r = extractFileSearch("localiza la carpeta proyectos");
    expect(r?.query).toBe("proyectos");
    expect(r?.foldersOnly).toBe(true);
  });

  it("devuelve null para búsquedas en internet", () => {
    expect(extractFileSearch("busca en internet el precio del bitcoin")).toBeNull();
    expect(extractFileSearch("busca en youtube música reggae")).toBeNull();
  });

  it("devuelve null para 'busca <tema>' sin pistas de archivo", () => {
    // Sin extensión, ámbito ni la palabra archivo/carpeta debe ir a Internet.
    expect(extractFileSearch("busca el clima en Quito")).toBeNull();
    expect(extractFileSearch("busca noticias de hoy")).toBeNull();
  });

  it("devuelve null para texto sin verbo de búsqueda", () => {
    expect(extractFileSearch("abre google chrome")).toBeNull();
    expect(extractFileSearch("crea una carpeta")).toBeNull();
  });

  it("acepta un nombre de archivo suelto sin verbo", () => {
    const r = extractFileSearch("hola.pdf");
    expect(r?.scope).toBe("all");
    expect(r?.query).toBe("hola.pdf");
  });

  it("acepta una extensión suelta con ámbito", () => {
    const r = extractFileSearch(".PDF en descargas");
    expect(r?.scope).toBe("downloads");
    expect(r?.query).toBe(".PDF");
  });

  it("acepta un nombre de archivo con ámbito al final", () => {
    const r = extractFileSearch("hola.pdf en descargas");
    expect(r?.scope).toBe("downloads");
    expect(r?.query).toBe("hola.pdf");
  });

  it("devuelve null para 'un PDF' (sin nombre ni extensión)", () => {
    expect(extractFileSearch("un PDF")).toBeNull();
    expect(extractFileSearch("a punto PDF")).toBeNull();
  });
});

describe("isQuotaError", () => {
  it("detecta Error con mensaje 429", () => {
    expect(isQuotaError(new Error("Request failed with status 429"))).toBe(true);
  });

  it("detecta Error con texto resource_exhausted", () => {
    expect(isQuotaError(new Error("RESOURCE_EXHAUSTED: You exceeded your current quota"))).toBe(true);
  });

  it("detecta objeto con code 429", () => {
    expect(isQuotaError({ code: 429, message: "Quota exceeded" })).toBe(true);
  });

  it("detecta objeto con status 429", () => {
    expect(isQuotaError({ status: 429 })).toBe(true);
  });

  it("no confunde errores normales", () => {
    expect(isQuotaError(new Error("Network error"))).toBe(false);
    expect(isQuotaError({ code: 503 })).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });
});

describe("fastRoute: atajo conversacional (Fase 0)", () => {
  it("una pregunta simple se resuelve sin consultar al router", () => {
    const routed = fastRoute("¿qué es la computación cuántica?", context);
    expect(routed?.intent.type).toBe("conversation");
  });

  it("un saludo con cortesía no gasta una llamada de router", () => {
    const routed = fastRoute("Aster, buenos días", context);
    expect(routed?.intent.type).toBe("conversation");
  });

  it("pero una pregunta sobre archivos sí consulta al router", () => {
    expect(fastRoute("¿dónde está el archivo del proyecto?", context)).toBeNull();
  });

  it("una pregunta sobre aplicaciones también consulta al router", () => {
    expect(fastRoute("¿puedes abrir la calculadora?", context)).toBeNull();
  });

  it("una pregunta sobre la pantalla va a visión, no a conversación", () => {
    const routed = fastRoute("¿qué ves en mi pantalla?", context);
    expect(routed?.intent.type).toBe("vision");
  });
});
