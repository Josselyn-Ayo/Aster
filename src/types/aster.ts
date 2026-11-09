/**
 * Tipos del catálogo cerrado de acciones de Aster.
 *
 * El asistente solo puede ejecutar estas ocho acciones. Cualquier otra orden
 * se atiende como conversación. Las acciones que escriben en el disco
 * (`create_folder`, `create_file`, `move_files`) exigen confirmación explícita
 * antes de ejecutarse y toda ejecución queda registrada en el historial de acciones.
 */

/** Acciones del catálogo cerrado. */
export type AsterAction =
  | "open_authorized_app"
  | "web_search"
  | "system_info"
  | "find_files"
  | "create_folder"
  | "create_file"
  | "move_files"
  | "action_history";

/** Catálogo completo, en el orden en que se presenta al usuario. */
export const ASTER_ACTIONS: AsterAction[] = [
  "open_authorized_app",
  "web_search",
  "system_info",
  "find_files",
  "create_folder",
  "create_file",
  "move_files",
  "action_history",
];

/** Acciones que modifican el sistema de archivos: exigen confirmación. */
export const ASTER_CONFIRMED_ACTIONS: AsterAction[] = ["create_folder", "create_file", "move_files"];

/** Etiquetas legibles del catálogo. */
export const ASTER_ACTION_LABELS: Record<AsterAction, string> = {
  open_authorized_app: "Abrir aplicación autorizada",
  web_search: "Búsqueda en Internet",
  system_info: "Información del sistema",
  find_files: "Buscar archivos y carpetas",
  create_folder: "Crear carpeta",
  create_file: "Crear archivo",
  move_files: "Mover archivos y carpetas",
  action_history: "Historial de acciones",
};

/** Intención resuelta por el modelo para una acción del catálogo. */
export type AsterIntent =
  | { type: "open_authorized_app"; app: string }
  | { type: "web_search"; query: string; openSources?: boolean }
  | { type: "system_info"; topic?: string }
  | { type: "find_files"; query: string; scope?: string; foldersOnly?: boolean }
  | { type: "create_folder"; path: string }
  | { type: "create_file"; path: string }
  | { type: "move_files"; sources: string[]; destination: string }
  | { type: "action_history"; action?: string; limit?: number };

/** Entrada del catálogo con el estado de permiso del perfil. */
export interface CatalogEntry {
  action: AsterAction;
  label: string;
  requiresConfirmation: boolean;
  mutatesFilesystem: boolean;
  enabled: boolean;
}

/** Aplicación de la lista blanca de autorizadas. */
export interface AllowedApp {
  displayName: string;
  target: string;
  allowed: boolean;
  source: "core" | "start_menu" | string;
}

/** Carpeta donde el asistente puede buscar y operar. */
export interface RootEntry {
  path: string;
  label: string;
  exists: boolean;
}

/** Perfil de usuario: controla qué funciones están disponibles. */
export interface UserProfile {
  userName: string;
  permissions: Partial<Record<AsterAction, boolean>>;
  allowedApps: AllowedApp[];
  extraRoots: string[];
  retentionDays: number;
  maxHistoryKb: number;
  createdAt: string;
}

/** Campos del perfil modificables desde Ajustes. */
export interface ProfilePatch {
  userName?: string;
  permissions?: Partial<Record<AsterAction, boolean>>;
  extraRoots?: string[];
  retentionDays?: number;
  maxHistoryKb?: number;
}

/* ------------------------------------------------------------------ */
/* Archivos                                                            */
/* ------------------------------------------------------------------ */

/** Ámbitos de búsqueda dentro de las carpetas autorizadas. */
export const FIND_SCOPES = [
  { id: "all", label: "Todas las carpetas autorizadas" },
  { id: "desktop", label: "Escritorio" },
  { id: "documents", label: "Documentos" },
  { id: "downloads", label: "Descargas" },
  { id: "pictures", label: "Imágenes" },
  { id: "music", label: "Música" },
] as const;

/** Resultado de la búsqueda de archivos y carpetas. */
export interface FileHit {
  path: string;
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  sizeLabel: string;
  modifiedAt: string;
  scope: string;
}

/** Operación de escritura pendiente de confirmar. */
export type FileOpRequest =
  | { kind: "createFolder"; path: string }
  | { kind: "createFile"; path: string }
  | { kind: "move"; sources: string[]; destination: string };

/** Ficha de confirmación que se muestra en el diálogo. */
export interface PendingOperation {
  id: string;
  action: AsterAction;
  title: string;
  summary: string;
  details: string[];
  requiresConfirmation: boolean;
  expiresAt: string;
}

/** Desenlace de una operación de escritura. */
export interface FileOpOutcome {
  status: "success" | "error" | "cancelled" | "denied";
  message: string;
  affected: string[];
  auditId: string;
}

/* ------------------------------------------------------------------ */
/* Información del sistema                                             */
/* ------------------------------------------------------------------ */

export interface BatteryReport {
  status: string;
  percent?: number;
  minutesRemaining?: number;
}

export interface DiskReport {
  letter: string;
  label: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
  totalLabel: string;
  freeLabel: string;
}

export interface ProcessReport {
  pid: number;
  name: string;
  memoryBytes: number;
  memoryLabel: string;
}

/** Informe de información del sistema. */
export interface SystemReport {
  osName: string;
  osVersion: string;
  build: string;
  architecture: string;
  hostname: string;
  user: string;
  cpu: string;
  cpuThreads: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  memoryUsedPercent: number;
  uptimeSeconds: number;
  uptimeLabel: string;
  battery?: BatteryReport;
  disks: DiskReport[];
  screens: number;
  processes: ProcessReport[];
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Historial de acciones, auditoría y métricas                         */
/* ------------------------------------------------------------------ */

export type AuditStatus = "success" | "error" | "denied" | "cancelled" | "pending";

/** Entrada del registro de auditoría. */
export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  label: string;
  status: AuditStatus;
  target: string;
  summary: string;
  confirmed: boolean;
  origin: string;
  latencyMs: number;
  error?: string;
}

/** Datos que el frontend envía para registrar una acción. */
export interface AuditInput {
  action: string;
  target?: string;
  summary?: string;
  status?: AuditStatus;
  confirmed?: boolean;
  origin?: string;
  latencyMs?: number;
  error?: string | null;
}

/** Filtros del historial de acciones. */
export interface AuditQuery {
  limit?: number;
  offset?: number;
  action?: string;
  status?: string;
  origin?: string;
}

export interface ActionTally {
  action: string;
  label: string;
  total: number;
  success: number;
}

export interface StatusTally {
  status: string;
  total: number;
}

/** Resumen agregado del historial. */
export interface AuditStats {
  total: number;
  byAction: ActionTally[];
  byStatus: StatusTally[];
  confirmedOperations: number;
  guardedOperations: number;
  auditFile: string;
  oldest?: string | null;
  newest?: string | null;
}

/** Muestra de métricas de una interacción. */
export interface MetricInput {
  action: string;
  origin: string;
  sttMs: number;
  interpretMs: number;
  executeMs: number;
  ttsMs: number;
  totalMs: number;
  confidence: number;
  success: boolean;
  confirmationRequested: boolean;
  confirmationAccepted: boolean;
  usabilityVote?: number | null;
  utterance: string;
  error?: string | null;
}

export interface LatencyStats {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface ActionMetrics {
  action: string;
  label: string;
  count: number;
  success: number;
  successRate: number;
  meanLatencyMs: number;
  inCatalog: boolean;
}

/** Indicadores de evaluación del proyecto. */
export interface MetricsSummary {
  interactions: number;
  taskSuccessRate: number;
  interpretationAccuracy: number;
  userRatingRate?: number | null;
  votedInteractions: number;
  totalLatency: LatencyStats;
  interpretLatency: LatencyStats;
  executeLatency: LatencyStats;
  sttLatency: LatencyStats;
  ttsLatency: LatencyStats;
  confirmationsRequested: number;
  confirmationsAccepted: number;
  usabilityIndex: number;
  perAction: ActionMetrics[];
  metricsFile: string;
}

/** Resultado de la acción 2: búsqueda en Internet con fuentes. */
export interface WebSearchResult {
  answer: string;
  sources: Array<{ title: string; uri: string }>;
  query: string;
}
