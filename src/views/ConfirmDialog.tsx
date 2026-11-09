/**
 * ConfirmDialog: confirmación explícita para las acciones que modifican el
 * sistema de archivos (crear carpeta, crear archivo y mover).
 *
 * El diálogo no es la única barrera: la operación ya está preparada y caducada
 * en el backend, y sin esta aprobación nunca llega a ejecutarse. Cancelar
 * también queda registrado en el historial de acciones.
 */
import { useEffect } from "react";
import type { PendingConfirmation } from "../controllers/AsterController";

interface ConfirmDialogProps {
  pending: PendingConfirmation;
  onConfirm: () => void;
  onReject: () => void;
}

export function ConfirmDialog({ pending, onConfirm, onReject }: ConfirmDialogProps) {
  const { operation } = pending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc equivale a cancelar: nunca ejecuta nada.
      if (e.key === "Escape") onReject();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onReject]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-aster-border bg-aster-surface p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-400/15 text-lg text-amber-300">
            ⚠
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-base font-bold text-aster-text">
              Confirmar: {operation.title}
            </h2>
            <p className="mt-1 text-sm text-aster-text/90">{operation.summary}</p>
          </div>
        </div>

        {operation.details.length > 0 && (
          <ul className="aster-scroll mt-4 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-aster-border bg-aster-bg p-3 text-xs text-aster-muted">
            {operation.details.map((detail) => (
              <li key={detail} className="break-all font-mono">
                {detail}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] text-aster-muted">
          Esta operación modifica tu sistema de archivos y quedará registrada en el historial de
          acciones. Caduca el {operation.expiresAt}.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onReject}
            className="rounded-lg border border-aster-border px-4 py-2 text-sm text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-gradient-to-r from-aster-accent to-aster-accent2 px-4 py-2 text-sm font-semibold text-aster-bg transition hover:brightness-110"
          >
            Confirmar y ejecutar
          </button>
        </div>
      </div>
    </div>
  );
}
