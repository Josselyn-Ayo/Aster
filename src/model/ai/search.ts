/**
 * Búsqueda en Internet con coste cero de cuota de búsqueda (capa Model).
 *
 * Gemini con Google Search tiene una cuota aparte que en la capa gratuita está
 * a cero, así que la búsqueda no puede depender de él. El flujo es:
 *
 *  1. `web_search` (Rust) consulta DuckDuckGo (o Bing si hay captcha) y
 *     devuelve el texto de las primeras páginas.
 *  2. El modelo de conversación (Groq por defecto) resume esos textos.
 *  3. Solo si lo anterior falla se usa la capacidad `search` configurada
 *     (Gemini + Google Search u otro proveedor con búsqueda integrada).
 *
 * Las fuentes que se muestran al usuario son los enlaces reales de los
 * resultados, no los que cite el modelo.
 */
import { searchWeb, type WebSearchHit } from "../../services/web/search";
import { runAi } from "./registry";
import type { SearchResponse, TextResponse } from "./types";

/** Presupuesto de contexto: suficiente para cifras y fechas, corto en tokens. */
const MAX_CONTEXT_CHARS = 10000;
const MAX_CONTENT_CHARS = 2600;
const MAX_SNIPPET_CHARS = 320;
const SEARCH_MAX_OUTPUT_TOKENS = 512;

const SEARCH_SYSTEM_PROMPT = [
  "Eres el buscador de ASTER.",
  "Respondes en el idioma del usuario, de forma directa y concisa (máximo 5 frases),",
  "usando SOLO la información de las fuentes.",
  "Incluye cifras y fechas concretas cuando sean relevantes.",
  "Si las fuentes no responden a la consulta, dilo con claridad.",
  "No menciones la búsqueda ni enumeres las fuentes en el texto: se muestran aparte.",
].join(" ");

/** Colapsa saltos de línea y espacios repetidos. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Idioma del sistema (`es-PE`), vacío si el entorno no lo expone. */
function detectLocale(): string {
  return typeof navigator === "undefined" ? "" : navigator.language;
}

/**
 * Instrucciones del buscador. La pista regional evita responder con el precio
 * del dólar de otro país cuando la consulta no lo especifica.
 */
function searchPrompt(locale: string): string {
  const region = locale.replace("_", "-").trim();
  if (!region) return SEARCH_SYSTEM_PROMPT;
  return (
    `${SEARCH_SYSTEM_PROMPT} El usuario tiene la configuración regional «${region}»: ` +
    "si la consulta depende del país (moneda, precios, leyes, noticias), prioriza " +
    "fuentes de ese país y di a qué país corresponde cada dato."
  );
}

/**
 * Construye el contexto que ve el modelo: una ficha por resultado, con el
 * resumen del buscador y el texto de la página. Se corta al agotar el
 * presupuesto para no disparar los tokens de entrada.
 */
export function buildSearchContext(hits: WebSearchHit[]): string {
  const blocks: string[] = [];
  let size = 0;

  for (const [index, hit] of hits.entries()) {
    const snippet = oneLine(hit.snippet).slice(0, MAX_SNIPPET_CHARS);
    const content = oneLine(hit.content).slice(0, MAX_CONTENT_CHARS);
    const block = [
      `[${index + 1}] ${oneLine(hit.title)}`,
      hit.url,
      snippet ? `Resumen: ${snippet}` : "",
      content ? `Contenido: ${content}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (size + block.length > MAX_CONTEXT_CHARS && blocks.length > 0) break;
    blocks.push(block);
    size += block.length;
  }

  return blocks.join("\n\n");
}

/** Pide al modelo de conversación que resuma los resultados. */
async function synthesize(
  query: string,
  hits: WebSearchHit[],
  locale: string,
): Promise<string> {
  const context = buildSearchContext(hits);
  if (!context) return "";

  const result = await runAi<TextResponse>("chat", {
    system: searchPrompt(locale),
    messages: [
      {
        role: "user",
        content: `Consulta: ${query}\n\nFuentes:\n${context}\n\nRespuesta:`,
      },
    ],
    maxOutputTokens: SEARCH_MAX_OUTPUT_TOKENS,
    temperature: 0.2,
  });
  return result.text.trim();
}

/** Búsqueda local: resultados reales + resumen del modelo de chat. */
async function searchLocal(
  query: string,
  locale: string,
): Promise<(SearchResponse & { query: string }) | null> {
  const hits = await searchWeb(query, locale);
  if (hits.length === 0) return null;

  const answer = await synthesize(query, hits, locale);
  if (!answer) return null;

  return {
    answer,
    sources: hits.map((hit) => ({ uri: hit.url, title: hit.title })),
    query,
  };
}

/** Respaldo: proveedor con búsqueda integrada (Gemini + Google Search). */
async function searchGrounded(query: string): Promise<SearchResponse & { query: string }> {
  const result = await runAi<SearchResponse>("search", { query });
  if (!result.answer.trim()) throw new Error("La búsqueda no devolvió resultados.");
  return { ...result, query };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Busca en Internet y devuelve una respuesta sintetizada con sus fuentes.
 * Primero usa la búsqueda local (sin cuota) y solo después el respaldo.
 */
export async function webSearch(
  query: string,
  locale = detectLocale(),
): Promise<SearchResponse & { query: string }> {
  const term = query.trim();
  if (!term) throw new Error("No hay nada que buscar.");

  let localError: unknown = null;
  try {
    const local = await searchLocal(term, locale);
    if (local) return local;
  } catch (error) {
    localError = error;
  }

  try {
    return await searchGrounded(term);
  } catch (error) {
    if (!localError) throw error;
    throw new Error(
      `No pude completar la búsqueda. Búsqueda local: ${describe(localError)} · ` +
        `Respaldo: ${describe(error)}`,
    );
  }
}
