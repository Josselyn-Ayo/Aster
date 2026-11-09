/**
 * Servicio de IA de ASTER (capa Model).
 *
 * Es la puerta de entrada que usa el Controlador. Traduce el historial y las
 * peticiones del asistente a las capacidades del registro (`runAi`), sin saber
 * qué proveedor las atiende.
 */
import { invoke } from "@tauri-apps/api/core";
import type { AiResult, ChatMessage } from "../../types";
import {
  DEFAULT_SYSTEM_PROMPT,
  catalogInstructions,
  fastRoute,
  parseRoutedIntent,
  wantsAppList,
  wantsFileContext,
  type RoutedIntent,
  type RoutingContext,
} from "./chat";
import { runAi } from "./registry";
import type { TextResponse } from "./types";

export { fastRoute, parseRoutedIntent, isQuotaError } from "./chat";
export type { Intent, RoutedIntent, RoutingContext } from "./chat";

/** Límites para no quemar cuota: historial corto y respuestas acotadas. */
const MAX_HISTORY_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 800;
const CHAT_MAX_OUTPUT_TOKENS = 512;
// 256 y no 128: los modelos de razonamiento (gpt-oss) agotan 128 tokens antes
// de emitir el JSON y Groq devuelve 400 «json_validate_failed».
const ROUTER_MAX_OUTPUT_TOKENS = 256;

/** Prompt de personalidad vigente (Ajustes puede sobrescribirlo). */
let systemPrompt = DEFAULT_SYSTEM_PROMPT;

/** Permite sobrescribir la personalidad de ASTER desde la interfaz. */
export function setSystemPrompt(prompt: string): void {
  systemPrompt = prompt.trim() || DEFAULT_SYSTEM_PROMPT;
}

/**
 * Convierte el historial de la UI en turnos de texto. Las imágenes generadas
 * (base64) no se reenvían: suman miles de tokens por turno.
 */
function toTurns(history: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return history
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content && !m.streaming)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    }));
}

/**
 * Envía el historial al modelo configurado y devuelve la respuesta.
 * Si se adjunta una imagen, la petición pasa por la capacidad de visión.
 */
export async function chat(
  history: ChatMessage[],
  extraImageBase64?: string,
): Promise<AiResult> {
  const turns = toTurns(history);

  if (extraImageBase64) {
    const question = [...turns].reverse().find((turn) => turn.role === "user")?.content ?? "¿Qué ves?";
    const result = await runAi<TextResponse>("vision", {
      imageBase64: extraImageBase64,
      mimeType: "image/png",
      question,
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    });
    return { text: result.text };
  }

  if (turns.length === 0) turns.push({ role: "user", content: "Hola" });

  const result = await runAi<TextResponse>("chat", {
    messages: turns,
    system: systemPrompt,
    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    temperature: 0.7,
  });
  return { text: result.text };
}

/** Transcribe una orden de voz (respaldo cuando no hay Web Speech API). */
export async function transcribeAudio(
  audioBase64: string,
  mimeType = "audio/webm",
): Promise<string> {
  const result = await runAi<TextResponse>("transcribe", {
    audioBase64,
    mimeType,
  });
  return result.text;
}

/**
 * Interpreta la intención de una orden. Primero intenta la vía rápida local
 * (0 tokens) y solo si es ambigua consulta al modelo.
 */
export async function interpret(
  userText: string,
  context?: RoutingContext,
): Promise<RoutedIntent> {
  const fast = fastRoute(userText, context);
  if (fast) return fast;

  const instructions = context
    ? catalogInstructions(context, {
        wantsApps: wantsAppList(userText),
        wantsFiles: wantsFileContext(userText),
      })
    : [];

  const result = await runAi<TextResponse>("router", {
    messages: [
      {
        role: "user",
        content: [
          "Clasifica la siguiente orden de un usuario de un asistente de escritorio.",
          "Responde EXCLUSIVAMENTE con un JSON sin texto adicional.",
          "Esquema de respuesta:",
          '{"type":"conversation"}',
          '{"type":"automation","target":"<texto o nombre>","kind":"youtube|spotify|launch_app|open_url"}',
          '{"type":"vision","question":"<pregunta sobre la pantalla>"}',
          '{"type":"image","prompt":"<descripción de la imagen a generar>"}',
          "Reglas:",
          "- Si pide abrir/reproducir en YouTube o Spotify -> automation (kind youtube si menciona YouTube/video, kind spotify si menciona Spotify).",
          "- Si pide abrir una aplicación local -> open_authorized_app si es por nombre, o automation kind launch_app si es ejecutable (.exe).",
          "- Si pide abrir una URL web (http:// o https://) -> automation (kind open_url).",
          '- Si pregunta sobre lo que hay en la pantalla -> vision (incluye frases como "qué ves", "pantalla", "qué estoy viendo").',
          "- Si pide dibujar/crear/generar una imagen -> image.",
          "- Cualquier otra cosa -> conversation.",
          ...instructions,
          `Orden del usuario: ${userText.slice(0, 1000)}`,
        ].join("\n"),
      },
    ],
    maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
    temperature: 0,
    json: true,
  });

  return parseRoutedIntent(result.text, userText);
}

/** Captura de pantalla comprimida que devuelve el backend. */
interface ScreenCapture {
  base64: string;
  mimeType: string;
}

/** Captura la pantalla principal ya redimensionada (JPEG). */
export async function captureScreen(): Promise<ScreenCapture> {
  return invoke<ScreenCapture>("capture_screen_jpeg");
}

/** Analiza la pantalla actual y devuelve la respuesta del modelo. */
export async function describeScreen(
  question = "¿Qué estás viendo en mi pantalla?",
): Promise<AiResult> {
  const capture = await captureScreen();
  const result = await runAi<TextResponse>("vision", {
    imageBase64: capture.base64,
    mimeType: capture.mimeType,
    question:
      "Eres la visión multimodal de ASTER. Analiza la captura de pantalla del escritorio del usuario y responde " +
      `de forma conversacional a su pregunta. Pregunta del usuario: "${question}". ` +
      "Describe lo que ves con detalle y naturalidad.",
    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
  });
  return { text: result.text };
}

/** Genera una imagen a partir de una descripción. */
export async function generateImage(prompt: string): Promise<AiResult> {
  const result = await runAi<{ text: string; imageDataUrl: string }>("image", { prompt });
  return { text: result.text, imageDataUrl: result.imageDataUrl };
}

/**
 * Búsqueda en Internet sintetizada, con sus fuentes.
 * La implementación vive en `search.ts`: primero búsqueda local sin cuota.
 */
export { webSearch } from "./search";
