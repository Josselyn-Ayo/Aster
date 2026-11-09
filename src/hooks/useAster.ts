/**
 * Adaptador entre la Vista y el Controlador (capa View).
 *
 * El hook no contiene lógica de negocio: crea el `AsterController`, le inyecta
 * el puerto de voz y expone su estado observable a React con
 * `useSyncExternalStore`. Así los componentes solo pintan y emiten eventos.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AsterController } from "../controllers/AsterController";
import type {
  AsterSnapshot,
  PendingConfirmation,
  SecurityPolicy,
} from "../controllers/AsterController";
import { useSpeech, type SttMeta } from "./useSpeech";
import type { ListeningState } from "../types";

export type { PendingConfirmation, SecurityPolicy };

/** Estado que consume la interfaz. */
export interface UseAsterResult extends AsterSnapshot {
  state: ListeningState;
  listen: () => Promise<void>;
  stopListening: () => void;
  cancelSpeech: () => void;
  cancelTask: () => void;
  sendText: (text: string, meta?: SttMeta) => Promise<void>;
  clearConversation: () => void;
  refreshPolicy: () => Promise<void>;
  confirmOperation: () => Promise<void>;
  rejectOperation: () => Promise<void>;
  undoMove: (info: { sources: string[]; destination: string }) => Promise<void>;
  revealPath: (path: string) => Promise<void>;
  rateMessage: (messageId: string, vote: 1 | -1) => Promise<void>;
}

export function useAster(): UseAsterResult {
  // El controlador vive tanto como la Vista que lo monta.
  const controllerRef = useRef<AsterController | null>(null);
  if (!controllerRef.current) controllerRef.current = new AsterController();
  const controller = controllerRef.current;

  // Referencia mutable para romper la dependencia circular entre el hook de voz
  // (onTranscript) y el controlador.
  const transcriptRef = useRef<(text: string, meta: SttMeta) => void>(() => {});

  const speech = useSpeech({
    onTranscript: (text, meta) => transcriptRef.current(text, meta),
  });

  useEffect(() => {
    transcriptRef.current = (text, meta) => {
      void controller.sendText(text, meta);
    };
  }, [controller]);

  // Puerto de voz: el controlador pide hablar/escuchar sin depender de React.
  const { start, stopListening, say, cancelSpeech, markProcessing, markIdle } = speech;
  useEffect(() => {
    controller.setSpeech({ start, stopListening, say, cancelSpeech, markProcessing, markIdle });
    return () => controller.setSpeech(null);
  }, [controller, start, stopListening, say, cancelSpeech, markProcessing, markIdle]);

  useEffect(() => {
    void controller.refreshPolicy();
  }, [controller]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const sendText = useCallback(
    (text: string, meta?: SttMeta) => controller.sendText(text, meta),
    [controller],
  );
  const clearConversation = useCallback(() => controller.clearConversation(), [controller]);
  const refreshPolicy = useCallback(() => controller.refreshPolicy(), [controller]);
  const confirmOperation = useCallback(() => controller.confirmOperation(), [controller]);
  const rejectOperation = useCallback(() => controller.rejectOperation(), [controller]);
  const undoMove = useCallback(
    (info: { sources: string[]; destination: string }) => controller.undoMove(info),
    [controller],
  );
  const revealPath = useCallback((path: string) => controller.revealPath(path), [controller]);
  const rateMessage = useCallback(
    (messageId: string, vote: 1 | -1) => controller.rateMessage(messageId, vote),
    [controller],
  );
  const cancelTask = useCallback(() => controller.cancelTask(), [controller]);
  const listen = useCallback(() => controller.startListening(), [controller]);
  const stopListeningAction = useCallback(() => controller.stopListening(), [controller]);
  const cancelSpeechAction = useCallback(() => controller.cancelSpeech(), [controller]);

  return {
    ...snapshot,
    state: speech.state as ListeningState,
    listen,
    stopListening: stopListeningAction,
    cancelSpeech: cancelSpeechAction,
    cancelTask,
    sendText,
    clearConversation,
    refreshPolicy,
    confirmOperation,
    rejectOperation,
    undoMove,
    revealPath,
    rateMessage,
  };
}
