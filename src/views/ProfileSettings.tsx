/**
 * ProfileSettings: perfil de usuario y permisos por acción del catálogo.
 *
 * El perfil es el mecanismo de control de funciones que exige el proyecto: cada
 * una de las ocho acciones se puede activar o desactivar de forma individual y
 * el backend vuelve a comprobarlo en cada ejecución, no solo en la interfaz.
 */
import { useCallback, useEffect, useState } from "react";
import type { CatalogEntry, RootEntry, UserProfile } from "../types/aster";
import { ASTER_ACTION_LABELS, ASTER_ACTIONS, ASTER_CONFIRMED_ACTIONS } from "../types/aster";
import { allowedRoots, policyCatalog, updateProfile } from "../services/aster/commands";

interface ProfileSettingsProps {
  profile: UserProfile | null;
  onSaved: () => void;
}

export function ProfileSettings({ profile, onSaved }: ProfileSettingsProps) {
  const [name, setName] = useState(profile?.userName ?? "");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [roots, setRoots] = useState<RootEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    try {
      const [entries, rootEntries] = await Promise.all([policyCatalog(), allowedRoots()]);
      setCatalog(entries);
      setRoots(rootEntries);
    } catch (error) {
      console.error("[ASTER-perfil] no se pudo cargar:", error);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (action: (typeof ASTER_ACTIONS)[number]) => {
    const current = catalog.find((entry) => entry.action === action)?.enabled ?? true;
    setBusy(true);
    try {
      await updateProfile({ permissions: { [action]: !current } });
      await reload();
      onSaved();
      setNotice("");
    } catch (error) {
      setNotice(`No se pudo cambiar el permiso: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    setBusy(true);
    try {
      await updateProfile({ userName: name });
      onSaved();
      setNotice("Perfil actualizado.");
    } catch (error) {
      setNotice(`No se pudo guardar: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
          Perfil de usuario
        </h3>
        <div className="mt-2 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="Nombre del usuario"
            className="flex-1 rounded-lg border border-aster-border bg-aster-bg px-3 py-2 text-sm text-aster-text placeholder:text-aster-muted focus:border-aster-accent focus:outline-none"
          />
          <button
            onClick={saveName}
            disabled={busy}
            className="rounded-lg bg-aster-accent px-4 py-2 text-sm font-semibold text-aster-bg transition hover:brightness-110 disabled:opacity-50"
          >
            Guardar
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-aster-muted">
          Un único perfil por equipo. No hay gestión multiusuario.
        </p>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
          Catálogo cerrado de acciones
        </h3>
        <p className="mt-1 text-[11px] text-aster-muted">
          Solo estas ocho acciones son ejecutables. Las marcadas con confirmación escriben en tu
          disco y siempre te preguntan antes.
        </p>
        <ul className="mt-2 space-y-1.5">
          {ASTER_ACTIONS.map((action) => {
            const entry = catalog.find((item) => item.action === action);
            const guarded = ASTER_CONFIRMED_ACTIONS.includes(action);
            return (
              <li
                key={action}
                className="flex items-center justify-between gap-3 rounded-xl border border-aster-border bg-aster-bg px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block text-sm text-aster-text">
                    {ASTER_ACTION_LABELS[action]}
                  </span>
                  <span className="block text-[11px] text-aster-muted">
                    {action}
                    {guarded && " · exige confirmación"}
                  </span>
                </span>
                <button
                  onClick={() => toggle(action)}
                  disabled={busy}
                  role="switch"
                  aria-checked={entry?.enabled ?? true}
                  aria-label={ASTER_ACTION_LABELS[action]}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                    entry?.enabled === false ? "bg-aster-surface2" : "bg-aster-accent"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                      entry?.enabled === false ? "left-0.5" : "left-[22px]"
                    }`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-widest text-aster-muted">
          Carpetas autorizadas para archivos
        </h3>
        <ul className="mt-2 space-y-1 text-xs text-aster-muted">
          {roots.map((root) => (
            <li key={root.path} className="break-all font-mono">
              {root.label}: {root.path}
            </li>
          ))}
          {roots.length === 0 && <li>No hay carpetas configuradas.</li>}
        </ul>
        <p className="mt-1.5 text-[11px] text-aster-muted">
          Aster nunca lee ni escribe fuera de estas carpetas. No se permite tocar el sistema
          operativo, el registro ni ejecutar comandos.
        </p>
      </section>

      {notice && <p className="text-xs text-aster-accent2">{notice}</p>}
    </div>
  );
}
