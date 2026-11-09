/**
 * ErrorBoundary: red de seguridad de renderizado de ASTER.
 *
 * Si un dato corrupto (p. ej. localStorage) rompe un componente, muestra una
 * pantalla de recuperación en vez de dejar la app en negro.
 */
import { Component } from "react";
import type { ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Claves propias de ASTER en localStorage (para restablecer sin tocar otras apps). */
const ASTER_KEYS = [
  "aster.ai.config",
  "aster.ai.usage",
  "aster.gemini.config",
  "aster.speech.policy",
  "aster.conversation.history",
];

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("[ASTER] error de renderizado capturado:", error);
  }

  private resetData = () => {
    try {
      for (const key of ASTER_KEYS) localStorage.removeItem(key);
    } catch {
      /* almacenamiento no disponible: se recarga igualmente */
    }
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-aster-bg p-6">
        <div className="w-full max-w-md rounded-2xl border border-aster-border bg-aster-surface p-6 text-center shadow-2xl">
          <p className="text-3xl">⚠</p>
          <h1 className="mt-2 font-display text-lg font-bold text-aster-text">
            Algo se rompió en la interfaz
          </h1>
          <p className="mt-2 text-sm text-aster-muted">
            Tus archivos están intactos: es solo un error de renderizado.
          </p>
          <p className="mt-2 select-text break-words rounded-lg bg-aster-bg p-2 font-mono text-[11px] text-red-300">
            {this.state.error.message}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg border border-aster-border px-4 py-2 text-sm text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
            >
              Recargar
            </button>
            <button
              onClick={this.resetData}
              className="rounded-lg bg-gradient-to-r from-aster-accent to-aster-accent2 px-4 py-2 text-sm font-semibold text-aster-bg transition hover:brightness-110"
            >
              Restablecer datos locales
            </button>
          </div>
        </div>
      </div>
    );
  }
}
