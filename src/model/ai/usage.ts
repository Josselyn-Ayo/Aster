/**
 * Contador local de llamadas a los modelos (capa Model).
 *
 * Sirve para comprobar de un vistazo qué proveedor está gastando la cuota y
 * qué capacidad es la que más llama. No envía nada a ninguna parte: se guarda
 * en `aster.ai.usage` y se reinicia solo cada día.
 */
import type { Capability, ProviderId } from "./types";

const STORAGE_KEY = "aster.ai.usage";

interface UsageState {
  /** Día al que corresponden los contadores (YYYY-MM-DD, hora local). */
  date: string;
  /** Clave `proveedor:capacidad` -> número de llamadas. */
  buckets: Record<string, number>;
}

function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** `localStorage` puede no existir (tests en Node): el contador es opcional. */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): UsageState {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UsageState>;
      if (parsed.date === today() && parsed.buckets && typeof parsed.buckets === "object") {
        return { date: parsed.date, buckets: parsed.buckets };
      }
    }
  } catch {
    /* contador corrupto: se reinicia */
  }
  return { date: today(), buckets: {} };
}

/** Suma una llamada al contador del proveedor y la capacidad. */
export function recordUsage(provider: ProviderId, capability: Capability): void {
  const state = read();
  const key = `${provider}:${capability}`;
  state.buckets[key] = (state.buckets[key] ?? 0) + 1;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* sin espacio o almacenamiento bloqueado: el contador es best-effort */
  }
}

/** Consumo de hoy, ordenado de mayor a menor. */
export function usageToday(): Array<{
  provider: ProviderId;
  capability: Capability;
  calls: number;
}> {
  return Object.entries(read().buckets)
    .map(([key, calls]) => {
      const [provider, capability] = key.split(":") as [ProviderId, Capability];
      return { provider, capability, calls };
    })
    .filter((entry) => entry.calls > 0)
    .sort((a, b) => b.calls - a.calls);
}

/** Total de llamadas de hoy (todas las capacidades). */
export function totalCallsToday(): number {
  return Object.values(read().buckets).reduce((sum, calls) => sum + calls, 0);
}

/** Borra el contador (útil al cambiar de reparto de proveedores). */
export function clearUsage(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* almacenamiento bloqueado: nada que borrar */
  }
}
