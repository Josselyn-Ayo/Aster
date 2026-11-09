/**
 * Hook de voz de ASTER: gestiona el micrófono (escucha activa), la síntesis
 * de voz y el estado global de la interfaz (idle / listening / speaking).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isNativeSttAvailable,
  startNativeStt,
  transcribeRecordedBlob,
  type SttSession,
} from "../services/speech/stt";
import { speak, stopSpeaking, onVoiceStateChange } from "../services/speech/tts";
import { canUseCloudStt, loadSpeechPolicy } from "../services/speech/policy";
import { isQuotaError } from "../model/ai";
import type { ListeningState } from "../types";

export interface UseSpeechOptions {
  /** Idioma de reconocimiento, p. ej. "es-ES". */
  lang?: string;
  /** Se invoca con cada texto final reconocido por la voz. */
  onTranscript: (text: string, meta: SttMeta) => void;
}

/** Metadatos de una transcripción, usados para medir la latencia de STT. */
export interface SttMeta {
  /** Milisegundos desde que se encendió el micrófono hasta el texto. */
  sttMs: number;
  /** Motor que produjo el texto. */
  engine: "local" | "cloud";
}

export function useSpeech({ lang, onTranscript }: UseSpeechOptions) {
  const [state, setState] = useState<ListeningState>("idle");
  const sessionRef = useRef<SttSession | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isAbortedRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // Momento en que se encendió el micrófono, para medir la latencia de STT.
  const listeningSinceRef = useRef(0);
  const defaultLang = lang;

  // Sincroniza el estado de la voz (TTS) con el estado global.
  useEffect(() => {
    const unsub = onVoiceStateChange(() => {
      setState((prev) => (prev === "idle" ? "idle" : prev));
    });
    return unsub;
  }, []);

  /** Inicia la grabación por MediaRecorder con detección de actividad de voz (VAD) y Gemini STT. */
  const startRecording = useCallback(async () => {
    isAbortedRef.current = false;
    chunksRef.current = [];

    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : MediaRecorder.isTypeSupported("audio/mp4")
            ? "audio/mp4"
            : "";

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (isAbortedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      const audioCtx = new AudioContext();
      // Garantiza que el AudioContext esté activo para alimentar el analizador
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      let hasDetectedVoice = false;
      let silenceStart: number | null = null;
      let levelTimer: number | null = null;
      const recordingStart = performance.now();

      // Umbrales de detección de voz y silencios
      const VOICE_THRESHOLD = 8; // Umbral de pico de frecuencia (0..255) sensible a cualquier micrófono
      const SILENCE_AFTER_VOICE_MS = 1500; // 1.5s de silencio continuo tras hablar
      const INITIAL_MAX_SILENCE_MS = 9000; // 9s máximos de espera inicial antes de comenzar
      const MAX_RECORDING_MS = 25000; // Límite de seguridad total (25s)

      let initialTimedOut = false;

      const checkLevel = () => {
        if (recorder.state === "inactive") return;

        analyser.getByteFrequencyData(data);
        const peak = Math.max(...data);
        const elapsed = performance.now() - recordingStart;

        // 1. Límite de tiempo máximo
        if (elapsed >= MAX_RECORDING_MS) {
          recorder.stop();
          return;
        }

        if (peak >= VOICE_THRESHOLD) {
          hasDetectedVoice = true;
          silenceStart = null;
        } else {
          if (hasDetectedVoice) {
            // Ya habló; ahora está en silencio
            if (silenceStart === null) {
              silenceStart = performance.now();
            } else if (performance.now() - silenceStart >= SILENCE_AFTER_VOICE_MS) {
              recorder.stop();
              return;
            }
          } else {
            // Todavía no ha empezado a hablar
            if (elapsed >= INITIAL_MAX_SILENCE_MS) {
              initialTimedOut = true;
              recorder.stop();
              return;
            }
          }
        }

        levelTimer = window.setTimeout(checkLevel, 100);
      };

      recorder.onstop = async () => {
        if (levelTimer !== null) window.clearTimeout(levelTimer);
        audioCtx.close().catch(() => {});
        stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;

        if (isAbortedRef.current) {
          setState("idle");
          return;
        }

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });

        // Si expiró el tiempo inicial sin detectar voz y no hubo interacción manual
        if (initialTimedOut && !hasDetectedVoice && blob.size < 3000) {
          console.log("[ASTER-speech] tiempo de espera inicial agotado sin voz; volviendo a reposo");
          setState("idle");
          return;
        }

        if (blob.size < 500) {
          console.log("[ASTER-speech] audio insuficiente; volviendo a reposo");
          setState("idle");
          return;
        }

        setState("processing");
        console.log("[ASTER-speech] grabado", blob.size, "bytes; transcribiendo…");
        let transcriptError: unknown = null;
        const text = await transcribeRecordedBlob(blob).catch((e) => {
          transcriptError = e;
          console.error("[ASTER-speech] error transcribiendo:", e);
          return "";
        });
        console.log("[ASTER-speech] transcripción:", text || "(vacía)");

        if (transcriptError && isQuotaError(transcriptError)) {
          // Informa al usuario de forma verbal para que sepa por qué no transcribió.
          void speak("Se alcanzó el límite de cuota del proveedor de IA. Espera unos instantes antes de usar el micrófono.");
          setState("idle");
          return;
        }

        if (text.trim() && !isAbortedRef.current) {
          onTranscriptRef.current(text, {
            sttMs: Math.round(performance.now() - listeningSinceRef.current),
            engine: "cloud",
          });
        }
        setState("idle");
      };

      recorder.start(250);
      levelTimer = window.setTimeout(checkLevel, 100);
    } catch (error) {
      console.error("[ASTER-speech] ERROR al iniciar el micrófono:", error);
      setState("idle");
    }
  }, []);

  /** Inicia la escucha de voz con el mejor mecanismo disponible. */
  const start = useCallback(async () => {
    stopSpeaking();
    isAbortedRef.current = false;
    setState("listening");
    listeningSinceRef.current = performance.now();

    const policy = loadSpeechPolicy();
    const sttLang = defaultLang ?? policy.sttLang;

    // Mecanismo 1: Web Speech API nativa (solo si está disponible y funcional).
    if (isNativeSttAvailable() && policy.sttEngine !== "cloud") {
      sessionRef.current = startNativeStt(
        sttLang,
        (final) =>
          onTranscriptRef.current(final, {
            sttMs: Math.round(performance.now() - listeningSinceRef.current),
            engine: "local",
          }),
        (err) => {
          console.warn("[ASTER-speech] error en Web Speech API:", err);
          if (canUseCloudStt(policy)) {
            console.log("[ASTER-speech] activando fallback a grabación con Gemini…");
            void startRecording();
          } else {
            setState("idle");
          }
        },
        () => setState((p) => (p === "listening" ? "idle" : p)),
      );
      return;
    }

    // Mecanismo 2: grabación + transcripción por Gemini.
    if (!canUseCloudStt(policy)) {
      console.warn("[ASTER-speech] transcripción en la nube deshabilitada por el usuario");
      setState("idle");
      return;
    }

    await startRecording();
  }, [defaultLang, startRecording]);

  /** Marca estado de procesamiento: el orquestador ya trabaja en la orden. */
  const markProcessing = useCallback(() => {
    stopSpeaking();
    setState("processing");
  }, []);

  /** Vuelve a reposo (tras confirmar/cancelar o ante un error). */
  const markIdle = useCallback(() => {
    setState("idle");
  }, []);

  /** Detiene la escucha activa. Si abort es true, descarta la grabación sin transcribir. */
  const stopListening = useCallback((abort = false) => {
    if (abort) {
      isAbortedRef.current = true;
    }
    if (sessionRef.current) {
      sessionRef.current.stop();
      sessionRef.current = null;
      setState("idle");
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    } else {
      recorderRef.current = null;
      setState("idle");
    }
  }, []);

  /** Sintetiza un texto de forma canalizada (interrumpe ante nueva voz). */
  const say = useCallback(async (text: string) => {
    const policyNow = loadSpeechPolicy();
    if (!policyNow.ttsEnabled) {
      setState("idle");
      return;
    }
    setState("speaking");
    await speak(
      text,
      () => setState((prev) => (prev === "speaking" ? "idle" : prev)),
      policyNow,
    );
  }, []);

  const cancelSpeech = useCallback(() => {
    stopSpeaking();
    setState("idle");
  }, []);

  // Limpieza al desmontar.
  useEffect(() => () => stopListening(true), [stopListening]);

  return { state, start, stopListening, say, cancelSpeech, markProcessing, markIdle };
}
