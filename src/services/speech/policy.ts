/**
 * Política de voz (STT/TTS) y de almacenamiento de datos de Aster.
 *
 * - **STT**: motor local del navegador cuando está disponible; en su defecto,
 *   transcripción en la nube con Gemini a partir de un fragmento de audio que
 *   solo vive en memoria. El usuario puede fijar el motor o desactivar la
 *   transcripción en la nube.
 * - **TTS**: siempre local, con las voces SAPI del sistema. No se envía audio a
 *   ningún servicio y no se graba la salida sintetizada.
 * - **Almacenamiento**: el historial de conversación se limita a un número
 *   máximo de mensajes y a un máximo de días; el historial de acciones lo
 *   poda el backend según el perfil. **Las grabaciones de voz nunca se
 *   almacenan**, ni de forma temporal: el audio se descarta en cuanto el motor
 *   devuelve el texto.
 */

const STORAGE_KEY = "aster.speech.policy";

/** Motor de reconocimiento de voz. */
export type SttEngine = "auto" | "local" | "cloud";

export interface SpeechPolicy {
  /** Motor de transcripción preferido. */
  sttEngine: SttEngine;
  /** Permite enviar el audio al servicio de transcripción en la nube. */
  cloudSttEnabled: boolean;
  /** Idioma de reconocimiento. */
  sttLang: string;
  /** Lectura de la respuesta en voz alta. */
  ttsEnabled: boolean;
  /** Velocidad de la síntesis (0.5 – 2). */
  ttsRate: number;
  /** Tono de la síntesis (0 – 2). */
  ttsPitch: number;
  /** Descarta el audio grabado en cuanto se ha transcrito (siempre `true`). */
  voiceNeverStored: true;
  /** Conserva el historial de conversación en este dispositivo. */
  storeConversation: boolean;
  /** Número máximo de mensajes conservados en la conversación. */
  conversationLimit: number;
  /** Días máximos de conservación del historial de conversación. */
  conversationDays: number;
}

export const DEFAULT_SPEECH_POLICY: SpeechPolicy = {
  sttEngine: "auto",
  cloudSttEnabled: true,
  sttLang: "es-ES",
  ttsEnabled: true,
  ttsRate: 1,
  ttsPitch: 1,
  voiceNeverStored: true,
  storeConversation: true,
  conversationLimit: 200,
  conversationDays: 30,
};

/** Lee la política de voz, aplicando valores por omisión seguros. */
export function loadSpeechPolicy(): SpeechPolicy {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SPEECH_POLICY };
    const parsed = JSON.parse(raw) as Partial<SpeechPolicy>;
    return {
      ...DEFAULT_SPEECH_POLICY,
      ...parsed,
      // La voz nunca se almacena: es una invariante, no una preferencia.
      voiceNeverStored: true,
      conversationLimit: clamp(parsed.conversationLimit, 10, 1000, DEFAULT_SPEECH_POLICY.conversationLimit),
      conversationDays: clamp(parsed.conversationDays, 1, 365, DEFAULT_SPEECH_POLICY.conversationDays),
      ttsRate: clamp(parsed.ttsRate, 0.5, 2, 1),
      ttsPitch: clamp(parsed.ttsPitch, 0, 2, 1),
    };
  } catch {
    return { ...DEFAULT_SPEECH_POLICY };
  }
}

/** Persiste la política de voz. */
export function saveSpeechPolicy(policy: SpeechPolicy): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...policy, voiceNeverStored: true }));
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Decide si se puede usar la transcripción en la nube. Si el usuario la
 * desactiva, el asistente solo reconoce voz con el motor local y, si no está
 * disponible, pide escribir la orden en lugar de subir el audio.
 */
export function canUseCloudStt(policy = loadSpeechPolicy()): boolean {
  return policy.sttEngine !== "local" && policy.cloudSttEnabled;
}

/** Descripción de la política vigente, para mostrarla en Ajustes. */
export function describePolicy(policy = loadSpeechPolicy()): string[] {
  const stt =
    policy.sttEngine === "local"
      ? "Solo motor local del sistema"
      : policy.cloudSttEnabled
        ? "Motor local; si falla, transcripción en la nube con Gemini"
        : "Motor local; sin transcripción en la nube";
  return [
    `STT: ${stt} (${policy.sttLang}).`,
    "TTS: voces SAPI del sistema, sin conexión y sin grabación de la salida.",
    "Voz: el audio se mantiene en memoria y se descarta al transcribir; nunca se guarda.",
    policy.storeConversation
      ? `Conversación: hasta ${policy.conversationLimit} mensajes y ${policy.conversationDays} días en este dispositivo.`
      : "Conversación: no se guarda nada al cerrar la sesión.",
    "Acciones: registro de auditoría con retención configurable en Ajustes → Privacidad.",
  ];
}
