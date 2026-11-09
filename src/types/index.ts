/** Tipos de dominio compartidos por los servicios y componentes de ASTER. */
import type { FileHit, SystemReport } from "./aster";

/** Rol de un mensaje en la conversación con ASTER. */
export type Role = "user" | "assistant" | "system";

/** Entrada de la conversación mostrada en el ChatBox. */
export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Marca de tiempo en formato ISO. */
  timestamp: string;
  /** Si el mensaje incluye una imagen generada (data URL). */
  image?: string;
  /** Indica si el asistente aún está generando la respuesta. */
  streaming?: boolean;
  /** Informe estructurado para la tarjeta visual de system_info. */
  systemReport?: SystemReport;
  /** Resultados estructurados para la lista clicable de find_files. */
  fileHits?: FileHit[];
  /** Datos para ofrecer "Deshacer" tras un move_files exitoso. */
  undoMove?: { sources: string[]; destination: string };
}

/** Estado del micrófono / escucha activa. */
export type ListeningState = "idle" | "listening" | "processing" | "speaking";

/** Acciones de automatización interpretadas desde la orden de voz. */
export type AutomationKind = "youtube" | "spotify" | "launch_app" | "open_url";

/** Orden de automatización ya normalizada para ejecutar en Rust. */
export interface AutomationAction {
  kind: AutomationKind;
  /** Texto de búsqueda, URI, nombre de app o URL según el tipo. */
  target: string;
}

/** Respuesta unificada de un servicio de IA. */
export interface AiResult {
  text: string;
  /** Datos de imagen opcionales (data URL) para la generación de imágenes. */
  imageDataUrl?: string;
}
