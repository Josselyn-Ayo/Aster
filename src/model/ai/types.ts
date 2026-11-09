/**
 * Contratos del dominio de IA (capa Model).
 *
 * La aplicación no habla con un proveedor concreto: pide una **capacidad**
 * (`chat`, `vision`, `transcribe`, `image`, `search`, `router`) y el registro
 * resuelve qué proveedor la atiende según la configuración y, si falla, cuál
 * es el siguiente de la cadena. Así se puede repartir la cuota entre Gemini,
 * Groq, OpenRouter, Mistral u Ollama sin tocar la lógica del asistente.
 */

/** Proveedores soportados por el registro. */
export type ProviderId = "gemini" | "groq" | "openrouter" | "mistral" | "ollama";

/** Tareas que el asistente delega en un modelo. */
export type Capability = "router" | "chat" | "vision" | "transcribe" | "image" | "search";

/** Lista canónica de capacidades, en el orden que muestra Ajustes. */
export const CAPABILITIES: Capability[] = [
  "chat",
  "router",
  "vision",
  "transcribe",
  "image",
  "search",
];

/** Etiquetas legibles de cada capacidad. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  chat: "Conversación",
  router: "Interpretación de órdenes",
  vision: "Visión de pantalla",
  transcribe: "Transcripción de voz",
  image: "Generación de imágenes",
  search: "Búsqueda en Internet",
};

/** Credenciales y endpoint de un proveedor. */
export interface ProviderCredentials {
  /** Clave escrita por el usuario en Ajustes (tiene prioridad). */
  apiKey?: string;
  /** Endpoint base (OpenAI-compatible). Vacío en Gemini, que usa su SDK. */
  baseUrl?: string;
  /** Variable de entorno que el backend leerá si no hay `apiKey`. */
  envVar?: string;
}

/** Un eslabón de la cadena: proveedor + modelo. */
export interface Route {
  provider: ProviderId;
  model: string;
}

/** Configuración completa de IA, persistida en `aster.ai.config`. */
export interface AiConfig {
  version: 2;
  providers: Record<ProviderId, ProviderCredentials>;
  /** Cadena ordenada por capacidad: el primero es el principal. */
  routes: Record<Capability, Route[]>;
}

/* ------------------------------------------------------------------ */
/* Peticiones y respuestas por capacidad                               */
/* ------------------------------------------------------------------ */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatTurn[];
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Pide al modelo una respuesta JSON estricta. */
  json?: boolean;
}

export interface VisionRequest {
  imageBase64: string;
  mimeType: string;
  question: string;
  maxOutputTokens?: number;
}

export interface TranscribeRequest {
  audioBase64: string;
  mimeType: string;
}

export interface ImageRequest {
  prompt: string;
}

export interface SearchRequest {
  query: string;
}

export interface TextResponse {
  text: string;
}

export interface ImageResponse {
  text: string;
  imageDataUrl: string;
}

/** Fuente citada por la búsqueda en Internet. */
export interface SearchSource {
  uri: string;
  title: string;
}

export interface SearchResponse {
  answer: string;
  sources: SearchSource[];
}

/** Credenciales ya resueltas que recibe un proveedor en cada llamada. */
export interface ProviderContext {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** Adaptador de un proveedor. Solo implementa lo que sabe hacer. */
export interface AiProvider {
  id: ProviderId;
  label: string;
  /** Si exige clave (Ollama en local no). */
  requiresKey: boolean;
  supports: Capability[];
  chat?(request: ChatRequest, ctx: ProviderContext): Promise<TextResponse>;
  vision?(request: VisionRequest, ctx: ProviderContext): Promise<TextResponse>;
  transcribe?(request: TranscribeRequest, ctx: ProviderContext): Promise<TextResponse>;
  image?(request: ImageRequest, ctx: ProviderContext): Promise<ImageResponse>;
  search?(request: SearchRequest, ctx: ProviderContext): Promise<SearchResponse>;
  /** Modelos disponibles, para el botón «Probar conexión» de Ajustes. */
  listModels?(ctx: ProviderContext): Promise<string[]>;
}

/** Error HTTP normalizado de cualquier proveedor. */
export class AiProviderError extends Error {
  readonly status: number;

  constructor(provider: ProviderId, status: number, detail: string) {
    super(`${provider} respondió ${status}: ${detail}`.trim());
    this.name = "AiProviderError";
    this.status = status;
  }
}
