/**
 * Componente principal de ASTER.
 * Layout sin barra lateral: header superior colapsable (también barra de
 * título propia y arrastrable; solo aparece al pasar el mouse por la franja
 * superior), Visualizer (esfera indicadora de estado) y ChatBox (conversación
 * con micrófono integrado en la barra de chat).
 */
import { useEffect, useState } from "react";
import { Visualizer } from "./views/Visualizer";
import { ChatBox } from "./views/ChatBox";
import { ErrorBoundary } from "./views/ErrorBoundary";
import { SettingsModal } from "./views/SettingsModal";
import { ConfirmDialog } from "./views/ConfirmDialog";
import { HistoryPanel } from "./views/HistoryPanel";
import { useAster } from "./hooks/useAster";
import { useAiConfig } from "./hooks/useAiConfig";
import ShinyText from "./views/bits/ShinyText";

/** Ventana actual de Tauri (import dinámico: en navegador/test no hace nada). */
async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

function toggleMaximize() {
  currentWindow()
    ?.then((w) => w.toggleMaximize())
    .catch(() => {});
}

function IconButton({
  onClick,
  title,
  label,
  children,
}: {
  onClick: () => void;
  title: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center rounded-lg border border-aster-border text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
    >
      {children}
    </button>
  );
}

/** Minimizar / maximizar / cerrar con la estética ASTER. */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    currentWindow()
      .then((w) => w.isMaximized())
      .then((v) => {
        if (alive) setMaximized(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const base =
    "flex h-9 w-10 items-center justify-center rounded-lg text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text";

  return (
    <>
      <button
        onClick={() => {
          currentWindow()
            ?.then((w) => w.minimize())
            .catch(() => {});
        }}
        title="Minimizar"
        aria-label="Minimizar"
        className={base}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        onClick={() => {
          currentWindow()
            ?.then((w) => w.toggleMaximize())
            .then(() => setMaximized((m) => !m))
            .catch(() => {});
        }}
        title={maximized ? "Restaurar" : "Maximizar"}
        aria-label={maximized ? "Restaurar" : "Maximizar"}
        className={base}
      >
        {maximized ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
          </svg>
        )}
      </button>
      <button
        onClick={() => {
          currentWindow()
            ?.then((w) => w.close())
            .catch(() => {});
        }}
        title="Cerrar"
        aria-label="Cerrar"
        className={`${base} hover:bg-red-500/80 hover:text-white`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </>
  );
}

function App() {
  const aster = useAster();
  const { config, replace, hasAnyKey } = useAiConfig();
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // Solo en Tauri existen los controles de ventana; en navegador se ocultan.
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    let alive = true;
    currentWindow()
      .then(() => {
        if (alive) setIsTauri(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const toggleListen = () => {
    if (aster.state === "listening") {
      aster.stopListening();
    } else {
      void aster.listen();
    }
  };

  return (
    <ErrorBoundary>
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-aster-bg">
      {/* Franja superior: al pasar el mouse despliega el header completo. */}
      <div className="group/chrome absolute inset-x-0 top-0 z-40 [@media(hover:none)]:static">
        {/* Solo la zona del título arrastra la ventana: los botones quedan fuera para que el clic siempre llegue. */}
        <header
          className="pointer-events-none flex -translate-y-2 items-center justify-between gap-3 border-b border-aster-border bg-aster-surface/90 opacity-0 shadow-lg shadow-black/30 backdrop-blur transition-all duration-200 group-hover/chrome:pointer-events-auto group-hover/chrome:translate-y-0 group-hover/chrome:opacity-100 group-focus-within/chrome:pointer-events-auto group-focus-within/chrome:translate-y-0 group-focus-within/chrome:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100 px-4 py-2.5"
        >
          <div
            data-tauri-drag-region
            onDoubleClick={toggleMaximize}
            className="flex min-w-0 flex-1 items-center gap-3"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-aster-accent to-aster-accent2 text-base font-bold text-aster-bg">
              A
            </div>
            <div className="min-w-0">
              <h1 className="font-display truncate text-base font-bold tracking-wider">
                <ShinyText text="ASTER" speed={3} color="#b08fae" shineColor="#f8eef5" />
              </h1>
              <p className="truncate text-[11px] text-aster-muted">Asistente Multimodal</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <IconButton
              onClick={() => setShowHistory(true)}
              title="Historial"
              label="Historial"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M12 7v5l4 2" />
              </svg>
            </IconButton>
            <IconButton
              onClick={aster.clearConversation}
              title="Limpiar conversación"
              label="Limpiar conversación"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </IconButton>
            <IconButton
              onClick={() => setShowSettings(true)}
              title="Configurar"
              label="Configurar"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </IconButton>

            {isTauri && (
              <>
                <div className="mx-1 h-6 w-px shrink-0 bg-aster-border" aria-hidden="true" />
                <div className="flex items-center gap-1">
                  <WindowControls />
                </div>
              </>
            )}
          </div>
        </header>
        {/* Zona de hover/arrastre superpuesta (8px < relleno superior del header: no tapa botones). */}
        <div
          data-tauri-drag-region
          onDoubleClick={toggleMaximize}
          title="Pasar el mouse para mostrar la barra · doble clic para maximizar"
          className="absolute inset-x-0 top-0 h-2 w-full [@media(hover:none)]:hidden"
        />
      </div>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Visualizer state={aster.state} />
        <ChatBox
          messages={aster.messages}
          listening={aster.state === "listening"}
          onToggleListen={toggleListen}
          onSend={aster.sendText}
          metricIds={aster.metricIds}
          onRate={(messageId, vote) => void aster.rateMessage(messageId, vote)}
          speaking={aster.state === "speaking"}
          onStopSpeech={aster.cancelSpeech}
          busy={aster.busy}
          onCancelTask={aster.cancelTask}
          hasApiKey={hasAnyKey}
          onConfigure={() => setShowSettings(true)}
          onReveal={(path) => aster.revealPath(path)}
          onUndoMove={(info) => void aster.undoMove(info)}
        />
      </main>

      {aster.pending && (
        <ConfirmDialog
          pending={aster.pending}
          onConfirm={() => void aster.confirmOperation()}
          onReject={() => void aster.rejectOperation()}
        />
      )}

      {showHistory && <HistoryPanel onClose={() => setShowHistory(false)} />}

      {showSettings && (
        <SettingsModal
          config={config}
          onSave={replace}
          onClose={() => setShowSettings(false)}
          profile={aster.policy.profile}
          onProfileSaved={() => void aster.refreshPolicy()}
        />
      )}
    </div>
    </ErrorBoundary>
  );
}

export default App;
