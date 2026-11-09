/**
 * Tests de la configuración de IA.
 *
 * Cubren la migración desde `aster.gemini.config` (los usuarios que ya tenían
 * Gemini configurado no deben perder su clave) y la tolerancia a datos
 * corruptos: la aplicación tiene que arrancar siempre.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ROUTES, LEGACY_STORAGE_KEY, loadAiConfig, saveAiConfig } from "./config";

/** `localStorage` mínimo para el entorno de pruebas (Node). */
function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    },
  });
  return data;
}

describe("configuración de IA", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = installStorage();
  });

  it("sin nada guardado devuelve el reparto recomendado", () => {
    const config = loadAiConfig();
    expect(config.version).toBe(2);
    expect(config.routes.chat[0]).toEqual(DEFAULT_ROUTES.chat[0]);
    // El texto va primero a Groq para no gastar la cuota de Gemini.
    expect(config.routes.chat[0].provider).toBe("groq");
    expect(config.routes.vision[0].provider).toBe("gemini");
    expect(config.routes.image[0].provider).toBe("gemini");
  });

  it("migra la configuración antigua de Gemini sin perder la clave", () => {
    storage.set(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        apiKey: "AIza-vieja",
        model: "gemini-3.5-flash-lite",
        transcriberModel: "gemini-3.5-flash-lite",
        imageModel: "imagen-4.0-generate-001",
      }),
    );

    const config = loadAiConfig();

    expect(config.providers.gemini.apiKey).toBe("AIza-vieja");
    // El respaldo de Gemini sigue ahí, pero ya no es el primero.
    expect(config.routes.chat[0].provider).toBe("groq");
    expect(config.routes.chat[1]).toEqual({
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
    });
    // Imagen no está en la capa gratuita: se migra a un modelo `*-image`.
    expect(config.routes.image[0].model).toBe("gemini-3.1-flash-image");
    // La migración se persiste para no repetirla en cada arranque.
    expect(storage.has("aster.ai.config")).toBe(true);
  });

  it("sustituye modelos obsoletos al migrar", () => {
    storage.set(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ apiKey: "k", model: "gemini-2.5-flash", transcriberModel: "gemini-2.0-flash" }),
    );

    const config = loadAiConfig();
    expect(config.routes.chat[1].model).toBe("gemini-3.5-flash-lite");
    expect(config.routes.transcribe[1].model).toBe("gemini-3.5-flash-lite");
  });

  it("tolera una configuración corrupta", () => {
    storage.set("aster.ai.config", "{esto no es json");
    expect(() => loadAiConfig()).not.toThrow();
    expect(loadAiConfig().routes.chat[0].provider).toBe("groq");
  });

  it("descarta rutas con proveedores desconocidos al normalizar", () => {
    saveAiConfig({
      version: 2,
      providers: {
        gemini: { apiKey: "" },
        groq: { apiKey: "" },
        openrouter: { apiKey: "" },
        mistral: { apiKey: "" },
        ollama: { baseUrl: "http://localhost:11434/v1" },
      },
      routes: {
        chat: [
          { provider: "inventado" as never, model: "x" },
          { provider: "groq", model: "openai/gpt-oss-120b" },
        ],
        router: [{ provider: "groq", model: "openai/gpt-oss-20b" }],
        vision: [{ provider: "gemini", model: "gemini-3.5-flash-lite" }],
        transcribe: [{ provider: "groq", model: "whisper-large-v3" }],
        image: [{ provider: "gemini", model: "imagen-4.0-generate-001" }],
        search: [{ provider: "gemini", model: "gemini-3.5-flash-lite" }],
      },
    });

    const config = loadAiConfig();
    expect(config.routes.chat).toHaveLength(1);
    expect(config.routes.chat[0].provider).toBe("groq");
  });

  it("rellena proveedores que falten en una configuración parcial", () => {
    storage.set(
      "aster.ai.config",
      JSON.stringify({ version: 2, providers: { groq: { apiKey: "gsk-test" } } }),
    );

    const config = loadAiConfig();
    expect(config.providers.groq.apiKey).toBe("gsk-test");
    expect(config.providers.gemini).toBeDefined();
    expect(config.providers.ollama.baseUrl).toContain("11434");
  });
});
