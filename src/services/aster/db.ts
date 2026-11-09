/**
 * Cliente IPC de la capa híbrida local + Mongo Atlas.
 *
 * El backend mantiene las mismas firmas de auditoría/métricas (leen de Atlas
 * si responde, si no de local). Aquí solo van los comandos nuevos: estado,
 * configuración, migración y conversaciones remotas.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ConversationSession } from "../history/store";

export interface DbStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  dbName: string;
  lastSource: string;
  detail: string;
  /** De dónde sale la URI: "env" (.env), "file" (Ajustes) o "none". */
  uriSource: string;
  /** Vista sin secretos (mongodb+srv://***@host/…). */
  uriPreview: string;
}

export interface DbSyncResult {
  audits: number;
  metrics: number;
  pushedAudits: number;
  pushedMetrics: number;
  db: string;
}

/** Estado de la conexión (nunca expone la URI completa). */
export function dbStatus(): Promise<DbStatus> {
  return invoke("db_status");
}

/** Guarda la URI de Atlas. `uri` vacía = volver a modo local. */
export function dbConfigure(args: {
  uri?: string | null;
  dbName?: string | null;
  enabled?: boolean;
}): Promise<DbStatus> {
  return invoke("db_configure", {
    uri: args.uri ?? null,
    dbName: args.dbName ?? null,
    enabled: args.enabled ?? true,
  });
}

/** Migración local → Atlas (profile + audits + metrics). Idempotente. */
export function dbSync(): Promise<DbSyncResult> {
  return invoke("db_sync");
}

/** Sube sesiones del localStorage a la colección `conversations`. */
export function dbSyncConversations(
  sessions: ConversationSession[],
): Promise<{ received: number; pushed: number; db: string }> {
  return invoke("db_sync_conversations", { sessions });
}

/** Guarda una sesión en Atlas (espejo best-effort, no falla sin red). */
export function conversationSaveRemote(session: ConversationSession): Promise<string> {
  return invoke("conversation_save", { session });
}

/** Lee sesiones de Atlas. Falla si no hay conexión (usar local). */
export function conversationsListRemote(limit = 100): Promise<ConversationSession[]> {
  return invoke("conversations_list", { limit });
}

export function conversationDeleteRemote(id: string): Promise<void> {
  return invoke("conversation_delete", { id });
}

export function conversationsClearRemote(): Promise<void> {
  return invoke("conversations_clear");
}
