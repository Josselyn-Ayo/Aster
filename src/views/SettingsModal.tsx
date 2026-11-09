/**
 * SettingsModal: configuración de la aplicación.
 *
 * Cuatro pestañas: IA (claves por proveedor y cadena de respaldo), perfil y
 * permisos, aplicaciones autorizadas y política de voz y datos.
 */
import { useEffect, useState } from "react";
import type { AiConfig } from "../model/ai";
import type { UserProfile } from "../types/aster";
import { AiSettings } from "./AiSettings";
import { ProfileSettings } from "./ProfileSettings";
import { AuthorizedApps } from "./AuthorizedApps";
import { DataPolicy } from "./DataPolicy";

type SettingsTab = "ia" | "profile" | "apps" | "data";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "ia", label: "IA" },
  { id: "profile", label: "Perfil y permisos" },
  { id: "apps", label: "Apps autorizadas" },
  { id: "data", label: "Voz y datos" },
];

interface SettingsModalProps {
  config: AiConfig;
  onSave: (next: AiConfig) => void;
  onClose: () => void;
  /** Perfil de usuario actual (permisos, lista blanca de aplicaciones). */
  profile: UserProfile | null;
  /** Se invoca cuando el perfil o la lista de apps cambian. */
  onProfileSaved: () => void;
}

export function SettingsModal({
  config,
  onSave,
  onClose,
  profile,
  onProfileSaved,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("ia");
  // Borrador: los cambios se aplican al pulsar «Guardar».
  const [draft, setDraft] = useState<AiConfig>(config);

  const save = () => {
    onSave(draft);
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-aster-border bg-aster-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h2 className="font-display text-lg font-bold text-aster-text">Configuración</h2>
            <p className="text-xs text-aster-muted">
              Todo se guarda únicamente en este dispositivo.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-aster-border px-3 py-1.5 text-sm text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
          >
            Cerrar
          </button>
        </div>

        <nav className="flex flex-wrap gap-1 border-b border-aster-border px-6 pb-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                tab === item.id
                  ? "bg-aster-accent/15 font-semibold text-aster-accent2"
                  : "text-aster-muted hover:text-aster-text"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="aster-scroll flex-1 overflow-y-auto p-6">
          {tab === "ia" && (
            <div>
              <AiSettings draft={draft} onChange={setDraft} />

              <div className="mt-6 flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="rounded-lg border border-aster-border px-4 py-2 text-sm text-aster-muted transition hover:bg-aster-surface2"
                >
                  Cancelar
                </button>
                <button
                  onClick={save}
                  className="rounded-lg bg-gradient-to-r from-aster-accent to-aster-accent2 px-4 py-2 text-sm font-semibold text-aster-bg transition hover:brightness-110"
                >
                  Guardar
                </button>
              </div>
            </div>
          )}

          {tab === "profile" && (
            <ProfileSettings profile={profile} onSaved={onProfileSaved} />
          )}
          {tab === "apps" && <AuthorizedApps profile={profile} onSaved={onProfileSaved} />}
          {tab === "data" && <DataPolicy profile={profile} onSaved={onProfileSaved} />}
        </div>
      </div>
    </div>
  );
}
