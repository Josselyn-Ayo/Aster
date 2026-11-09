/**
 * Controlador de ASTER (capa Controller).
 *
 * Orquesta el flujo completo de una orden —interpretar → ejecutar → responder
 * → medir— y mantiene el estado de la conversación. No importa React ni
 * componentes: las Vistas se suscriben con `useSyncExternalStore` y la voz se
 * inyecta como puerto (`SpeechPort`), de modo que el controlador se puede
 * probar sin navegador.
 *
 * Reglas que se conservan del diseño anterior:
 *  - Toda acción se comprueba contra los permisos del perfil.
 *  - Crear/mover archivos se prepara y solo se ejecuta con confirmación.
 *  - Todo se audita, también los fallos y las cancelaciones.
 *  - Una tarea cancelada abandona en el siguiente checkpoint (`alive()`).
 */
import type { AutomationAction, ChatMessage } from "../types";
import type {
  AsterAction,
  FileHit,
  FileOpRequest,
  PendingOperation,
  SystemReport,
  UserProfile,
} from "../types/aster";
import {
  chat,
  describeScreen,
  generateImage,
  interpret,
  webSearch,
  type Intent,
} from "../model/ai";
import { executeAutomation, openUrl } from "../services/automation/system";
import * as aster from "../services/aster/commands";
import { rateInteraction, recordAction, recordMetric } from "../services/aster/audit";
import {
  formatFileHits,
  formatHistory,
  formatSearchSources,
  formatSystemReport,
} from "../services/aster/format";
import { saveCurrentSession } from "../services/history/store";

/** Estado de la política de seguridad cargada del backend. */
export interface SecurityPolicy {
  profile: UserProfile | null;
  roots: string[];
  apps: string[];
}

/** Confirmación pendiente de una acción que modifica el sistema de archivos. */
export interface PendingConfirmation {
  operation: PendingOperation;
  /** Petición original: permite construir el "deshacer" tras un movimiento. */
  request: FileOpRequest;
  /** Burbuja del chat que se actualiza al aprobar o cancelar. */
  messageId: string;
  /** Origen de la orden: `voice` o `text`. */
  origin: string;
  /** Texto original del usuario. */
  utterance: string;
  /** Confianza con la que el modelo interpretó la orden. */
  confidence: number;
}

/** Metadatos de una transcripción de voz. */
export interface InputMeta {
  sttMs?: number;
  engine?: "local" | "cloud";
}

/**
 * Puerto de voz: la Vista conecta el hook de micrófono/TTS con el controlador
 * sin que este dependa de React.
 */
export interface SpeechPort {
  start(): Promise<void>;
  stopListening(abort?: boolean): void;
  say(text: string): Promise<void>;
  cancelSpeech(): void;
  markProcessing(): void;
  markIdle(): void;
}

/** Estado observable que consumen las Vistas. */
export interface AsterSnapshot {
  messages: ChatMessage[];
  policy: SecurityPolicy;
  pending: PendingConfirmation | null;
  metricIds: Record<string, string>;
  /** Hay una respuesta generándose: la tarea es cancelable. */
  busy: boolean;
}

let idCounter = 0;
const nextId = () => `m${(idCounter += 1)}`;

/** Directorio padre de una ruta Windows (`C:\a\b.txt` -> `C:\a`). */
function parentDir(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return cut > 0 ? trimmed.slice(0, cut) : trimmed;
}

const now = () => performance.now();
const since = (start: number) => Math.round(now() - start);

/** Traduce la excepción de una llamada IPC a un mensaje comprensible. */
function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^\s*(?:invoke error|TauriError)?\s*:?\s*/i, "").trim() || "Error desconocido";
}

export class AsterController {
  private messages: ChatMessage[] = [];
  private policy: SecurityPolicy = { profile: null, roots: [], apps: [] };
  private pending: PendingConfirmation | null = null;
  private metricIds: Record<string, string> = {};
  private snapshot: AsterSnapshot = {
    messages: [],
    policy: { profile: null, roots: [], apps: [] },
    pending: null,
    metricIds: {},
    busy: false,
  };

  private listeners = new Set<() => void>();
  private speech: SpeechPort | null = null;
  private persistedMessages: ChatMessage[] | null = null;
  /** Generación en vuelo: cancelar incrementa el contador. */
  private taskId = 0;

  /* ---------------------------------------------------------------- */
  /* Suscripción (contrato de useSyncExternalStore)                    */
  /* ---------------------------------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AsterSnapshot => this.snapshot;

  /** Conecta la voz (micrófono y TTS) con el controlador. */
  setSpeech(port: SpeechPort | null): void {
    this.speech = port;
  }

  private emit(): void {
    if (this.messages !== this.persistedMessages) {
      this.persistedMessages = this.messages;
      saveCurrentSession(this.messages);
    }
    this.snapshot = {
      messages: this.messages,
      policy: this.policy,
      pending: this.pending,
      metricIds: this.metricIds,
      busy: this.messages.some((message) => message.streaming),
    };
    for (const listener of this.listeners) listener();
  }

  private setMessages(next: ChatMessage[]): void {
    this.messages = next;
    this.emit();
  }

  private push(message: ChatMessage): void {
    this.setMessages([...this.messages, message]);
  }

  private patchMessage(id: string, patch: Partial<ChatMessage>): void {
    this.setMessages(this.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  private finishAssistant(id: string, text: string, image?: string): void {
    this.patchMessage(id, { content: text, image, streaming: false });
  }

  /* ---------------------------------------------------------------- */
  /* Política, auditoría y métricas                                    */
  /* ---------------------------------------------------------------- */

  /** Carga el perfil, las carpetas autorizadas y las aplicaciones permitidas. */
  async refreshPolicy(): Promise<void> {
    try {
      const [profile, roots, apps] = await Promise.all([
        aster.getProfile(),
        aster.allowedRoots(),
        aster.listAllowedApps(),
      ]);
      this.policy = {
        profile,
        roots: roots.map((root) => root.path),
        apps: apps.map((app) => app.displayName),
      };
      this.emit();
    } catch (error) {
      console.error("[ASTER-policy] no se pudo cargar la política:", error);
    }
  }

  /** ¿El perfil permite esta acción del catálogo? */
  private permitted(action: AsterAction): boolean {
    return this.policy.profile?.permissions?.[action] !== false;
  }

  /** Registra la acción en la auditoría sin romper el flujo si falla. */
  private audit(entry: Parameters<typeof recordAction>[0]): void {
    void recordAction(entry).catch((error) =>
      console.error("[ASTER-audit] no se pudo registrar la acción:", error),
    );
  }

  /** Guarda la muestra de métricas y asocia su id a la respuesta. */
  private metric(messageId: string, sample: Parameters<typeof recordMetric>[0]): void {
    void recordMetric(sample)
      .then((saved) => {
        this.metricIds = { ...this.metricIds, [messageId]: saved.id };
        this.emit();
      })
      .catch((error) => console.error("[ASTER-metric] no se pudo registrar la métrica:", error));
  }

  /* ---------------------------------------------------------------- */
  /* Voz                                                               */
  /* ---------------------------------------------------------------- */

  async startListening(): Promise<void> {
    await this.speech?.start();
  }

  stopListening(): void {
    this.speech?.stopListening();
  }

  cancelSpeech(): void {
    this.speech?.cancelSpeech();
  }

  /* ---------------------------------------------------------------- */
  /* Flujo principal                                                   */
  /* ---------------------------------------------------------------- */

  /** Punto de entrada de una orden, escrita o dictada. */
  async sendText(rawText: string, meta?: InputMeta): Promise<void> {
    const text = rawText.trim();
    if (!text) return;

    const origin = meta?.engine === "cloud" || meta?.engine === "local" ? "voice" : "text";
    const sttMs = meta?.sttMs ?? 0;
    const totalStart = now();

    const userMessage: ChatMessage = {
      id: nextId(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    this.push(userMessage);

    const assistantId = nextId();
    this.push({
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      streaming: true,
    });

    const taskId = (this.taskId += 1);
    const alive = () => taskId === this.taskId;
    this.speech?.markProcessing();

    let actionLabel = "conversation";
    let confidence = 0.5;
    let interpretMs = 0;
    const executeStart = now();

    try {
      const interpretStart = now();
      const routed = await interpret(text, {
        allowedRoots: this.policy.roots,
        allowedApps: this.policy.apps,
      });
      const intent: Intent = routed.intent;
      interpretMs = since(interpretStart);
      confidence = routed.confidence;
      if (!alive()) return;

      let replyText = "";
      let replyImage: string | undefined;
      let failed = false;
      let requiresConfirmation = false;
      let attachedReport: SystemReport | undefined;
      let attachedHits: FileHit[] | undefined;

      switch (intent.type) {
        case "automation": {
          const action: AutomationAction = {
            kind: intent.action.kind,
            target: intent.action.target,
          };
          actionLabel = `automation:${action.kind}`;
          replyText = await executeAutomation(action);
          break;
        }
        case "vision": {
          actionLabel = "vision";
          const res = await describeScreen(intent.question);
          replyText = res.text;
          break;
        }
        case "image": {
          actionLabel = "image";
          const res = await generateImage(intent.prompt);
          replyText = res.text;
          replyImage = res.imageDataUrl;
          break;
        }
        case "conversation":
        default: {
          const historyForChat = this.messages.some((m) => m.id === userMessage.id)
            ? this.messages
            : [...this.messages, userMessage];
          const res = await chat(historyForChat);
          replyText = res.text;
          break;
        }

        case "open_authorized_app": {
          actionLabel = "open_authorized_app";
          if (!this.permitted("open_authorized_app")) {
            failed = true;
            replyText = "La apertura de aplicaciones está deshabilitada en tu perfil.";
            this.audit({
              action: actionLabel,
              target: intent.app,
              summary: replyText,
              status: "denied",
              origin,
              latencyMs: since(executeStart),
            });
            break;
          }
          const outcome = await aster.openAuthorizedApp(intent.app);
          replyText = outcome.message;
          this.audit({
            action: actionLabel,
            target: intent.app,
            summary: replyText,
            status: "success",
            origin,
            latencyMs: since(executeStart),
          });
          break;
        }
        case "web_search": {
          actionLabel = "web_search";
          if (!this.permitted("web_search")) {
            failed = true;
            replyText = "La búsqueda en Internet está deshabilitada en tu perfil.";
            this.audit({
              action: actionLabel,
              target: intent.query,
              summary: replyText,
              status: "denied",
              origin,
              latencyMs: since(executeStart),
            });
            break;
          }
          const result = await webSearch(intent.query);
          replyText = `${result.answer}${formatSearchSources(result.sources)}`;
          let opened = 0;
          if (intent.openSources) {
            for (const source of result.sources.slice(0, 2)) {
              try {
                await openUrl(source.uri);
                opened += 1;
              } catch {
                /* una fuente que no abre no invalida la respuesta */
              }
            }
            if (opened > 0) {
              replyText += ` He abierto ${opened} fuente(s) en el navegador.`;
            }
          }
          this.audit({
            action: actionLabel,
            target: intent.query,
            summary: `Búsqueda respondida con ${result.sources.length} fuente(s)${
              opened > 0 ? `, ${opened} abierta(s)` : ""
            }`,
            status: "success",
            origin,
            latencyMs: since(executeStart),
          });
          break;
        }
        case "system_info": {
          actionLabel = "system_info";
          if (!this.permitted("system_info")) {
            failed = true;
            replyText = "La consulta de información del sistema está deshabilitada.";
            this.audit({
              action: actionLabel,
              target: intent.topic ?? "resumen",
              summary: replyText,
              status: "denied",
              origin,
              latencyMs: since(executeStart),
            });
            break;
          }
          const report = await aster.systemReport(intent.topic);
          replyText = formatSystemReport(report, intent.topic);
          attachedReport = report;
          this.audit({
            action: actionLabel,
            target: intent.topic ?? "resumen",
            summary: "Informe del sistema generado",
            status: "success",
            origin,
            latencyMs: since(executeStart),
          });
          break;
        }
        case "find_files": {
          actionLabel = "find_files";
          if (!this.permitted("find_files")) {
            failed = true;
            replyText = "La búsqueda de archivos está deshabilitada en tu perfil.";
            this.audit({
              action: actionLabel,
              target: intent.query,
              summary: replyText,
              status: "denied",
              origin,
              latencyMs: since(executeStart),
            });
            break;
          }
          const hits = await aster.findFiles({
            query: intent.query,
            scope: intent.scope,
            foldersOnly: intent.foldersOnly,
            limit: 25,
          });
          replyText = formatFileHits(hits, intent.query);
          attachedHits = hits;
          this.audit({
            action: actionLabel,
            target: intent.query,
            summary: `${hits.length} resultado(s) en las carpetas autorizadas`,
            status: "success",
            origin,
            latencyMs: since(executeStart),
          });
          break;
        }
        case "create_folder":
        case "create_file":
        case "move_files": {
          actionLabel = intent.type;
          const request: FileOpRequest =
            intent.type === "create_folder"
              ? { kind: "createFolder", path: intent.path }
              : intent.type === "create_file"
                ? { kind: "createFile", path: intent.path }
                : { kind: "move", sources: intent.sources, destination: intent.destination };

          if (!this.permitted(intent.type)) {
            failed = true;
            replyText = `La acción «${intent.type}» está deshabilitada en tu perfil.`;
            this.audit({
              action: actionLabel,
              target: intent.type === "move_files" ? intent.destination : intent.path,
              summary: replyText,
              status: "denied",
              origin,
              latencyMs: since(executeStart),
            });
            break;
          }

          const operation = await aster.prepareFileOperation(request, origin);
          requiresConfirmation = true;
          this.pending = {
            operation,
            request,
            messageId: assistantId,
            origin,
            utterance: text,
            confidence,
          };
          this.emit();
          replyText = `Necesito tu confirmación: ${operation.summary}`;
          break;
        }
        case "action_history": {
          actionLabel = "action_history";
          if (!this.permitted("action_history")) {
            failed = true;
            replyText = "El historial de acciones está deshabilitado en tu perfil.";
            this.audit({
              action: actionLabel,
              target: intent.action ?? "",
              summary: replyText,
              status: "denied",
              origin,
              latencyMs: since(executeStart),
            });
            break;
          }
          const [entries, stats] = await Promise.all([
            aster.auditList({ action: intent.action || undefined, limit: intent.limit ?? 25 }),
            aster.auditStats(),
          ]);
          replyText = formatHistory(entries, stats, intent.action || undefined);
          this.audit({
            action: actionLabel,
            target: intent.action ?? "todas",
            summary: `Historial consultado (${entries.length} entradas)`,
            status: "success",
            origin,
            latencyMs: since(executeStart),
          });
          break;
        }
      }

      const executeMs = since(executeStart);
      if (!alive()) return;

      if (requiresConfirmation) {
        this.speech?.markIdle();
        this.finishAssistant(assistantId, replyText);
        return;
      }

      this.finishAssistant(assistantId, replyText, replyImage);
      if (attachedReport || (attachedHits && attachedHits.length > 0)) {
        this.patchMessage(assistantId, {
          ...(attachedReport ? { systemReport: attachedReport } : {}),
          ...(attachedHits?.length ? { fileHits: attachedHits.slice(0, 25) } : {}),
        });
      }

      const ttsStart = now();
      if (replyText && alive()) {
        await this.speech?.say(replyText);
      }
      if (!alive()) return;
      const ttsMs = since(ttsStart);

      this.metric(assistantId, {
        action: actionLabel,
        origin,
        sttMs,
        interpretMs,
        executeMs,
        ttsMs,
        totalMs: since(totalStart),
        confidence,
        success: !failed && replyText.length > 0,
        confirmationRequested: false,
        confirmationAccepted: false,
        utterance: text,
        error: failed ? replyText : null,
      });
    } catch (error) {
      if (!alive()) return;
      const message = `Ocurrió un error procesando tu solicitud: ${errorMessage(error)}`;
      this.speech?.markIdle();
      this.finishAssistant(assistantId, message);
      this.audit({
        action: actionLabel,
        target: text,
        summary: "La orden no se pudo completar",
        status: "error",
        origin,
        latencyMs: since(executeStart),
        error: message,
      });
      this.metric(assistantId, {
        action: actionLabel,
        origin,
        sttMs,
        interpretMs,
        executeMs: since(executeStart),
        ttsMs: 0,
        totalMs: since(totalStart),
        confidence,
        success: false,
        confirmationRequested: false,
        confirmationAccepted: false,
        utterance: text,
        error: message,
      });
    }
  }

  /** Ejecuta la operación pendiente tras una confirmación explícita. */
  async confirmOperation(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    const { operation, request, messageId, origin, utterance, confidence } = pending;
    this.pending = null;
    this.emit();
    const start = now();

    try {
      const outcome = await aster.confirmFileOperation(operation.id, true, origin);
      const text =
        outcome.status === "success"
          ? outcome.affected.length
            ? `${outcome.message} ${outcome.affected.length} elemento(s) afectado(s).`
            : outcome.message
          : outcome.message;
      this.finishAssistant(messageId, text);

      if (
        operation.action === "move_files" &&
        outcome.status === "success" &&
        request.kind === "move" &&
        outcome.affected.length > 0
      ) {
        const parents = new Set(request.sources.map(parentDir));
        if (parents.size === 1) {
          const [destination] = [...parents];
          this.patchMessage(messageId, {
            undoMove: { sources: outcome.affected, destination },
          });
        }
      }

      this.metric(messageId, {
        action: operation.action,
        origin,
        sttMs: 0,
        interpretMs: 0,
        executeMs: since(start),
        ttsMs: 0,
        totalMs: since(start),
        confidence,
        success: outcome.status === "success",
        confirmationRequested: true,
        confirmationAccepted: true,
        utterance,
        error: outcome.status === "success" ? null : text,
      });
      if (outcome.status === "success") {
        await this.speech?.say(text);
      }
    } catch (error) {
      const message = `No se pudo completar la operación: ${errorMessage(error)}`;
      this.speech?.markIdle();
      this.finishAssistant(messageId, message);
      this.metric(messageId, {
        action: operation.action,
        origin,
        sttMs: 0,
        interpretMs: 0,
        executeMs: since(start),
        ttsMs: 0,
        totalMs: since(start),
        confidence,
        success: false,
        confirmationRequested: true,
        confirmationAccepted: true,
        utterance,
        error: message,
      });
    }
  }

  /** Rechaza la operación pendiente: se registra como cancelada. */
  async rejectOperation(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    const { operation, messageId, origin, utterance, confidence } = pending;
    this.pending = null;
    this.emit();
    const start = now();
    const text = "Operación cancelada. No he modificado nada.";

    try {
      await aster.confirmFileOperation(operation.id, false, origin);
    } catch {
      /* la operación pudo haber caducado: el backend ya no la registra */
    }
    this.speech?.markIdle();
    this.finishAssistant(messageId, text);
    this.metric(messageId, {
      action: operation.action,
      origin,
      sttMs: 0,
      interpretMs: 0,
      executeMs: since(start),
      ttsMs: 0,
      totalMs: since(start),
      confidence,
      success: false,
      confirmationRequested: true,
      confirmationAccepted: false,
      utterance,
      error: null,
    });
  }

  /**
   * Cancela la tarea en vuelo: invalida la generación actual para que los
   * `await` pendientes abandonen en el próximo checkpoint.
   */
  cancelTask(): void {
    this.taskId += 1;
    this.speech?.stopListening(true);
    this.speech?.cancelSpeech();
    const streaming = [...this.messages].reverse().find((m) => m.role === "assistant" && m.streaming);
    if (!streaming) return;

    const text = "Tarea cancelada. No se ejecutó ninguna acción.";
    this.finishAssistant(streaming.id, text);
    this.audit({
      action: "cancelled_task",
      target: "",
      summary: text,
      status: "cancelled",
      origin: "ui",
      latencyMs: 0,
    });
    this.metric(streaming.id, {
      action: "cancelled_task",
      origin: "ui",
      sttMs: 0,
      interpretMs: 0,
      executeMs: 0,
      ttsMs: 0,
      totalMs: 0,
      confidence: 0,
      success: false,
      confirmationRequested: false,
      confirmationAccepted: false,
      utterance: "",
      error: null,
    });
  }

  /**
   * Deshace un movimiento: prepara el viaje de vuelta como operación nueva
   * (también exige confirmación y queda auditada).
   */
  async undoMove(info: { sources: string[]; destination: string }): Promise<void> {
    const assistantId = nextId();
    this.push({
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      streaming: true,
    });
    try {
      const request: FileOpRequest = {
        kind: "move",
        sources: info.sources,
        destination: info.destination,
      };
      const operation = await aster.prepareFileOperation(request, "ui");
      this.pending = {
        operation,
        request,
        messageId: assistantId,
        origin: "ui",
        utterance: "Deshacer movimiento",
        confidence: 1,
      };
      this.emit();
      this.finishAssistant(assistantId, `Necesito tu confirmación: ${operation.summary}`);
    } catch (error) {
      this.finishAssistant(assistantId, `No se pudo preparar el deshacer: ${errorMessage(error)}`);
    }
  }

  /** Muestra una ruta autorizada en el Explorador. */
  async revealPath(path: string): Promise<void> {
    await aster.revealInFolder(path);
  }

  /** Borra la conversación actual de la interfaz. */
  clearConversation(): void {
    this.setMessages([]);
  }

  /**
   * Voto de usabilidad sobre una respuesta. Una interacción solo admite un
   * voto.
   */
  async rateMessage(messageId: string, vote: 1 | -1): Promise<void> {
    const id = this.metricIds[messageId];
    if (!id) return;
    this.metricIds = { ...this.metricIds, [messageId]: "" };
    this.emit();
    try {
      await rateInteraction(id, vote);
    } catch (error) {
      console.error("[ASTER-metric] no se pudo registrar el voto:", error);
    }
  }
}
