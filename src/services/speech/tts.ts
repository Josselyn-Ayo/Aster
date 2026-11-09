/**
 * Módulo de Síntesis de Voz (Text-to-Speech) de ASTER.
 *
 * Utiliza el `speechSynthesis` del motor WebView2/Chromium, que en Windows
 * expone las voces SAPI instaladas en el sistema. Esto permite la síntesis
 * de voz local y offline (sin necesidad de conexión a internet).
 */
import type { ListeningState } from "../../types";
import type { SpeechPolicy } from "./policy";
import { loadSpeechPolicy } from "./policy";

/** Da prioridad a las voces en español (es-ES, es-MX, es-419, etc.). */
export function pickSpanishVoice(policy?: SpeechPolicy): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) {
    return null;
  }
  const wanted = (policy?.sttLang ?? "es").toLowerCase();
  const spanish = voices.find((v) => v.lang.toLowerCase().startsWith("es"));
  const exact = voices.find((v) => v.lang.toLowerCase() === wanted);
  return exact ?? spanish ?? voices[0] ?? null;
}

let queued: string | null = null;
let playing = false;
let queue: Array<() => void> = [];

/**
 * La carga de voces del WebView2 es asíncrona; esta función espera a que la
 * lista esté disponible antes de usarla.
 */
function ensureVoicesLoaded(): Promise<void> {
  return new Promise((resolve) => {
    if (window.speechSynthesis.getVoices().length > 0) {
      resolve();
      return;
    }
    window.speechSynthesis.addEventListener("voiceschanged", () => resolve(), { once: true });
  });
}

export let voiceState: ListeningState = "idle";

function emitState(state: ListeningState): void {
  voiceState = state;
  queue.forEach((cb) => cb());
}

/** Registra un observador de cambios de estado de la voz. */
export function onVoiceStateChange(cb: () => void): () => void {
  queue.push(cb);
  return () => {
    queue = queue.filter((fn) => fn !== cb);
  };
}

/**
 * Limpia el texto para la síntesis de voz: el chat puede contener markdown,
 * enlaces y URLs que no deben leerse en voz alta. Devuelve texto plano corto.
 */
export function sanitizeForSpeech(text: string): string {
  let out = text;
  // Bloques de código -> mención breve.
  out = out.replace(/```[\s\S]*?```/g, " [código] ");
  // Enlaces [título](url) -> solo el título.
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1");
  // Las fuentes van como enlaces clicables en el chat; en voz sobran.
  out = out.split(/\n\nFuentes:/)[0];
  // URLs sueltas fuera de enlaces.
  out = out.replace(/https?:\/\/[^\s]+/g, "");
  // Marcas de markdown y tablas.
  out = out.replace(/[*_#>`|]/g, "");
  out = out.replace(/\s+/g, " ").trim();
  // Las respuestas largas se recortan en voz (el texto completo queda en el chat).
  return out.slice(0, 800);
}

function speakText(text: string, onEnd: () => void, policy: SpeechPolicy): void {
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickSpanishVoice(policy);
  utterance.lang = voice?.lang ?? policy.sttLang ?? "es-ES";
  if (voice) {
    utterance.voice = voice;
  }
  utterance.rate = policy.ttsRate;
  utterance.pitch = policy.ttsPitch;

  playing = true;
  emitState("speaking");

  utterance.onend = () => {
    playing = false;
    onEnd();
  };
  utterance.onerror = () => {
    playing = false;
    onEnd();
  };

  window.speechSynthesis.speak(utterance);
}

/**
 * Sintetiza el texto en voz. Interrumpe cualquier síntesis previa (cortando
 * la actuación del asistente si el usuario habla por encima).
 */
export async function speak(
  text: string,
  onEnd?: () => void,
  policy: SpeechPolicy = loadSpeechPolicy(),
): Promise<void> {
  await ensureVoicesLoaded();

  if (playing || window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
  }

  // Se habla la versión limpia: sin markdown, URLs ni sección de fuentes.
  const clean = sanitizeForSpeech(text);
  if (!clean) {
    onEnd?.();
    return;
  }

  queued = clean;
  speakText(clean, () => {
    queued = null;
    emitState("idle");
    onEnd?.();
  }, policy);
}

/** Cancela la síntesis de voz en curso. */
export function stopSpeaking(): void {
  window.speechSynthesis.cancel();
  playing = false;
  queued = null;
  emitState("idle");
}

/** Devuelve el texto que se está leyendo actualmente (si existe). */
export function getCurrentUtterance(): string | null {
  return queued;
}
