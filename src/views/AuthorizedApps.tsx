/**
 * AuthorizedApps: lista blanca de aplicaciones que Aster puede abrir.
 *
 * Es el control que impide la automatización de aplicaciones no autorizadas: el
 * backend solo lanza objetivos que estén aquí con la casilla marcada, y siempre
 * después de superar las guardas que prohíben comandos de shell y elevación de
 * privilegios.
 */
import { useCallback, useEffect, useState } from "react";
import type { UserProfile } from "../types/aster";
import { scanInstalledApps, setAppAllowed } from "../services/aster/commands";

interface AppEntry {
  displayName: string;
  target: string;
  allowed: boolean;
  source: string;
}

interface AuthorizedAppsProps {
  profile: UserProfile | null;
  onSaved: () => void;
}

export function AuthorizedApps({ profile, onSaved }: AuthorizedAppsProps) {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const detected = await scanInstalledApps();
      // Se combinan las aplicaciones ya registradas con las detectadas, para no
      // perder los permisos revocados ni las authorizes que ya tenías.
      const known = new Map<string, AppEntry>();
      for (const app of profile?.allowedApps ?? []) {
        known.set(app.displayName.toLowerCase(), {
          displayName: app.displayName,
          target: app.target,
          allowed: app.allowed,
          source: app.source,
        });
      }
      for (const app of detected) {
        const key = app.displayName.toLowerCase();
        if (!known.has(key)) known.set(key, app);
      }
      setApps(
        [...known.values()].sort((a, b) => {
          if (a.allowed !== b.allowed) return a.allowed ? -1 : 1;
          return a.displayName.localeCompare(b.displayName, "es");
        }),
      );
    } catch (error) {
      setNotice(`No se pudo detectar el menú Inicio: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [profile]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (app: AppEntry) => {
    setBusy(true);
    try {
      await setAppAllowed(app.displayName, app.target, !app.allowed);
      await reload();
      onSaved();
      setNotice(
        app.allowed
          ? `«${app.displayName}» ya no se puede abrir desde Aster.`
          : `«${app.displayName}» autorizada.`,
      );
    } catch (error) {
      setNotice(`No se pudo cambiar: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const visible = apps.filter((app) =>
    app.displayName.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const pendingToAllow = visible.filter((app) => !app.allowed).length;
  const pendingToRevoke = visible.filter((app) => app.allowed).length;

  const setAll = async (allowed: boolean) => {
    const targets = visible.filter((app) => app.allowed !== allowed);
    if (targets.length === 0 || busy) return;
    setBusy(true);
    let ok = 0;
    let failed = 0;
    try {
      for (const app of targets) {
        try {
          await setAppAllowed(app.displayName, app.target, allowed);
          ok++;
        } catch {
          failed++;
        }
      }
      await reload();
      onSaved();
      setNotice(
        allowed
          ? `Se autorizaron ${ok} aplicación${ok === 1 ? "" : "es"}${failed > 0 ? ` (${failed} omitida${failed === 1 ? "" : "s"} por seguridad)` : ""}.`
          : `Se quitaron ${ok} autorización${ok === 1 ? "" : "es"}${failed > 0 ? ` (${failed} con error)` : ""}.`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filtrar aplicaciones…"
          className="flex-1 rounded-lg border border-aster-border bg-aster-bg px-3 py-2 text-sm text-aster-text placeholder:text-aster-muted focus:border-aster-accent focus:outline-none"
        />
        <button
          onClick={reload}
          disabled={busy}
          className="rounded-lg border border-aster-border px-3 py-2 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text disabled:opacity-50"
        >
          {busy ? "Buscando…" : "Volver a escanear"}
        </button>
      </div>

      <p className="text-[11px] text-aster-muted">
        Aplicaciones autorizadas: <strong>{apps.filter((a) => a.allowed).length}</strong> de{" "}
        {apps.length} detectadas en el menú Inicio. Solo Aster puede abrir las marcadas.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void setAll(true)}
          disabled={busy || visible.length === 0 || pendingToAllow === 0}
          title={
            filter.trim()
              ? `Autoriza las ${visible.length} aplicaciones visibles del filtro`
              : "Autoriza todas las aplicaciones detectadas"
          }
          className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text disabled:opacity-50"
        >
          {busy ? "Aplicando…" : `Seleccionar todas${pendingToAllow > 0 ? ` (${pendingToAllow})` : ""}`}
        </button>
        <button
          onClick={() => void setAll(false)}
          disabled={busy || visible.length === 0 || pendingToRevoke === 0}
          title={
            filter.trim()
              ? `Quita la autorización a las ${visible.length} aplicaciones visibles del filtro`
              : "Quita la autorización a todas las aplicaciones"
          }
          className="rounded-lg border border-aster-border px-3 py-1.5 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text disabled:opacity-50"
        >
          {busy ? "Aplicando…" : "Quitar todas"}
        </button>
      </div>

      <ul className="aster-scroll max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">
        {visible.map((app) => (
          <li
            key={`${app.displayName}-${app.target}`}
            className="flex items-center justify-between gap-3 rounded-xl border border-aster-border bg-aster-bg px-3 py-2"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm text-aster-text">{app.displayName}</span>
              <span className="block truncate text-[11px] text-aster-muted">
                {app.source === "core" ? "propuesta por defecto" : app.target}
              </span>
            </span>
            <button
              onClick={() => toggle(app)}
              disabled={busy}
              role="switch"
              aria-checked={app.allowed}
              aria-label={app.displayName}
              className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                app.allowed ? "bg-aster-accent" : "bg-aster-surface2"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                  app.allowed ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
          </li>
        ))}
        {visible.length === 0 && <li className="text-sm text-aster-muted">Sin resultados.</li>}
      </ul>

      <p className="text-[11px] text-aster-muted">
        Bloqueados por diseño: ejecución de comandos de shell, elevación de privilegios, scripts y
        cualquier aplicación no marcada aquí.
      </p>

      {notice && <p className="text-xs text-aster-accent2">{notice}</p>}
    </div>
  );
}
