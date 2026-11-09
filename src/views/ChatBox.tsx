/**
 * ChatBox: panel de conversación de ASTER.
 * Muestra el historial de mensajes (con imágenes generadas) y la entrada de
 * texto. Gestiona el auto-scroll hacia el mensaje más reciente.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChatMessage } from "../types";
import type { FileHit, SystemReport } from "../types/aster";
import { ASTER_ACTION_LABELS, type AsterAction } from "../types/aster";
import { openUrl } from "../services/automation/system";
import BlurText from "./bits/BlurText";
import StarBorder from "./bits/StarBorder";

interface ChatBoxProps {
  messages: ChatMessage[];
  listening: boolean;
  onToggleListen: () => void;
  onSend: (text: string) => void;
  /** Identificador de la métrica de cada respuesta, para puntuar usabilidad. */
  metricIds: Record<string, string>;
  onRate: (messageId: string, vote: 1 | -1) => void;
  /** El asistente está leyendo la respuesta en voz alta. */
  speaking: boolean;
  /** Detiene la síntesis de voz en curso. */
  onStopSpeech: () => void;
  /** Sin API key no se puede enviar: se muestra el CTA de configuración. */
  hasApiKey: boolean;
  onConfigure: () => void;
  /** Hay una respuesta generándose: la tarea se puede cancelar (RR012). */
  busy: boolean;
  /** Cancela la tarea en vuelo. */
  onCancelTask: () => void;
  /** Muestra una ruta autorizada en el Explorador. */
  onReveal: (path: string) => Promise<void>;
  /** Prepara el deshacer de un movimiento (con confirmación). */
  onUndoMove: (info: { sources: string[]; destination: string }) => void;
}

/** Cheat sheet de las 8 acciones: cada ficha envía un ejemplo al orquestador. */
const CHEAT_SHEET: Array<{ action: AsterAction; example: string }> = [
  { action: "open_authorized_app", example: "Abre la Calculadora" },
  { action: "web_search", example: "Busca en Internet: precio del dólar hoy" },
  { action: "system_info", example: "Dime cuánta batería tiene el equipo" },
  { action: "find_files", example: "Busca el archivo informe en Documentos" },
  { action: "create_folder", example: "Crea una carpeta llamada Pruebas en Documentos" },
  { action: "create_file", example: "Crea un archivo llamado notas.txt en Documentos" },
  { action: "move_files", example: "Mueve el archivo notas de Descargas a Documentos" },
  { action: "action_history", example: "Muéstrame el historial de acciones" },
];

/** Render inline: enlaces [t](url), **negrita** y `código`. Sin HTML crudo. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${i++}`;
    if (match[1] !== undefined) {
      const uri = match[2];
      nodes.push(
        <button
          key={key}
          onClick={() => void openUrl(uri)}
          title={uri}
          className="text-aster-accent2 underline decoration-dotted underline-offset-2 transition hover:text-white"
        >
          {match[1]} ⧉
        </button>,
      );
    } else if (match[3] !== undefined) {
      nodes.push(<strong key={key}>{match[3]}</strong>);
    } else {
      nodes.push(
        <code
          key={key}
          className="select-text rounded bg-black/30 px-1 py-0.5 font-mono text-[12px]"
        >
          {match[4]}
        </code>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Markdown mínimo para las burbujas: bloques de código, listas y párrafos. */
function MarkdownText({ text }: { text: string }) {
  const elements: ReactNode[] = [];
  // Los bloques ```código``` se separan primero (índices impares).
  const parts = text.split("```");
  let key = 0;
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      elements.push(
        <pre
          key={`code-${key++}`}
          className="select-text mt-1 overflow-x-auto rounded-lg bg-black/40 p-2 font-mono text-[12px] leading-relaxed"
        >
          {part.replace(/^\w+\n/, "")}
        </pre>,
      );
      return;
    }
    const lines = part.split("\n");
    let list: string[] = [];
    const flushList = () => {
      if (list.length === 0) return;
      elements.push(
        <ul key={`ul-${key++}`} className="ml-4 list-disc space-y-0.5">
          {list.map((item, i) => (
            <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    };
    lines.forEach((line) => {
      const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
      if (item) {
        list.push(item[1]);
      } else {
        flushList();
        if (line.trim()) {
          elements.push(
            <p key={`p-${key++}`}>{renderInline(line, `p-${key}`)}</p>,
          );
        }
      }
    });
    flushList();
  });
  return <div className="space-y-1">{elements}</div>;
}

/** Barra de porcentaje reutilizable para la tarjeta del sistema. */
function StatBar({ value, tone }: { value: number; tone: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-aster-surface2">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Tarjeta visual del informe del sistema (el texto largo queda arriba). */
function SystemReportCard({ report }: { report: SystemReport }) {
  const ramTone =
    report.memoryUsedPercent > 90
      ? "bg-red-500"
      : report.memoryUsedPercent > 70
        ? "bg-amber-400"
        : "bg-gradient-to-r from-aster-accent to-aster-accent2";
  return (
    <div className="mt-2 select-text rounded-xl border border-aster-border bg-aster-bg p-3 text-xs">
      <p className="font-semibold text-aster-text">
        {report.osName} · {report.hostname}
      </p>
      <p className="mt-0.5 text-aster-muted">Encendido hace {report.uptimeLabel}</p>
      <div className="mt-2">
        <div className="flex justify-between text-aster-muted">
          <span>Memoria</span>
          <span>
            {report.memoryUsedPercent.toFixed(0)} % de{" "}
            {(report.memoryTotalBytes / 1024 ** 3).toFixed(1)} GB
          </span>
        </div>
        <StatBar value={report.memoryUsedPercent} tone={ramTone} />
      </div>
      {report.disks.slice(0, 4).map((d) => (
        <div key={d.letter} className="mt-2">
          <div className="flex justify-between text-aster-muted">
            <span>
              Disco {d.label}
            </span>
            <span>
              {d.freeLabel} libres de {d.totalLabel}
            </span>
          </div>
          <StatBar
            value={d.usedPercent}
            tone={d.usedPercent > 90 ? "bg-red-500" : "bg-aster-accent2"}
          />
        </div>
      ))}
      <p className="mt-2 text-aster-muted">
        {report.battery
          ? `Batería: ${report.battery.status}${report.battery.percent !== undefined ? ` (${report.battery.percent} %)` : ""}`
          : "Sin batería detectada"}{" "}
        · {report.screens} pantalla(s) · {report.cpuThreads} hilos
      </p>
    </div>
  );
}

/** Resultados de find_files con botón "Revelar" por elemento. */
function FileHitsList({
  hits,
  onReveal,
}: {
  hits: FileHit[];
  onReveal: (path: string) => Promise<void>;
}) {
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const shown = hits.slice(0, 8);

  const reveal = async (path: string) => {
    setNotice("");
    setFailed(false);
    try {
      await onReveal(path);
      setNotice("Abierto en el Explorador.");
    } catch (error) {
      setFailed(true);
      setNotice((error as Error).message);
    }
  };

  return (
    <div className="mt-2 select-text rounded-xl border border-aster-border bg-aster-bg p-2 text-xs">
      <ul className="space-y-1">
        {shown.map((hit) => (
          <li
            key={hit.path}
            className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition hover:bg-aster-surface2"
          >
            <span className="min-w-0">
              <span className="block truncate text-aster-text">
                {hit.isDirectory ? "📁 " : "📄 "}
                {hit.name}
              </span>
              <span className="block truncate text-[11px] text-aster-muted">
                {hit.path} · {hit.sizeLabel}
              </span>
            </span>
            <button
              onClick={() => void reveal(hit.path)}
              title="Mostrar en el Explorador"
              className="shrink-0 rounded-lg border border-aster-border px-2 py-1 text-[11px] text-aster-muted transition hover:bg-aster-surface hover:text-aster-text"
            >
              Revelar
            </button>
          </li>
        ))}
      </ul>
      {hits.length > shown.length && (
        <p className="px-2 pt-1 text-[11px] text-aster-muted">
          +{hits.length - shown.length} más (ver el texto de arriba).
        </p>
      )}
      {notice && (
        <p className={`px-2 pt-1 text-[11px] ${failed ? "text-red-300" : "text-aster-accent2"}`}>
          {notice}
        </p>
      )}
    </div>
  );
}

function Bubble({
  message,
  metricId,
  onRate,
  onReveal,
  onUndoMove,
}: {
  message: ChatMessage;
  metricId?: string;
  onRate: (messageId: string, vote: 1 | -1) => void;
  onReveal: (path: string) => Promise<void>;
  onUndoMove: (info: { sources: string[]; destination: string }) => void;
}) {
  const isUser = message.role === "user";
  // Un voto ya emitido deja el valor vacío: así el botón deja de responder.
  const rated = metricId !== undefined && metricId === "";
  const [copied, setCopied] = useState(false);
  const canCopy = !message.streaming && Boolean(message.content);

  const copyText = async () => {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {
      // Fallback para WebView2 / contextos sin Clipboard API.
      const area = document.createElement("textarea");
      area.value = message.content;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
      } catch {
        /* sin portapapeles: se ignora */
      }
      document.body.removeChild(area);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[92%] sm:max-w-[78%]">
        <div
          className={`select-text cursor-text whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-md ${
            isUser
              ? "rounded-br-sm bg-gradient-to-r from-aster-accent to-aster-accent2 text-aster-bg"
              : "rounded-bl-sm border border-aster-border bg-aster-surface text-aster-text"
          }`}
        >
          {message.image && (
            <img
              src={message.image}
              alt="Imagen generada"
              className="mb-2 max-h-56 w-full rounded-lg object-contain"
            />
          )}
          {message.streaming && !message.content ? (
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-aster-accent" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-aster-accent [animation-delay:0.15s]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-aster-accent [animation-delay:0.3s]" />
            </span>
          ) : (
            <MarkdownText text={message.content} />
          )}
        </div>
        {!isUser && !message.streaming && message.systemReport && (
          <SystemReportCard report={message.systemReport} />
        )}
        {!isUser && !message.streaming && message.fileHits?.length ? (
          <FileHitsList hits={message.fileHits} onReveal={onReveal} />
        ) : null}
        {/* Valoración de usabilidad: alimenta el índice del panel de evaluación. */}
        {!isUser && metricId !== undefined && !message.streaming && (
          <div className="mt-1 flex select-none items-center gap-1 pl-1">
            <button
              onClick={() => onRate(message.id, 1)}
              disabled={rated}
              aria-label="Respuesta útil"
              title="Respuesta útil"
              className="rounded px-1.5 py-0.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text disabled:opacity-40"
            >
              👍
            </button>
            <button
              onClick={() => onRate(message.id, -1)}
              disabled={rated}
              aria-label="Respuesta no útil"
              title="Respuesta no útil"
              className="rounded px-1.5 py-0.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text disabled:opacity-40"
            >
              👎
            </button>
            {canCopy && (
              <button
                onClick={() => void copyText()}
                aria-label="Copiar respuesta"
                title="Copiar respuesta"
                className="rounded px-1.5 py-0.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
              >
                {copied ? "✓ Copiado" : "⧉ Copiar"}
              </button>
            )}
            {rated && <span className="text-[10px] text-aster-muted">GRACIAS</span>}
            {message.undoMove && (
              <button
                onClick={() => onUndoMove(message.undoMove!)}
                aria-label="Deshacer movimiento"
                title="Devuelve los elementos a su carpeta de origen (pide confirmación)"
                className="rounded px-1.5 py-0.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
              >
                ↩ Deshacer
              </button>
            )}
          </div>
        )}
        {/* Las respuestas sin métrica (o en streaming ya terminado) también se pueden copiar. */}
        {!isUser && (metricId === undefined || message.streaming) && canCopy && !message.streaming && (
          <div className="mt-1 flex select-none items-center gap-1 pl-1">
            <button
              onClick={() => void copyText()}
              aria-label="Copiar respuesta"
              title="Copiar respuesta"
              className="rounded px-1.5 py-0.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
            >
              {copied ? "✓ Copiado" : "⧉ Copiar"}
            </button>
          </div>
        )}
        {/* Los mensajes propios también se pueden seleccionar y copiar. */}
        {isUser && canCopy && (
          <div className="mt-1 flex select-none items-center justify-end gap-1 pr-1">
            <button
              onClick={() => void copyText()}
              aria-label="Copiar mensaje"
              title="Copiar mensaje"
              className="rounded px-1.5 py-0.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
            >
              {copied ? "✓ Copiado" : "⧉ Copiar"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatBox({
  messages,
  listening,
  onToggleListen,
  onSend,
  metricIds,
  onRate,
  speaking,
  onStopSpeech,
  hasApiKey,
  onConfigure,
  busy,
  onCancelTask,
  onReveal,
  onUndoMove,
}: ChatBoxProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // Si el usuario subió a leer el historial, no se le arrastra abajo a la fuerza.
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="aster-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        {messages.length === 0 ? (
          <div className="flex min-h-full items-center justify-center">
            <div className="w-full max-w-lg space-y-4 py-2">
              <BlurText
                text="Hola, soy ASTER. Puedo abrir apps, buscar en la web, analizar tu pantalla, generar imágenes y gestionar archivos. ¿En qué te ayudo?"
                delay={35}
                animateBy="words"
                direction="top"
                className="mx-auto max-w-md select-text justify-center text-center text-sm text-aster-muted"
              />
              <div>
                <p className="mb-2 text-center text-[11px] font-semibold uppercase tracking-widest text-aster-muted">
                  Mis 8 acciones — toca una para probar
                </p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {CHEAT_SHEET.map((item) => (
                    <li key={item.action}>
                      <button
                        onClick={() => onSend(item.example)}
                        disabled={!hasApiKey}
                        title={item.example}
                        className="w-full rounded-xl border border-aster-border bg-aster-surface px-3 py-2 text-left transition hover:border-aster-accent hover:bg-aster-surface2 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <span className="block text-xs font-semibold text-aster-text">
                          {ASTER_ACTION_LABELS[item.action]}
                        </span>
                        <span className="block truncate text-[11px] text-aster-muted">
                          «{item.example}»
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <Bubble
              key={m.id}
              message={m}
              metricId={metricIds[m.id]}
              onRate={onRate}
              onReveal={onReveal}
              onUndoMove={onUndoMove}
            />
          ))
        )}
      </div>

      {/* Entrada */}
      <div className="shrink-0 border-t border-aster-border p-3 sm:p-4">
        <div className="mx-auto w-full max-w-3xl">
        {!hasApiKey ? (
          <button
            onClick={onConfigure}
            className="w-full rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200 transition hover:bg-amber-400/20"
          >
            Configura una clave de IA para empezar →
          </button>
        ) : (
          <div className="flex items-center gap-2 rounded-2xl border border-aster-border bg-aster-surface p-1.5 pl-4 focus-within:border-aster-accent">
            <button
              onClick={onToggleListen}
              title={listening ? "Detener escucha" : "Iniciar escucha por voz"}
              aria-label={listening ? "Detener escucha" : "Iniciar escucha por voz"}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${
                listening
                  ? "animate-pulse bg-aster-accent2 text-aster-bg"
                  : "text-aster-muted hover:bg-aster-surface2 hover:text-aster-text"
              }`}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" x2="12" y1="19" y2="22" />
              </svg>
            </button>
            <input
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Escribe una orden o pregunta a ASTER…"
              className="flex-1 bg-transparent text-sm text-aster-text placeholder:text-aster-muted focus:outline-none"
            />
            {speaking && (
              <button
                onClick={onStopSpeech}
                title="Detener la voz"
                className="rounded-xl border border-aster-border px-3 py-2 text-sm text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
              >
                ⏹
              </button>
            )}
            {busy && !speaking && (
              <button
                onClick={onCancelTask}
                title="Cancelar la tarea en curso"
                aria-label="Cancelar la tarea en curso"
                className="shrink-0 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200 transition hover:bg-amber-400/20"
              >
                ⏹ Cancelar
              </button>
            )}
            <StarBorder
              as="button"
              onClick={submit}
              color="#ffffff"
              speed="2.5s"
              thickness={2}
              textColor="inherit"
              borderColor="transparent"
              className="shrink-0 rounded-xl text-aster-bg"
              innerClassName="rounded-xl border border-transparent bg-gradient-to-r from-aster-accent to-aster-accent2 px-4 py-2 text-center text-sm font-semibold transition hover:brightness-110"
            >
              Enviar
            </StarBorder>
          </div>
        )}
        <p className="mt-2 text-center text-[11px] text-aster-muted">
          {busy
            ? "ASTER está trabajando… pulsa Cancelar para detener la tarea"
            : listening
              ? "ASTER te está escuchando… pulsa el micrófono para detener"
              : "Pulsa el micrófono para usar la voz"}
        </p>
        </div>
      </div>
    </section>
  );
}
