/**
 * Servicio de Automatización del Sistema desde el frontend.
 *
 * Traduce una `AutomationAction` (interpretada por Gemini) en una llamada IPC
 * hacia el backend nativo de Rust, que ejecuta la acción sobre el sistema
 * operativo (abrir YouTube, Spotify, aplicaciones locales o una URL).
 */
import { invoke } from "@tauri-apps/api/core";
import type { AutomationAction } from "../../types";

/**
 * Ejecuta una acción de automatización. Delega en los comandos Rust
 * `play_youtube`, `play_spotify`, `launch_app` y `open_url`.
 */
export async function executeAutomation(action: AutomationAction): Promise<string> {
  switch (action.kind) {
    case "youtube":
      await invoke("play_youtube", { query: action.target.trim() });
      return `Abriendo en YouTube: "${action.target}"`;
    case "spotify":
      await invoke("play_spotify", { uriOrQuery: action.target.trim() });
      return `Abriendo en Spotify: "${action.target}"`;
    case "launch_app":
      await invoke("launch_app", { appName: action.target });
      return `Lanzando la aplicación: "${action.target}"`;
    case "open_url": {
      const trimmed = action.target.trim();
      if (!/^https?:\/\//i.test(trimmed)) {
        if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(trimmed)) {
          await invoke("open_url", { url: `https://${trimmed}` });
          return `Abriendo: "https://${trimmed}"`;
        }
        // Si no es URL, intentar abrir como aplicación autorizada
        try {
          const outcome = (await invoke("open_authorized_app", { appName: trimmed })) as { message?: string };
          return outcome?.message ?? `Lanzando la aplicación: "${trimmed}"`;
        } catch {
          await invoke("launch_app", { appName: trimmed });
          return `Lanzando la aplicación: "${trimmed}"`;
        }
      }
      await invoke("open_url", { url: trimmed });
      return `Abriendo: "${action.target}"`;
    }
    default:
      throw new Error(`Tipo de automatización desconocido: ${(action as { kind: string }).kind}`);
  }
}

/** Métodos directos para uso programático desde la UI (botones rápidos). */
export const openUrl = (url: string) => invoke("open_url", { url });
export const launchApp = (appName: string) => invoke("launch_app", { appName });
export const searchYoutube = (query: string) => invoke("play_youtube", { query: query.trim() });
export const searchSpotify = (query: string) => invoke("play_spotify", { uriOrQuery: query.trim() });
