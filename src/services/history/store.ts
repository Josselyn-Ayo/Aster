/**
 * Historial de conversaciones (almacenamiento híbrido).
 *
 * Local (`localStorage`) = lectura instantánea y modo sin internet.
 * Atlas (`conversations` vía IPC) = espejo best-effort en la nube.
 * Cada guardado escribe primero en local y luego intenta Atlas sin bloquear:
 * si no hay red, el local ya quedó y se sincroniza después con `db_sync`.
 */
import type { ChatMessage } from "../../types";
import { loadSpeechPolicy } from "../speech/policy";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_KEY = "aster.conversation.history";

/** Resumen de una sesión de conversación, tal y como se muestra en el historial. */
export interface ConversationSession {
  id: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  /** Extracto breve de la conversación. */
  preview: string;
  messages: ChatMessage[];
}

/** Añade (o sustituye) la sesión en curso y poda según la política. */
export function saveCurrentSession(messages: ChatMessage[]): void {
  const policy = loadSpeechPolicy();
  if (!policy.storeConversation) {
    clearHistory();
    return;
  }
  const meaningful = messages.filter((m) => m.content.trim() && !m.streaming);
  if (meaningful.length === 0) return;

  const session: ConversationSession = {
    id: meaningful[0].timestamp,
    startedAt: meaningful[0].timestamp,
    endedAt: meaningful[meaningful.length - 1].timestamp,
    turns: meaningful.length,
    preview: meaningful
      .slice(0, 2)
      .map((m) => m.content.trim())
      .join(" · ")
      .slice(0, 140),
    // Sin imágenes: el historial guarda texto, no binarios.
    messages: meaningful.map(({ image: _image, ...rest }) => rest),
  };

  const sessions = loadHistory().filter((s) => s.id !== session.id);
  sessions.unshift(session);
  persist(pod(sessions, policy.conversationLimit, policy.conversationDays));
  // Espejo best-effort a Atlas (no bloquea la UI; falla en silencio sin red).
  void mirrorSession(session);
}

/** Intenta guardar la sesión en Atlas vía IPC; falla en silencio sin red. */
async function mirrorSession(session: ConversationSession): Promise<void> {
  try {
    await invoke("conversation_save", { session });
  } catch {
    // Modo local: ya quedó en localStorage, se sincroniza después.
  }
}

/** Devuelve las sesiones guardadas, de la más reciente a la más antigua. */
export function loadHistory(): ConversationSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ConversationSession[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Elimina una sesión concreta del historial (local + Atlas best-effort). */
export function deleteSession(id: string): void {
  persist(loadHistory().filter((session) => session.id !== id));
  void invoke("conversation_delete", { id }).catch(() => undefined);
}

/** Elimina todo el historial de conversaciones (local + Atlas best-effort). */
export function clearHistory(): void {
  localStorage.removeItem(STORAGE_KEY);
  void invoke("conversations_clear").catch(() => undefined);
}

/** Aplica los límites de cantidad y antigüedad. */
function pod(sessions: ConversationSession[], limit: number, days: number): ConversationSession[] {
  const cutoff = Date.now() - days * 86_400_000;
  return sessions
    .filter((session) => Date.parse(session.endedAt) >= cutoff)
    .slice(0, limit);
}

function persist(sessions: ConversationSession[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

/** Tamaño aproximado del historial, para mostrarlo en Ajustes. */
export function historySize(): { sessions: number; bytes: number } {
  const raw = localStorage.getItem(STORAGE_KEY) ?? "";
  return { sessions: loadHistory().length, bytes: new Blob([raw]).size };
}
