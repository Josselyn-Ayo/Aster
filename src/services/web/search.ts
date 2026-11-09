/**
 * Búsqueda web delegada al backend (capa Services).
 *
 * El comando Rust `web_search` consulta DuckDuckGo (con Bing de respaldo) y
 * devuelve el texto legible de las primeras páginas. Se hace en Rust porque los
 * buscadores no permiten CORS y el `fetch` del WebView sería rechazado.
 */
import { invoke } from "@tauri-apps/api/core";

/** Un resultado con el texto ya extraído de la página. */
export interface WebSearchHit {
  title: string;
  url: string;
  /** Resumen que muestra el buscador. */
  snippet: string;
  /** Texto de la página; vacío si no se pudo descargar. */
  content: string;
}

/** Busca en Internet y devuelve los resultados con su contenido. */
export function searchWeb(query: string, locale: string): Promise<WebSearchHit[]> {
  return invoke("web_search", { query, locale });
}
