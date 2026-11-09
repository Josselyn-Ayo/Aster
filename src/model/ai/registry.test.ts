/**
 * Tests de la cadena de respaldo (`runAi`).
 *
 * Se inyecta un `AiRuntime` falso: ninguna prueba toca la red. Lo que se
 * verifica es la política de saltos, que es lo que evita quemar cuota:
 * sin clave se salta, 429 se salta sin reintentar, 400 se propaga y, si todo
 * falla, el error agregado conserva el 429 para que la interfaz avise de cuota.
 */
import { describe, expect, it, vi } from "vitest";
import { AiUnavailableError, runAi, shouldFallback, type AiRuntime } from "./registry";
import { DEFAULT_PROVIDERS } from "./config";
import type { AiConfig, AiProvider, Capability, ProviderId, Route } from "./types";
import { AiProviderError, CAPABILITIES } from "./types";

const EMPTY_ROUTES = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, []]),
) as unknown as Record<Capability, Route[]>;

function configWith(routes: Partial<Record<Capability, Route[]>>): AiConfig {
  return {
    version: 2,
    providers: DEFAULT_PROVIDERS,
    routes: { ...EMPTY_ROUTES, ...routes },
  };
}

function fakeProvider(id: ProviderId, chat: AiProvider["chat"]): AiProvider {
  return {
    id,
    label: id,
    requiresKey: true,
    supports: ["chat", "vision", "transcribe"],
    chat,
  };
}

function runtime(options: {
  routes: Route[];
  providers: Record<ProviderId, AiProvider>;
  keys?: Partial<Record<ProviderId, string>>;
}): AiRuntime {
  return {
    config: () => configWith({ chat: options.routes }),
    providers: options.providers,
    key: async (provider) => options.keys?.[provider] ?? "test-key",
  };
}

/** Proveedor que siempre falla con el status indicado. */
function failing(id: ProviderId, status: number) {
  const chat = vi.fn(async () => {
    throw new AiProviderError(id, status, "fallo simulado");
  });
  return { provider: fakeProvider(id, chat), chat };
}

const neverCalled = () => fakeProvider("mistral", vi.fn(async () => ({ text: "no" })));

describe("runAi: cadena de respaldo", () => {
  it("usa el primer proveedor disponible sin tocar el segundo", async () => {
    const first = fakeProvider("groq", vi.fn(async () => ({ text: "hola" })));
    const second = fakeProvider("gemini", vi.fn(async () => ({ text: "adiós" })));

    const result = await runAi<{ text: string }>(
      "chat",
      { messages: [{ role: "user", content: "hola" }] },
      runtime({
        routes: [
          { provider: "groq", model: "m1" },
          { provider: "gemini", model: "m2" },
        ],
        providers: { ...providersOf(), groq: first, gemini: second },
      }),
    );

    expect(result.text).toBe("hola");
    expect(second.chat).not.toHaveBeenCalled();
  });

  it("salta un proveedor sin clave", async () => {
    const groq = fakeProvider("groq", vi.fn(async () => ({ text: "groq" })));
    const gemini = fakeProvider("gemini", vi.fn(async () => ({ text: "gemini" })));

    const result = await runAi<{ text: string }>(
      "chat",
      { messages: [] },
      runtime({
        routes: [
          { provider: "groq", model: "m1" },
          { provider: "gemini", model: "m2" },
        ],
        providers: { ...providersOf(), groq, gemini },
        keys: { groq: "", gemini: "clave-gemini" },
      }),
    );

    expect(result.text).toBe("gemini");
    expect(groq.chat).not.toHaveBeenCalled();
  });

  it("con 429 pasa al siguiente SIN reintentar", async () => {
    const groq = failing("groq", 429);
    const gemini = fakeProvider("gemini", vi.fn(async () => ({ text: "respaldo" })));

    const result = await runAi<{ text: string }>(
      "chat",
      { messages: [] },
      runtime({
        routes: [
          { provider: "groq", model: "m1" },
          { provider: "gemini", model: "m2" },
        ],
        providers: { ...providersOf(), groq: groq.provider, gemini },
      }),
    );

    expect(result.text).toBe("respaldo");
    expect(groq.chat).toHaveBeenCalledTimes(1);
  });

  it("si todo falla por cuota, el error agregado conserva el 429", async () => {
    const groq = failing("groq", 429);
    const gemini = failing("gemini", 429);

    const error = await runAi(
      "chat",
      { messages: [] },
      runtime({
        routes: [
          { provider: "groq", model: "m1" },
          { provider: "gemini", model: "m2" },
        ],
        providers: { ...providersOf(), groq: groq.provider, gemini: gemini.provider },
      }),
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AiUnavailableError);
    expect((error as AiUnavailableError).status).toBe(429);
    expect((error as AiUnavailableError).message).toContain("cuota");
  });

  it("un 400 se propaga sin probar el respaldo (la petición está mal)", async () => {
    const groq = failing("groq", 400);
    const gemini = fakeProvider("gemini", vi.fn(async () => ({ text: "no debería" })));

    await expect(
      runAi(
        "chat",
        { messages: [] },
        runtime({
          routes: [
            { provider: "groq", model: "m1" },
            { provider: "gemini", model: "m2" },
          ],
          providers: { ...providersOf(), groq: groq.provider, gemini },
        }),
      ),
    ).rejects.toBeInstanceOf(AiProviderError);

    expect(gemini.chat).not.toHaveBeenCalled();
  });

  it("un 503 reintenta una vez el mismo proveedor", async () => {
    const chat = vi.fn(
      async (): Promise<{ text: string }> => ({ text: "recuperado" }),
    );
    chat.mockRejectedValueOnce(new AiProviderError("groq", 503, "caído"));
    const groq = fakeProvider("groq", chat);

    const result = await runAi<{ text: string }>(
      "chat",
      { messages: [] },
      runtime({ routes: [{ provider: "groq", model: "m1" }], providers: { ...providersOf(), groq } }),
    );

    expect(result.text).toBe("recuperado");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("una respuesta vacía cuenta como fallo y pasa al respaldo", async () => {
    const groq = fakeProvider("groq", vi.fn(async () => ({ text: "   " })));
    const gemini = fakeProvider("gemini", vi.fn(async () => ({ text: "contenido" })));

    const result = await runAi<{ text: string }>(
      "chat",
      { messages: [] },
      runtime({
        routes: [
          { provider: "groq", model: "m1" },
          { provider: "gemini", model: "m2" },
        ],
        providers: { ...providersOf(), groq, gemini },
      }),
    );

    expect(result.text).toBe("contenido");
    expect(groq.chat).toHaveBeenCalledTimes(1);
  });

  it("sin rutas configuradas lanza un error claro", async () => {
    await expect(
      runAi("chat", { messages: [] }, runtime({ routes: [], providers: providersOf() })),
    ).rejects.toThrow(/No hay ningún proveedor configurado/);
  });
});

describe("shouldFallback", () => {
  it("no reintenta con 400, sí con 429/503/red", () => {
    expect(shouldFallback(new AiProviderError("groq", 400, "bad request"))).toBe(false);
    expect(shouldFallback(new AiProviderError("groq", 429, "quota"))).toBe(true);
    expect(shouldFallback(new AiProviderError("groq", 503, "unavailable"))).toBe(true);
    expect(shouldFallback(new TypeError("Failed to fetch"))).toBe(true);
  });
});

/** Resto de proveedores del registro: nunca se usan en estas pruebas. */
function providersOf(): Record<ProviderId, AiProvider> {
  return {
    gemini: neverCalled(),
    groq: neverCalled(),
    openrouter: neverCalled(),
    mistral: neverCalled(),
    ollama: neverCalled(),
  };
}
