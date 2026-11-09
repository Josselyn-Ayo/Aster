/**
 * Catálogo de proveedores disponibles.
 *
 * Añadir uno nuevo con API compatible con OpenAI es una línea aquí: la
 * configuración (`aster.ai.config`) y los ajustes se generan a partir de este
 * registro.
 */
import { geminiProvider } from "./gemini";
import { createOpenAiProvider } from "./openai";
import type { AiProvider, ProviderId } from "../types";

export const PROVIDERS: Record<ProviderId, AiProvider> = {
  gemini: geminiProvider,
  groq: createOpenAiProvider("groq", "Groq", ["chat", "transcribe"]),
  openrouter: createOpenAiProvider("openrouter", "OpenRouter", ["chat", "vision"]),
  mistral: createOpenAiProvider("mistral", "Mistral", ["chat", "vision"]),
  ollama: createOpenAiProvider("ollama", "Ollama (local)", ["chat", "vision"], false),
};

/** Proveedores que aparecen en Ajustes, en orden. */
export const PROVIDER_IDS: ProviderId[] = [
  "gemini",
  "groq",
  "openrouter",
  "mistral",
  "ollama",
];
