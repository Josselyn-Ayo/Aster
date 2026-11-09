/**
 * Módulo de Reconocimiento de Voz (Speech-to-Text) de ASTER.
 *
 * Estrategia en dos niveles:
 *  1. Web Speech API (`SpeechRecognition`) cuando el motor (WebView2/Chromium)
 *     la expone: reconocimiento local y gratuíto.
 *  2. Fallback: captura de audio con `MediaRecorder`, conversión a Base64 y
 *     transcripción mediante el modelo multimodal de Gemini.
 */
import { isTauri } from "@tauri-apps/api/core";
import { transcribeAudio } from "../../model/ai";

type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

/** Detección del constructor de reconocimiento expuesto por el motor. */
function getRecognitionCtor(): (new () => RecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const ctor =
    w.SpeechRecognition ??
    w.webkitSpeechRecognition ??
    w.msSpeechRecognition ??
    null;
  return (ctor as (new () => RecognitionLike) | null | undefined) ?? null;
}

export interface SttSession {
  stop: () => void;
  abort: () => void;
}

interface SpeechRecognitionEventLike {
  readonly results: ArrayLike<{
    readonly isFinal: boolean;
    readonly length: number;
    0: { transcript: string };
    [n: number]: { transcript: string };
  }>;
}

/**
 * Indica si la Web Speech API de reconocimiento está disponible y funcional.
 * En WebView2 (Tauri), Chromium expone `webkitSpeechRecognition` pero carece
 * de las claves de Google Cloud Speech, por lo que siempre falla con error 'network'.
 * Por tanto, dentro de Tauri se reporta false para usar directamente MediaRecorder + Gemini.
 */
export function isNativeSttAvailable(): boolean {
  try {
    if (isTauri()) return false;
  } catch {
    /* si falla la comprobación, continúa */
  }
  return getRecognitionCtor() !== null;
}

/**
 * Inicia una sesión de reconocimiento de voz nativo.
 * Llama a `onFinal(transcript)` con el texto final reconocido.
 */
export function startNativeStt(
  lang: string,
  onFinal: (text: string) => void,
  onError?: (error: string) => void,
  onEnd?: () => void,
): SttSession {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    throw new Error("Web Speech API no disponible en este motor.");
  }

  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = lang;

  recognition.onresult = (event) => {
    const e = event as SpeechRecognitionEventLike;
    let finalText = "";
    for (let i = 0; i < e.results.length; i += 1) {
      const result = e.results[i];
      if (result.isFinal) {
        finalText += result[0].transcript;
      }
    }
    if (finalText) {
      onFinal(finalText);
    }
  };

  recognition.onerror = (event) => {
    const e = event as { error?: string };
    onError?.(e.error ?? "unknown");
  };

  recognition.onend = () => onEnd?.();

  recognition.start();
  return {
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
  };
}

/** Convierte un Blob de audio a Base64 sin bucles lentos ni desbordamiento de pila. */
export async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== "undefined") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = (reader.result as string) || "";
        const commaIndex = dataUrl.indexOf(",");
        resolve(commaIndex !== -1 ? dataUrl.slice(commaIndex + 1) : dataUrl);
      };
      reader.onerror = () => reject(reader.error ?? new Error("Error leyendo blob de audio"));
      reader.readAsDataURL(blob);
    });
  }

  const buffer = await blob.arrayBuffer();
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Transcribe una orden de voz capturada por `MediaRecorder` usando Gemini.
 * Se usa como respaldo o como motor principal cuando la Web Speech API no está disponible.
 */
export async function transcribeRecordedBlob(blob: Blob): Promise<string> {
  const base64 = await blobToBase64(blob);
  // Limpia parámetros como ';codecs=opus' para que la API multimodal reciba el MIME puro
  const rawType = blob.type || "audio/webm";
  const cleanMime = rawType.split(";")[0].trim() || "audio/webm";
  return transcribeAudio(base64, cleanMime);
}
