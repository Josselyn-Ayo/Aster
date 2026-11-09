/**
 * Hook de configuración de IA (capa View).
 *
 * Solo lee y persiste el modelo; toda la validación y los valores por defecto
 * viven en `src/model/ai/config.ts`.
 */
import { useCallback, useEffect, useState } from "react";
import {
  loadAiConfig,
  PROVIDER_IDS,
  resolveApiKey,
  saveAiConfig,
  type AiConfig,
  type Capability,
  type ProviderCredentials,
  type ProviderId,
  type Route,
} from "../model/ai";

export function useAiConfig() {
  const [config, setConfig] = useState<AiConfig>(() => loadAiConfig());
  /** Proveedores con clave disponible en el `.env` (la resuelve el backend). */
  const [envKeys, setEnvKeys] = useState<Partial<Record<ProviderId, boolean>>>({});
  /** Si ya se comprobó el `.env` (evita el parpadeo del CTA al arrancar). */
  const [keysChecked, setKeysChecked] = useState(false);

  // Una clave del `.env` también habilita el asistente: sin esto, la interfaz
  // pediría configurar una clave aunque el backend ya la tenga.
  useEffect(() => {
    let alive = true;
    void Promise.all(
      PROVIDER_IDS.map(async (id) => [id, Boolean(await resolveApiKey(id))] as const),
    ).then((entries) => {
      if (!alive) return;
      setEnvKeys(Object.fromEntries(entries));
      setKeysChecked(true);
    });
    return () => {
      alive = false;
    };
  }, [config]);

  /** ¿Hay al menos una clave utilizable (Ajustes o `.env`)? */
  const hasAnyKey =
    !keysChecked ||
    Object.entries(config.providers).some(
      ([id, credentials]) =>
        Boolean(credentials.apiKey?.trim()) || envKeys[id as ProviderId] === true,
    );

  /** Guarda una configuración completa (con normalización y migración). */
  const replace = useCallback((next: AiConfig) => {
    saveAiConfig(next);
    setConfig(loadAiConfig());
  }, []);

  /** Modifica las credenciales o el endpoint de un proveedor. */
  const patchProvider = useCallback(
    (provider: ProviderId, patch: Partial<ProviderCredentials>) => {
      const current = loadAiConfig();
      replace({
        ...current,
        providers: {
          ...current.providers,
          [provider]: { ...current.providers[provider], ...patch },
        },
      });
    },
    [replace],
  );

  /** Reemplaza un eslabón de la cadena de una capacidad. */
  const setRoute = useCallback(
    (capability: Capability, index: number, route: Route) => {
      const current = loadAiConfig();
      const routes = [...current.routes[capability]];
      routes[index] = route;
      replace({ ...current, routes: { ...current.routes, [capability]: routes } });
    },
    [replace],
  );

  /** Añade un respaldo al final de la cadena. */
  const addRoute = useCallback(
    (capability: Capability, route: Route) => {
      const current = loadAiConfig();
      replace({
        ...current,
        routes: {
          ...current.routes,
          [capability]: [...current.routes[capability], route],
        },
      });
    },
    [replace],
  );

  /** Quita un eslabón (nunca deja la cadena vacía). */
  const removeRoute = useCallback(
    (capability: Capability, index: number) => {
      const current = loadAiConfig();
      const routes = current.routes[capability].filter((_, i) => i !== index);
      if (routes.length === 0) return;
      replace({ ...current, routes: { ...current.routes, [capability]: routes } });
    },
    [replace],
  );

  return { config, replace, patchProvider, setRoute, addRoute, removeRoute, hasAnyKey };
}
