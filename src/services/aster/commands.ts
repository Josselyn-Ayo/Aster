/**
 * Servicios IPC del catálogo cerrado de acciones de Aster.
 *
 * Cada función corresponde a una de las ocho acciones autorizadas y delega en
 * el comando Rust equivalente. El frontend nunca ejecuta lógica de sistema por
 * su cuenta: solo solicita operaciones ya validadas y auditadas en el backend.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  AsterAction,
  AuditEntry,
  AuditQuery,
  AuditStats,
  CatalogEntry,
  FileHit,
  FileOpOutcome,
  FileOpRequest,
  PendingOperation,
  RootEntry,
  SystemReport,
  UserProfile,
} from "../../types/aster";

/** Resultado de abrir una aplicación autorizada. */
export interface AppLaunchOutcome {
  status: string;
  message: string;
  resolvedTarget: string;
}

/* ------------------------------------------------------------------ */
/* 1. Abrir aplicaciones autorizadas                                    */
/* ------------------------------------------------------------------ */

/**
 * Abre una aplicación de la lista blanca del perfil. El backend comprueba el
 * permiso, la lista blanca y las guardas anti-shell antes de lanzarla.
 */
export function openAuthorizedApp(appName: string): Promise<AppLaunchOutcome> {
  return invoke("open_authorized_app", { appName });
}

/* ------------------------------------------------------------------ */
/* 3. Información del sistema                                          */
/* ------------------------------------------------------------------ */

export function systemReport(topic?: string): Promise<SystemReport> {
  return invoke("system_report", { detail: topic ?? null });
}

/* ------------------------------------------------------------------ */
/* 4. Buscar archivos y carpetas                                       */
/* ------------------------------------------------------------------ */

export interface FindFilesArgs {
  query: string;
  scope?: string;
  root?: string;
  limit?: number;
  foldersOnly?: boolean;
}

export function findFiles(args: FindFilesArgs): Promise<FileHit[]> {
  return invoke("find_files", {
    request: {
      query: args.query,
      scope: args.scope ?? null,
      root: args.root ?? null,
      limit: args.limit ?? null,
      foldersOnly: args.foldersOnly ?? false,
    },
  });
}

/* ------------------------------------------------------------------ */
/* 5., 5b y 6. Crear carpeta / crear archivo / mover (exigen confirmación) */
/* ------------------------------------------------------------------ */

/**
 * Prepara una operación de escritura y devuelve la ficha de confirmación.
 * No escribe nada en el disco: solo deja la operación «armada» y caduca a los
 * dos minutos.
 */
export function prepareFileOperation(
  request: FileOpRequest,
  origin = "ui",
): Promise<PendingOperation> {
  return invoke("prepare_file_operation", { request, origin });
}

/**
 * Confirma o rechaza la operación pendiente. El backend revalida las rutas y
 * registra el resultado en el historial de acciones.
 */
export function confirmFileOperation(
  operationId: string,
  approved: boolean,
  origin = "ui",
): Promise<FileOpOutcome> {
  return invoke("confirm_file_operation", { operationId, approved, origin });
}

/** Descarta una operación pendiente sin registrarla como ejecución. */
export function cancelFileOperation(operationId: string): Promise<void> {
  return invoke("cancel_file_operation", { operationId });
}

/* ------------------------------------------------------------------ */
/* 7. Historial de acciones                                            */
/* ------------------------------------------------------------------ */

/**
 * Devuelve el historial de acciones, de la más reciente a la más antigua.
 * Es la acción 8 del catálogo («consultar el historial de acciones»).
 */
export function auditList(query: AuditQuery = {}): Promise<AuditEntry[]> {
  return invoke("audit_list", {
    query: {
      limit: query.limit ?? 100,
      offset: query.offset ?? 0,
      action: query.action ?? null,
      status: query.status ?? null,
      origin: query.origin ?? null,
    },
  });
}

/** Catálogo cerrado con el estado de permisos del perfil. */
export function policyCatalog(): Promise<CatalogEntry[]> {
  return invoke("policy_catalog");
}

export function getProfile(): Promise<UserProfile> {
  return invoke("policy_get");
}

export function updateProfile(patch: {
  userName?: string;
  permissions?: Record<string, boolean>;
  extraRoots?: string[];
  retentionDays?: number;
  maxHistoryKb?: number;
}): Promise<UserProfile> {
  return invoke("policy_update", { patch });
}

export function isActionAllowed(action: AsterAction): Promise<boolean> {
  return invoke("policy_is_allowed", { action });
}

export function allowedRoots(): Promise<RootEntry[]> {
  return invoke("policy_roots");
}

/** Detecta las aplicaciones instaladas para que el usuario las autorice. */
export function scanInstalledApps(): Promise<
  Array<{ displayName: string; target: string; allowed: boolean; source: string }>
> {
  return invoke("apps_scan");
}

export function setAppAllowed(
  displayName: string,
  target: string,
  allowed: boolean,
): Promise<UserProfile> {
  return invoke("app_set_allowed", { displayName, target, allowed });
}

/** Aplicaciones actualmente autorizadas (se sugieren al usuario). */
export function listAllowedApps(): Promise<
  Array<{ displayName: string; target: string; allowed: boolean; source: string }>
> {
  return invoke("apps_allowed");
}

/** Resumen agregado del historial, para la pantalla de historial. */
export function auditStats(): Promise<AuditStats> {
  return invoke("audit_stats");
}

/** Muestra una ruta en el Explorador (carpeta o archivo seleccionado). */
export function revealInFolder(path: string): Promise<string> {
  return invoke("reveal_in_folder", { path });
}
