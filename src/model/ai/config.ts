/**
 * Configuración de IA del asistente (capa Model).
 *
 * Persiste en `aster.ai.config` y migra automáticamente la configuración
 * antigua de Gemini (`aster.gemini.config`). Las claves pueden venir de tres
 * sitios, por orden de prioridad:
 *
 *  1. La clave escrita por el usuario en Ajustes.
 *  2. El backend, que lee `.env` con `dotenvy` (`GROQ_API_KEY`, …). Así la
 *     clave no acaba incrustada en el bundle del frontend.
 *  3. `import.meta.env` (solo desarrollo en navegador, sin Tauri).
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AiConfig,
  Capability,
  ProviderCredentials,
  ProviderId,
  Route,
} from "./types";
import { CAPABILITIES } from "./types";

/** Clave nueva de la configuración. */
const STORAGE_KEY = "aster.ai.config";
/** Clave de la configuración anterior (solo lectura, para migrar). */
export const LEGACY_STORAGE_KEY = "aster.gemini.config";

/** Endpoints y variables de entorno por defecto de cada proveedor. */
export const DEFAULT_PROVIDERS: Record<ProviderId, ProviderCredentials> = {
  gemini: { apiKey: "", envVar: "GEMINI_API_KEY" },
  groq: {
    apiKey: "",
    envVar: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  openrouter: {
    apiKey: "",
    envVar: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  mistral: {
    apiKey: "",
    envVar: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
  },
  ollama: { baseUrl: "http://localhost:11434/v1" },
};

/**
 * Reparto por defecto: el texto y la voz van a Groq (cuota independiente de
 * Gemini) y Gemini se reserva para lo que solo él sabe hacer aquí —visión,
 * imágenes y búsqueda con Google—, que es lo que de verdad consume cuota.
 */
export const DEFAULT_ROUTES: Record<Capability, Route[]> = {
  router: [
    { provider: "groq", model: "openai/gpt-oss-20b" },
    { provider: "gemini", model: "gemini-3.5-flash-lite" },
  ],
  chat: [
    { provider: "groq", model: "openai/gpt-oss-120b" },
    { provider: "gemini", model: "gemini-3.5-flash-lite" },
  ],
  vision: [{ provider: "gemini", model: "gemini-3.5-flash-lite" }],
  transcribe: [
    { provider: "groq", model: "whisper-large-v3" },
    { provider: "gemini", model: "gemini-3.5-flash-lite" },
  ],
  image: [{ provider: "gemini", model: "gemini-3.1-flash-image" }],
  search: [{ provider: "gemini", model: "gemini-3.5-flash-lite" }],
};

const PROVIDER_IDS: ProviderId[] = ["gemini", "groq", "openrouter", "mistral", "ollama"];

/** ¿El modelo guardado ya no existe o es innecesariamente caro? */
function isOutdatedModel(model: string | undefined): boolean {
  if (!model) return true;
  return /^gemini-(1\.5|2\.0|2\.5)-/i.test(model) || model === "gemini-pro";
}

/** Copia profunda de la configuración por defecto. */
function defaults(): AiConfig {
  return {
    version: 2,
    providers: Object.fromEntries(
      PROVIDER_IDS.map((id) => [id, { ...DEFAULT_PROVIDERS[id] }]),
    ) as Record<ProviderId, ProviderCredentials>,
    routes: Object.fromEntries(
      CAPABILITIES.map((capability) => [
        capability,
        DEFAULT_ROUTES[capability].map((route) => ({ ...route })),
      ]),
    ) as Record<Capability, Route[]>,
  };
}

/** Migra la configuración antigua de un único proveedor (Gemini). */
function fromLegacy(legacy: Partial<{
  apiKey: string;
  model: string;
  transcriberModel: string;
  imageModel: string;
}>): AiConfig {
  const config = defaults();
  const model = isOutdatedModel(legacy.model) ? "gemini-3.5-flash-lite" : (legacy.model as string);
  const transcriber = isOutdatedModel(legacy.transcriberModel)
    ? "gemini-3.5-flash-lite"
    : (legacy.transcriberModel as string);

  config.providers.gemini.apiKey = legacy.apiKey ?? "";
  config.routes.router = [
    { provider: "groq", model: "openai/gpt-oss-20b" },
    { provider: "gemini", model: transcriber },
  ];
  config.routes.chat = [
    { provider: "groq", model: "openai/gpt-oss-120b" },
    { provider: "gemini", model },
  ];
  config.routes.vision = [{ provider: "gemini", model }];
  config.routes.transcribe = [
    { provider: "groq", model: "whisper-large-v3" },
    { provider: "gemini", model: transcriber },
  ];
  config.routes.image = [
    {
      provider: "gemini",
      // Imagen no está en la capa gratuita; los `gemini-*-image` sí.
      model:
        !legacy.imageModel || legacy.imageModel.startsWith("imagen-")
          ? "gemini-3.1-flash-image"
          : legacy.imageModel,
    },
  ];
  config.routes.search = [{ provider: "gemini", model }];
  return config;
}

/** ¿Es un proveedor conocido? */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as string[]).includes(value);
}

/** Rellena huecos de una configuración parcial o corrupta. */
function normalize(raw: Partial<AiConfig> | null | undefined): AiConfig {
  const config = defaults();
  if (!raw) return config;

  for (const id of PROVIDER_IDS) {
    const stored = raw.providers?.[id];
    if (stored && typeof stored === "object") {
      config.providers[id] = {
        ...config.providers[id],
        ...(typeof stored.apiKey === "string" ? { apiKey: stored.apiKey } : {}),
        ...(typeof stored.baseUrl === "string" ? { baseUrl: stored.baseUrl } : {}),
        ...(typeof stored.envVar === "string" ? { envVar: stored.envVar } : {}),
      };
    }
  }

  for (const capability of CAPABILITIES) {
    const stored = raw.routes?.[capability];
    if (!Array.isArray(stored)) continue;
    const routes = stored.filter(
      (route): route is Route =>
        Boolean(route) &&
        isProviderId((route as Route).provider) &&
        typeof (route as Route).model === "string" &&
        (route as Route).model.trim() !== "",
    );
    if (routes.length > 0) config.routes[capability] = routes;
  }
  return config;
}

/**
 * Carga la configuración de IA, migrando la antigua si hace falta.
 * Nunca lanza: ante datos corruptos devuelve los valores por defecto.
 */
export function loadAiConfig(): AiConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return normalize(JSON.parse(stored) as Partial<AiConfig>);
  } catch {
    /* configuración corrupta: se usan los valores por defecto */
  }

  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const migrated = fromLegacy(JSON.parse(legacy));
      saveAiConfig(migrated);
      return migrated;
    }
  } catch {
    /* la configuración antigua también puede estar corrupta */
  }
  return defaults();
}

/** Persiste la configuración y limpia la caché de claves de entorno. */
export function saveAiConfig(config: AiConfig): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(config)));
    }
  } catch {
    /* almacenamiento bloqueado o sin espacio: la sesión sigue con lo cargado */
  }
  envKeyCache.clear();
}

/** Credenciales de un proveedor con los valores por defecto aplicados. */
export function providerCredentials(provider: ProviderId): ProviderCredentials {
  return { ...DEFAULT_PROVIDERS[provider], ...loadAiConfig().providers[provider] };
}

/* ------------------------------------------------------------------ */
/* Resolución de claves                                                */
/* ------------------------------------------------------------------ */

/** Caché de claves leídas del entorno (no se piden en cada mensaje). */
const envKeyCache = new Map<ProviderId, string>();

/** Clave incrustada por Vite: solo para desarrollo en navegador. */
function buildTimeKey(provider: ProviderId): string {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const name = `VITE_${provider.toUpperCase()}_API_KEY`;
  // Gemini conserva además el nombre histórico `VITE_GEMINI_API_KEY`.
  const value = provider === "gemini" ? (env.VITE_GEMINI_API_KEY ?? env[name]) : env[name];
  return (value ?? "").trim();
}

/**
 * Devuelve la clave de un proveedor o cadena vacía si no hay ninguna.
 * Consulta primero Ajustes, luego el backend (`.env`) y por último Vite.
 */
export async function resolveApiKey(provider: ProviderId): Promise<string> {
  const explicit = loadAiConfig().providers[provider]?.apiKey?.trim();
  if (explicit) return explicit;

  const cached = envKeyCache.get(provider);
  if (cached !== undefined) return cached;

  let key = "";
  try {
    key = (await invoke<string | null>("provider_env_key", { provider }))?.trim() ?? "";
  } catch {
    /* fuera de Tauri (tests o navegador): se usa la clave de Vite */
  }
  if (!key) key = buildTimeKey(provider);

  envKeyCache.set(provider, key);
  return key;
}

/** Olvida las claves resueltas (tras cambiar `.env` o en pruebas). */
export function resetApiKeyCache(): void {
  envKeyCache.clear();
}
