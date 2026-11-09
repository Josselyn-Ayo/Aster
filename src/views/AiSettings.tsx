/**
 * Ajustes de IA (capa View): claves por proveedor y cadena de respaldo por
 * capacidad. No guarda nada por su cuenta: edita un borrador y `SettingsModal`
 * lo persiste al pulsar «Guardar».
 */
import { useMemo, useState } from "react";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  DEFAULT_PROVIDERS,
  DEFAULT_ROUTES,
  PROVIDERS,
  PROVIDER_IDS,
  resolveApiKey,
  usageToday,
  type AiConfig,
  type Capability,
  type ProviderId,
  type Route,
} from "../model/ai";

interface AiSettingsProps {
  draft: AiConfig;
  onChange: (next: AiConfig) => void;
}

const inputClass =
  "w-full rounded-lg border border-aster-border bg-aster-bg px-3 py-2 text-sm text-aster-text placeholder:text-aster-muted focus:border-aster-accent focus:outline-none";

const labelClass = "text-xs font-semibold uppercase tracking-widest text-aster-muted";

export function AiSettings({ draft, onChange }: AiSettingsProps) {
  const [status, setStatus] = useState<Record<string, string>>({});

  const usage = useMemo(() => {
    const byProvider = new Map<ProviderId, number>();
    for (const entry of usageToday()) {
      byProvider.set(entry.provider, (byProvider.get(entry.provider) ?? 0) + entry.calls);
    }
    return [...byProvider.entries()];
  }, []);

  /** Comprueba que la clave y el endpoint responden (lista de modelos). */
  const testProvider = async (id: ProviderId) => {
    setStatus((current) => ({ ...current, [id]: "probando…" }));
    try {
      const provider = PROVIDERS[id];
      if (!provider.listModels) throw new Error("El proveedor no permite listar modelos.");
      const apiKey = draft.providers[id].apiKey?.trim() || (await resolveApiKey(id));
      if (provider.requiresKey && !apiKey) throw new Error("Falta la clave (Ajustes o .env).");
      const baseUrl =
        draft.providers[id].baseUrl || DEFAULT_PROVIDERS[id].baseUrl || "";
      const models = await provider.listModels({ apiKey, model: "", baseUrl });
      setStatus((current) => ({
        ...current,
        [id]: `Conexión correcta · ${models.length} modelos`,
      }));
    } catch (error) {
      setStatus((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message.slice(0, 120) : "Error de conexión",
      }));
    }
  };

  const patchProvider = (provider: ProviderId, patch: Partial<AiConfig["providers"][ProviderId]>) => {
    onChange({
      ...draft,
      providers: {
        ...draft.providers,
        [provider]: { ...draft.providers[provider], ...patch },
      },
    });
  };

  const patchRoute = (capability: Capability, index: number, patch: Partial<Route>) => {
    const routes = draft.routes[capability].map((route, i) =>
      i === index ? { ...route, ...patch } : route,
    );
    onChange({ ...draft, routes: { ...draft.routes, [capability]: routes } });
  };

  const addRoute = (capability: Capability) => {
    const used = new Set(draft.routes[capability].map((route) => route.provider));
    const provider = PROVIDER_IDS.find((id) => !used.has(id)) ?? "gemini";
    onChange({
      ...draft,
      routes: {
        ...draft.routes,
        [capability]: [...draft.routes[capability], { provider, model: "" }],
      },
    });
  };

  const removeRoute = (capability: Capability, index: number) => {
    const routes = draft.routes[capability].filter((_, i) => i !== index);
    if (routes.length === 0) return;
    onChange({ ...draft, routes: { ...draft.routes, [capability]: routes } });
  };

  const resetRoutes = () => {
    onChange({
      ...draft,
      routes: Object.fromEntries(
        CAPABILITIES.map((capability) => [
          capability,
          DEFAULT_ROUTES[capability].map((route) => ({ ...route })),
        ]),
      ) as AiConfig["routes"],
    });
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-aster-border bg-aster-bg/60 p-3 text-[12px] leading-relaxed text-aster-muted">
        <p>
          Cada tarea se atiende con el primer proveedor de su cadena que tenga clave.
          Si uno agota su cuota (<span className="text-aster-text">429</span>), ASTER pasa
          al siguiente sin reintentar, así que una clave gratuita puede durar todo el día.
        </p>
        <p className="mt-1">
          Las claves del <code className="text-aster-text">.env</code> se leen en el backend:
          no se incrustan en el instalador. Una clave escrita aquí tiene prioridad.
        </p>
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-aster-text">Proveedores</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {PROVIDER_IDS.map((id) => {
            const provider = PROVIDERS[id];
            const credentials = draft.providers[id];
            const defaults = DEFAULT_PROVIDERS[id];
            return (
              <div
                key={id}
                className="rounded-lg border border-aster-border bg-aster-bg/40 p-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-aster-text">{provider.label}</span>
                  {!provider.requiresKey && (
                    <span className="text-[10px] uppercase tracking-wider text-aster-muted">
                      local
                    </span>
                  )}
                </div>

                {provider.requiresKey && (
                  <label className="mt-2 block">
                    <span className="text-[11px] text-aster-muted">
                      Clave · o variable{" "}
                      <code className="text-aster-text">{credentials.envVar ?? defaults.envVar}</code>
                    </span>
                    <input
                      type="password"
                      value={credentials.apiKey ?? ""}
                      onChange={(event) => patchProvider(id, { apiKey: event.currentTarget.value })}
                      placeholder="(se usa la del .env)"
                      className={`${inputClass} mt-1`}
                    />
                  </label>
                )}

                {defaults.baseUrl !== undefined && (
                  <label className="mt-2 block">
                    <span className="text-[11px] text-aster-muted">Endpoint</span>
                    <input
                      value={credentials.baseUrl ?? ""}
                      onChange={(event) =>
                        patchProvider(id, { baseUrl: event.currentTarget.value })
                      }
                      className={`${inputClass} mt-1`}
                    />
                  </label>
                )}

                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => void testProvider(id)}
                    className="rounded border border-aster-border px-2 py-1 text-[11px] text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
                  >
                    Probar conexión
                  </button>
                  {status[id] && (
                    <span className="truncate text-[11px] text-aster-muted" title={status[id]}>
                      {status[id]}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-aster-text">Enrutado por tarea</h3>
          <button
            onClick={resetRoutes}
            className="rounded-lg border border-aster-border px-2.5 py-1 text-[11px] text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
          >
            Reparto recomendado
          </button>
        </div>

        <div className="space-y-3">
          {CAPABILITIES.map((capability) => (
            <div key={capability} className="rounded-lg border border-aster-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className={labelClass}>{CAPABILITY_LABELS[capability]}</span>
                <button
                  onClick={() => addRoute(capability)}
                  className="rounded border border-aster-border px-2 py-0.5 text-[11px] text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
                >
                  + respaldo
                </button>
              </div>

              <div className="mt-2 space-y-1.5">
                {capability === "search" && (
                  <p className="text-[11px] leading-relaxed text-aster-muted">
                    ASTER busca primero en DuckDuckGo y resume con el modelo de
                    conversación, sin gastar cuota de búsqueda. Esta cadena solo se usa
                    si esa búsqueda falla.
                  </p>
                )}
                {draft.routes[capability].map((route, index) => (
                  <div key={`${capability}-${index}`} className="flex items-center gap-1.5">
                    <span className="w-4 shrink-0 text-center text-[11px] text-aster-muted">
                      {index + 1}
                    </span>
                    <select
                      value={route.provider}
                      onChange={(event) =>
                        patchRoute(capability, index, {
                          provider: event.currentTarget.value as ProviderId,
                        })
                      }
                      className="w-36 shrink-0 rounded-lg border border-aster-border bg-aster-bg px-2 py-1.5 text-xs text-aster-text focus:border-aster-accent focus:outline-none"
                    >
                      {PROVIDER_IDS.map((id) => (
                        <option key={id} value={id}>
                          {PROVIDERS[id].label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={route.model}
                      onChange={(event) =>
                        patchRoute(capability, index, { model: event.currentTarget.value })
                      }
                      placeholder="modelo"
                      className="min-w-0 flex-1 rounded-lg border border-aster-border bg-aster-bg px-2 py-1.5 text-xs text-aster-text placeholder:text-aster-muted focus:border-aster-accent focus:outline-none"
                    />
                    {draft.routes[capability].length > 1 && (
                      <button
                        onClick={() => removeRoute(capability, index)}
                        title="Quitar de la cadena"
                        aria-label="Quitar de la cadena"
                        className="shrink-0 rounded border border-aster-border px-2 py-1 text-xs text-aster-muted transition hover:bg-aster-surface2 hover:text-aster-text"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {usage.length > 0 && (
        <section>
          <h3 className="mb-1 text-sm font-semibold text-aster-text">Consumo de hoy</h3>
          <p className="text-[12px] text-aster-muted">
            {usage.map(([provider, calls]) => `${PROVIDERS[provider].label}: ${calls}`).join(" · ")}
          </p>
        </section>
      )}
    </div>
  );
}
