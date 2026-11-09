/**
 * Registro de proveedores y cadena de respaldo (capa Model).
 *
 * `runAi` recorre la cadena configurada para una capacidad y devuelve la
 * primera respuesta válida. Reglas:
 *
 *  - Sin clave o sin soporte para esa capacidad: se salta al siguiente.
 *  - `429` (cuota) y `401/403` (clave): se salta al siguiente **sin reintentar**.
 *  - `503` (caído): un reintento con espera y, si sigue, al siguiente.
 *  - `400` (petición inválida): se lanza, porque fallará en todos.
 */
import { loadAiConfig, resolveApiKey } from "./config";
import { PROVIDERS } from "./providers";
import { recordUsage } from "./usage";
import type { AiConfig, AiProvider, Capability, ProviderContext, ProviderId } from "./types";
import { AiProviderError } from "./types";

/** Dependencias intercambiables (las pruebas inyectan las suyas). */
export interface AiRuntime {
  config: () => AiConfig;
  providers: Record<ProviderId, AiProvider>;
  key: (provider: ProviderId) => Promise<string>;
}

const defaultRuntime: AiRuntime = {
  config: loadAiConfig,
  providers: PROVIDERS,
  key: resolveApiKey,
};

/** Capacidad -> método del adaptador que la implementa. */
const METHOD: Record<Capability, keyof AiProvider> = {
  router: "chat",
  chat: "chat",
  vision: "vision",
  transcribe: "transcribe",
  image: "image",
  search: "search",
};

/** Error final cuando ningún proveedor de la cadena respondió. */
export class AiUnavailableError extends Error {
  /** Status representativo: 429 si el último problema fue de cuota. */
  readonly status: number;
  readonly attempts: string[];

  constructor(capability: Capability, attempts: string[], status: number) {
    super(
      attempts.length === 0
        ? `No hay ningún proveedor configurado para «${capability}».`
        : `Ningún proveedor pudo atender «${capability}». ${attempts.join(" · ")}`,
    );
    this.name = "AiUnavailableError";
    this.status = status;
    this.attempts = attempts;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function statusOf(error: unknown): number {
  if (error instanceof AiProviderError) return error.status;
  const candidate = error as { status?: number; code?: number; statusCode?: number };
  const code = candidate?.status ?? candidate?.code ?? candidate?.statusCode;
  return typeof code === "number" ? code : 0;
}

/** ¿Vale la pena probar el siguiente proveedor con este error? */
export function shouldFallback(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 400) return false;
  return true;
}

function shortMessage(error: unknown): string {
  const status = statusOf(error);
  if (status === 429) return "límite de cuota (429)";
  if (status === 401 || status === 403) return "clave rechazada";
  if (status === 404) return "modelo no encontrado";
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}

/** Reintenta una vez ante 503 (servicio no disponible). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (statusOf(error) !== 503) throw error;
    await sleep(800);
    return fn();
  }
}

/** ¿La respuesta llegó vacía? (el modelo se quedó sin tokens o bloqueó). */
function isEmptyAnswer(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const text = (result as { text?: unknown }).text;
  return typeof text === "string" && text.trim() === "";
}

/**
 * Ejecuta `request` en la primera ruta utilizable de la capacidad indicada.
 * El resultado se contabiliza en el medidor local de consumo.
 */
export async function runAi<T>(
  capability: Capability,
  request: unknown,
  runtime: AiRuntime = defaultRuntime,
): Promise<T> {
  const config = runtime.config();
  const routes = config.routes[capability] ?? [];
  const attempts: string[] = [];
  let sawQuota = false;

  for (const route of routes) {
    const provider = runtime.providers[route.provider];
    const label = `${route.provider}/${route.model}`;
    if (!provider) {
      attempts.push(`${label}: proveedor desconocido`);
      continue;
    }

    const method = METHOD[capability];
    const fn = provider[method] as
      | ((req: unknown, ctx: ProviderContext) => Promise<unknown>)
      | undefined;
    const required = capability === "router" ? "chat" : capability;
    if (typeof fn !== "function" || !provider.supports.includes(required)) {
      attempts.push(`${label}: no soporta ${capability}`);
      continue;
    }

    const apiKey = await runtime.key(route.provider);
    if (provider.requiresKey && !apiKey) {
      attempts.push(`${label}: falta la clave`);
      continue;
    }

    const ctx: ProviderContext = {
      apiKey,
      model: route.model,
      baseUrl: config.providers[route.provider]?.baseUrl ?? "",
    };

    try {
      const result = await withRetry(() => fn(request, ctx));
      // Un texto vacío en chat/router/visión es un fallo silencioso (tokens
      // agotados, filtro de seguridad): se intenta el siguiente proveedor.
      const expectsText =
        capability === "chat" || capability === "router" || capability === "vision";
      if (expectsText && isEmptyAnswer(result)) {
        attempts.push(`${label}: respuesta vacía`);
        continue;
      }
      recordUsage(route.provider, capability);
      return result as T;
    } catch (error) {
      if (statusOf(error) === 429) sawQuota = true;
      const quota = statusOf(error) === 429;
      attempts.push(
        quota
          ? `${label}: cuota agotada`
          : `${label}: ${shortMessage(error)}`,
      );
      if (!shouldFallback(error)) throw error;
    }
  }

  throw new AiUnavailableError(capability, attempts, sawQuota ? 429 : 0);
}
