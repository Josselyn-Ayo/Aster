/**
 * Enrutado de intenciones de ASTER (capa Model, sin efectos de red).
 *
 * Contiene la vía rápida local (`fastRoute`) —que resuelve los casos obvios con
 * cero llamadas al modelo—, las instrucciones del catálogo cerrado y el parseo
 * de la respuesta del router. Al estar libre de React y de SDK se puede probar
 * por completo sin API.
 */
import type { AutomationAction, ChatMessage } from "../../types";
import type { AsterIntent } from "../../types/aster";

/** Modelo por defecto para conversación / visión. */
export const DEFAULT_SYSTEM_PROMPT = [
  "Eres ASTER, un asistente virtual multimodal de escritorio con una personalidad futurista, minimalista, amable y concisa.",
  "Te comunicas en el idioma del usuario (preferentemente español).",
  "Eres capaz de: mantener conversaciones, analizar la pantalla del usuario (visión por computadora) y generar imágenes.",
  "Responde de forma directa y técnica cuando sea necesario, y mantén las respuestas naturales y sin excesos.",
].join("\n");

/** Identificador de un mensaje del historial. */
export type MessageId = ChatMessage["id"];

/** ¿El error es de cuota/límite (429 RESOURCE_EXHAUSTED)? */
export function isQuotaError(error: unknown): boolean {
  if (!error) return false;
  const code =
    (error as { status?: number; code?: number; statusCode?: number }).status ??
    (error as { code?: number }).code ??
    (error as { statusCode?: number }).statusCode;
  if (code === 429) return true;
  const msg = error instanceof Error ? error.message : "";
  let stringified = "";
  try {
    stringified = JSON.stringify(error, Object.getOwnPropertyNames(error));
  } catch {
    stringified = String(error);
  }
  const text = `${msg} ${stringified} ${String(error)}`.toLowerCase();
  return (
    text.includes("429") ||
    text.includes("resource_exhausted") ||
    text.includes("quota") ||
    text.includes("exceeded your current quota") ||
    text.includes("rate limit")
  );
}

export type Intent =
  | { type: "conversation" }
  | { type: "automation"; action: AutomationAction }
  | { type: "vision"; question: string }
  | { type: "image"; prompt: string }
  | AsterIntent;

/**
 * Contexto real del equipo que se inyecta en el enrutado para que el modelo no
 * invente rutas ni aplicaciones: solo puede proponer rutas dentro de las
 * carpetas autorizadas y solo puede abrir aplicaciones de la lista blanca.
 */
export interface RoutingContext {
  /** Carpetas donde el asistente puede buscar, crear y mover. */
  allowedRoots: string[];
  /** Aplicaciones que el usuario ha autorizado. */
  allowedApps: string[];
}

/** Resultado del enrutado: intención resuelta y confianza declarada. */
export interface RoutedIntent {
  intent: Intent;
  /** Confianza del modelo en la interpretación (0..1). */
  confidence: number;
}

/** Límite de aplicaciones incluidas en el prompt del router. */
const MAX_APPS_IN_PROMPT = 30;

/**
 * Instrucciones del catálogo cerrado de acciones de Aster que se añaden al
 * enrutado. Para ahorrar tokens, las listas grandes (apps, rutas) se truncan y
 * solo se incluyen cuando la petición parece necesitarlas.
 */
export function catalogInstructions(
  context: RoutingContext,
  opts: { wantsApps: boolean; wantsFiles: boolean },
): string[] {
  const roots = !opts.wantsFiles
    ? []
    : context.allowedRoots.length
      ? context.allowedRoots.slice(0, 8)
      : ["(ninguna carpeta configurada)"];
  const appNames = !opts.wantsApps
    ? []
    : context.allowedApps.slice(0, MAX_APPS_IN_PROMPT);
  const appsExtra =
    opts.wantsApps && context.allowedApps.length > MAX_APPS_IN_PROMPT
      ? ` …y ${context.allowedApps.length - MAX_APPS_IN_PROMPT} más`
      : "";
  const apps = appNames.length ? appNames.join(" | ") + appsExtra : "(lista omitida)";
  const lines = [
    "",
    "Catálogo cerrado de acciones de Aster (SOLO estas ocho):",
    '{"type":"open_authorized_app","app":"<nombre de la lista blanca>","confidence":<0-1>}',
    '{"type":"web_search","query":"<consulta>","openSources":<true|false>,"confidence":<0-1>}',
    '{"type":"system_info","topic":"<resumen|hardware|memoria|discos|bateria|procesos>","confidence":<0-1>}',
    '{"type":"find_files","query":"<texto o .extensión>","scope":"all|desktop|documents|downloads|pictures|music","foldersOnly":<true|false>,"confidence":<0-1>}',
    '{"type":"create_folder","path":"<ruta absoluta>","confidence":<0-1>}',
    '{"type":"create_file","path":"<ruta absoluta con nombre y extensión>","confidence":<0-1>}',
    '{"type":"move_files","sources":["<ruta absoluta>"],"destination":"<carpeta absoluta>","confidence":<0-1>}',
    '{"type":"action_history","action":"<acción o vacío>","limit":<n>,"confidence":<0-1>}',
  ];
  if (opts.wantsApps) {
    lines.push(
      "- `open_authorized_app`: úsala cuando pida abrir una aplicación por su nombre común. Solo se aceptan nombres de esta lista blanca: " +
        apps +
        ". Si la aplicación no está en la lista, devuelve igualmente el nombre pedido con confidence baja (0.3).",
    );
  }
  if (opts.wantsFiles) {
    const rootsStr = roots.join(" | ");
    lines.push(
      "- `create_folder`: úsala solo si pide crear una carpeta. La ruta DEBE estar dentro de: " +
        rootsStr +
        ". Si no dijo ruta, usa Documents. Si no puedes deducir una ruta válida, devuelve Documents.",
      "- `create_file`: úsala solo si pide crear un archivo (vacío). La ruta DEBE incluir nombre y extensión y estar dentro de: " +
        rootsStr +
        ". Si no dijo ruta, usa Documents.",
      "- `move_files`: úsala si pide mover/pasar archivos o carpetas. Todas las rutas dentro de: " +
        rootsStr +
        ". Si no deduces origen/destino válido, devuelve Documents como destino.",
      "- `find_files`: úsala si pide localizar un archivo o carpeta por nombre o extensión. No la uses si pide crearla o moverla. Si pide una **carpeta** (no un archivo), añade \"foldersOnly\": true.",
    );
  }
  lines.push(
    "- `automation` (existente) solo para YouTube, Spotify y URLs ya completas; `launch_app` queda reservado para cuando el usuario mencione un ejecutable concreto (por ejemplo «notepad.exe»).",
    "- `web_search`: úsala si pide información actual, hechos, precios, noticias o una definición externa. NO la uses para abrir una página concreta (eso es `automation`).",
    "- `system_info`: úsala si pregunta por el equipo: sistema operativo, procesador, memoria, disco, batería, procesos, tiempo encendido.",
    "- `action_history`: úsala si pregunta qué hizo, qué ha ejecutado, qué se abrió, el historial, el registro o las acciones realizadas.",
    "- Nunca inventes rutas fuera de las carpetas autorizadas ni acciones fuera del catálogo.",
    '- Añade siempre el campo "confidence" entre 0 y 1 según lo clara que sea la petición.',
  );
  return lines;
}

/** ¿La petición parece pedir abrir una aplicación? */
export function wantsAppList(text: string): boolean {
  return /abr|abrir|lanza|inicia|ejecuta|aplicaci|programa|chrome|edge|navegador|calculadora|notepad|spotify|youtube|url|p[aá]gina|sitio/i.test(
    text,
  );
}

/** ¿La petición parece operar con archivos/carpetas/historial? */
export function wantsFileContext(text: string): boolean {
  return /carpeta|archivo|fichero|documento|mover|mueve|pasa|crea|crear|busca.*archiv|encuentra|localiza|descargas|escritorio|ruta|historial|registro|bater|memoria|disco|sistema|equipo/i.test(
    text,
  );
}

/**
 * Extensión de archivo al final del texto: 2-5 caracteres alfanuméricos
 * («.pdf», «.docx», «.7z»). Evita falsos positivos como «3.0» o «v1.2».
 */
const FILE_QUERY_RE = /\.[a-z0-9]{2,5}$/i;

/**
 * Arranques que indican otra intención (una orden o una pregunta) y no un
 * nombre de archivo suelto: «abre hola.pdf» no es una búsqueda.
 */
const NOT_A_FILE_QUERY_RE =
  /^(?:abre|abrir|inicia|iniciar|lanza|lanzar|ejecuta|ejecutar|crea|crear|genera|generar|dibuja|descarga|descargar|mueve|mover|pasa|pasar|pon|poner|reproduce|reproducir|busca|buscar|encuentra|encontrar|localiza|localizar|que|qu[eé]|como|c[oó]mo|donde|d[oó]nde|cual|cu[aá]l|esto|eso|es|son|hay|no|ni|s[ií]|dime|explica|cu[eé]ntame|resume|traduce)\b/i;

/** ¿El texto es, por sí solo, un nombre de archivo o una extensión? */
function looksLikeFileQuery(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (!/^[^\\/:*?"<>|]+$/.test(value)) return false;
  if (NOT_A_FILE_QUERY_RE.test(value)) return false;
  return FILE_QUERY_RE.test(value);
}

/**
 * Extrae la consulta y el ámbito de una orden de búsqueda de archivos local.
 */
export function extractFileSearch(text: string): {
  query: string;
  scope: "all" | "desktop" | "documents" | "downloads" | "pictures" | "music";
  foldersOnly: boolean;
} | null {
  const hasVerb = /^(?:busca|buscar|encuentra|encontrar|localiza|localizar)\b/i.test(text);
  // No confundir con búsquedas web, videos o música online.
  if (/(?:en\s+(?:internet|la\s+web|google|youtube|spotify)|youtube|spotify)\b/i.test(text)) {
    return null;
  }

  let raw = hasVerb
    ? text.replace(/^(?:busca|buscar|encuentra|encontrar|localiza|localizar)\s+/i, "").trim()
    : text.trim();
  let scope: "all" | "desktop" | "documents" | "downloads" | "pictures" | "music" = "all";

  const parseScopeName = (
    name: string,
  ): "all" | "desktop" | "documents" | "downloads" | "pictures" | "music" => {
    const s = name.toLowerCase();
    if (s.includes("descarg") || s === "downloads") return "downloads";
    if (s.includes("doc") || s === "documents") return "documents";
    if (s.includes("escrit") || s === "desktop") return "desktop";
    if (s.includes("im") || s.includes("foto") || s === "pictures") return "pictures";
    if (s.includes("m") || s.includes("canci") || s === "music") return "music";
    return "all";
  };

  // Patrón 1: Ámbito al principio: "en (la carpeta de)? descargas <query>"
  const leadingScopeMatch = raw.match(
    /^(?:en\s+(?:la\s+carpeta\s+(?:de\s+)?|el\s+)?)?(descargas|documentos|escritorio|im[aá]genes|imagenes|fotos|m[uú]sica|musica|downloads|documents|desktop|pictures|music)\s+(.+)$/i,
  );

  if (leadingScopeMatch && leadingScopeMatch[1] && leadingScopeMatch[2]) {
    scope = parseScopeName(leadingScopeMatch[1]);
    raw = leadingScopeMatch[2].trim();
  } else {
    // Patrón 2: Ámbito al final: "<query> en (la carpeta de)? descargas"
    const trailingScopeMatch = raw.match(
      /^(.+?)\s+en\s+(?:la\s+carpeta\s+(?:de\s+)?|el\s+)?(descargas|documentos|escritorio|im[aá]genes|imagenes|fotos|m[uú]sica|musica|downloads|documents|desktop|pictures|music)$/i,
    );
    if (trailingScopeMatch && trailingScopeMatch[1] && trailingScopeMatch[2]) {
      scope = parseScopeName(trailingScopeMatch[2]);
      raw = trailingScopeMatch[1].trim();
    }
  }

  // «la carpeta Andi» o «carpetas llamadas Andi»: se piden carpetas, no archivos.
  const foldersOnly = /^(?:(?:el|la|los|las|un|una|unos|unas)\s+)?carpetas?\s+/i.test(raw);

  // Quita el sustantivo genérico con su artículo: "el archivo hola.pdf" -> "hola.pdf".
  raw = raw
    .replace(
      /^(?:(?:el|la|los|las|un|una|unos|unas)\s+)?(?:archivo|fichero|documento|carpeta)s?\s+/i,
      "",
    )
    .trim();

  // Limpia frases de presentación antes del nombre.
  raw = raw
    .replace(
      /^(?:(?:el|la|los|las|un|una|unos|unas)\s+)?(?:(?:archivo|carpeta|documento|fichero)s?\s+)?(?:que\s+se\s+llam[ae]n?\s+|(?:que\s+)?(?:se\s+)?(?:llama[dos]*|titula[dos]*|nombrado|llamada|llamados|llamadas)\s+|con\s+(?:el\s+)?nombre(?:\s+de)?\s+)/i,
      "",
    )
    .trim();

  raw = raw.replace(/^(?:el|la|los|las|un|una)\s+/i, "").trim();
  raw = raw.replace(/[.?!,]+$/, "").trim();

  if (!raw) return null;
  if (hasVerb) {
    const looksLikeFile =
      scope !== "all" ||
      /\.[a-z0-9]{1,6}\b/i.test(raw) ||
      /archivo|fichero|carpeta|documento/i.test(text);
    if (!looksLikeFile) return null;
  } else if (!looksLikeFileQuery(raw)) {
    return null;
  }
  return { query: raw, scope, foldersOnly };
}

/** Palabras de ámbito reconocidas al final de una orden de creación. */
const CREATE_SCOPE_RE =
  /^(?:descargas?|documentos?|escritorio|im[aá]genes?|imagenes|fotos?|m[uú]sica|musica|downloads?|documents?|desktop|pictures?|music)$/i;

/** Separa «nombre en <carpeta>» en nombre y carpeta destino. */
function splitNameAndScope(raw: string): { name: string; scope?: string } {
  const match = raw.match(/^(.+?)\s+en\s+(?:la\s+carpeta\s+(?:de\s+)?|el\s+)?([^\s]+)$/i);
  if (match && match[1] && match[2] && CREATE_SCOPE_RE.test(match[2])) {
    return { name: match[1].trim(), scope: match[2].trim() };
  }
  return { name: raw.trim() };
}

/**
 * Elige la carpeta autorizada para un ámbito («descargas», «documentos»…).
 * Sin ámbito usa la primera carpeta autorizada, o Documents como último recurso.
 */
function pickRoot(scope: string | undefined, roots: string[]): string {
  if (roots.length === 0) return "Documents";
  if (scope) {
    const s = scope.toLowerCase();
    const aliases = s.includes("descarg") || s.startsWith("download")
      ? ["descarg", "download"]
      : s.includes("doc") || s.startsWith("document")
        ? ["document", "doc"]
        : s.includes("escrit") || s.startsWith("desktop")
          ? ["escrit", "desktop"]
          : s.includes("imag") || s.includes("foto") || s.startsWith("pictur")
            ? ["imag", "pictur", "foto"]
            : s.includes("m") || s.startsWith("music")
              ? ["música", "musica", "music"]
              : [];
    const found = roots.find((r) => aliases.some((a) => r.toLowerCase().includes(a)));
    if (found) return found;
  }
  return roots.find((r) => /document/i.test(r)) ?? roots[0];
}

/** ¿El texto es una pregunta conversacional pura (sin acción)? */
function isPlainQuestion(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (value.endsWith("?")) return true;
  return /^(?:qu[eé]|qui[eé]n|qui[eé]nes|cu[aá]l|cu[aá]les|cu[aá]ndo|cu[aá]nto|cu[aá]nta|d[oó]nde|c[oó]mo|por\s+qu[eé]|para\s+qu[eé]|expl[ií]ca(?:me|lo)?|cu[eé]nta(?:me)?|dime|res[uú]me(?:me)?|traduce|habla(?:me)?\s+de)\b/i.test(
    value,
  );
}

/**
 * Enrutado local sin LLM para los casos obvios. Devuelve la intención cuando
 * hay coincidencia clara y `null` cuando conviene consultar al modelo.
 * Ahorra 1 llamada completa en la mayoría de los mensajes.
 */
export function fastRoute(userText: string, context?: RoutingContext): RoutedIntent | null {
  const lower = userText.trim().toLowerCase();
  if (!lower) return null;

  // Limpia palabras de invocación o cortesía al inicio ("Aster, abre...",
  // "Asisther, abre...", "Por favor abre..."). La invocación debe ir seguida de
  // un separador (espacio o coma), para no recortar «hola.pdf» a «.pdf».
  const cleaned = userText
    .replace(/^(?:(?:oye|hola|hey|aster|asister|asisther|por\s+favor)(?:\s*[,:]\s*|\s+))+/i, "")
    .trim();
  const textToMatch = cleaned || userText;

  // URLs directas -> abrir en navegador.
  const urlMatch = textToMatch.match(/https?:\/\/[^\s]+/i);
  if (urlMatch && /^(abre|abrir|visita|ve a|open)\b/i.test(textToMatch)) {
    return {
      intent: { type: "automation", action: { kind: "open_url", target: urlMatch[0] } },
      confidence: 0.95,
    };
  }
  // YouTube / Spotify explícitos.
  if (/youtube|pon.*(video|canci|m[uú]sica)|reproduce.*youtube/i.test(textToMatch)) {
    return {
      intent: { type: "automation", action: { kind: "youtube", target: textToMatch } },
      confidence: 0.9,
    };
  }
  if (/spotify/i.test(textToMatch)) {
    return {
      intent: { type: "automation", action: { kind: "spotify", target: textToMatch } },
      confidence: 0.9,
    };
  }
  // Visión de pantalla.
  if (/qu[eé] (ves|hay|est[aá]s viendo)|pantalla|estoy viendo|analiza mi pantalla/i.test(textToMatch)) {
    return { intent: { type: "vision", question: userText }, confidence: 0.9 };
  }
  // Generación de imágenes: "dibuja X" no necesita decir "imagen".
  if (/dibuja|haz.*dibujo/i.test(textToMatch)) {
    return { intent: { type: "image", prompt: userText }, confidence: 0.9 };
  }
  const imageMatch = textToMatch.match(
    /(?:genera|crea).{0,20}imagen(?:\s+(?:de|con|sobre)\s+(.+))?/i,
  );
  if (imageMatch && /genera.{0,20}imagen|crea.{0,20}imagen/i.test(textToMatch)) {
    return { intent: { type: "image", prompt: imageMatch[1]?.trim() || userText }, confidence: 0.9 };
  }

  // Búsqueda en la web explícita.
  const webMatch = textToMatch.match(
    /^(?:busca|buscar|investiga|investigar)\s+en\s+(?:internet|la\s+web|google)\s+(.+)$/i,
  );
  if (webMatch && webMatch[1]?.trim()) {
    return {
      intent: {
        type: "web_search",
        query: webMatch[1].trim().replace(/[.?!]+$/, ""),
        openSources: false,
      },
      confidence: 0.95,
    };
  }

  // Búsqueda de archivos local con 0 tokens.
  const fileSearch = extractFileSearch(textToMatch);
  if (fileSearch) {
    return {
      intent: {
        type: "find_files",
        query: fileSearch.query,
        scope: fileSearch.scope,
        foldersOnly: fileSearch.foldersOnly,
      },
      confidence: 0.9,
    };
  }

  // "busca <tema>" sin señales de archivo: búsqueda en Internet (0 tokens).
  const genericSearch = textToMatch.match(/^(?:busca|buscar|investiga|investigar)\s+(.+)$/i);
  if (genericSearch && genericSearch[1]?.trim()) {
    return {
      intent: {
        type: "web_search",
        query: genericSearch[1].trim().replace(/[.?!]+$/, ""),
        openSources: false,
      },
      confidence: 0.8,
    };
  }

  // "Abre X" donde X está literalmente en la lista blanca -> directo.
  const openMatch = textToMatch.match(
    /^(?:abre|abrir|inicia|lanza|ejecuta)(?:\s+(?:la|el|las|los))?\s+(.+?)[.!?]?$/i,
  );
  if (openMatch && context?.allowedApps?.length) {
    const asked = openMatch[1].trim().toLowerCase();
    const found = context.allowedApps.find(
      (name) =>
        name.toLowerCase() === asked ||
        name.toLowerCase().includes(asked) ||
        asked.includes(name.toLowerCase()),
    );
    if (found) {
      return { intent: { type: "open_authorized_app", app: found }, confidence: 0.9 };
    }
  }

  // Historial de acciones (0 tokens).
  if (
    /\b(?:historial|registro\s+de\s+(?:acciones|auditor[ií]a))\b/i.test(textToMatch) ||
    /^(?:(?:muestra|mostrar|ver|dame|ense[ñn]a|abrir)\s+(?:(?:el|las|los|la)\s+)?)?(?:[uú]ltimas\s+acciones|acciones\s+recientes)[.!?]?$/i.test(
      textToMatch,
    ) ||
    /^(?:qu[eé]\s+(?:has\s+hecho|hiciste|se\s+hizo|acciones\s+(?:has\s+)?realizado))[.!?]?$/i.test(
      textToMatch,
    )
  ) {
    return {
      intent: { type: "action_history", action: "", limit: 10 },
      confidence: 0.95,
    };
  }

  // Información / estado del sistema por palabra clave clara (0 tokens).
  if (
    /^(?:informaci[oó]n|informe|estado|resumen)\s+del\s+(?:sistema|equipo)[.!?]?$/i.test(
      textToMatch,
    ) ||
    /^(?:c[oó]mo\s+est[aá]\s+(?:el\s+sistema|el\s+equipo))[.!?]?$/i.test(textToMatch)
  ) {
    return { intent: { type: "system_info", topic: "resumen" }, confidence: 0.95 };
  }
  const sysMatch = textToMatch.match(
    /bater[ií]a|memoria(?: ram)?|disco|procesador|cpu|procesos|sistema operativo/i,
  );
  if (
    sysMatch &&
    /^(?:dime|muestra|cu[aá]l es|qu[eé]|c[oó]mo est[aá]|cu[aá]nta|espacio en|uso de)\b.{0,40}(?:bater|memoria|disco|procesador|cpu|procesos|sistema|equipo)/i.test(
      textToMatch,
    )
  ) {
    const topic = /bater/i.test(sysMatch[0])
      ? "bateria"
      : /memoria/i.test(sysMatch[0])
        ? "memoria"
        : /disco/i.test(sysMatch[0])
          ? "discos"
          : /proces/i.test(sysMatch[0])
            ? "procesos"
            : "resumen";
    return { intent: { type: "system_info", topic }, confidence: 0.9 };
  }

  // Creación de carpetas y archivos obvios (0 tokens).
  const createMatch = textToMatch.match(
    /^(?:crea|crear|haz)\s+(?:(?:un|una|el|la|los|las)\s+)?(carpeta|archivo|fichero|documento)(?:\s+(?:llamad[ao]s?|con\s+el\s+nombre(?:\s+de)?|de\s+nombre|que\s+se\s+llame))?\s+["']?([^"']+?)["']?[.!?]?$/i,
  );
  if (createMatch && createMatch[1] && createMatch[2]?.trim()) {
    const kind = createMatch[1].toLowerCase();
    const { name, scope } = splitNameAndScope(createMatch[2].trim().replace(/[.?!]+$/, ""));
    if (name) {
      const baseDir = pickRoot(scope, context?.allowedRoots ?? []);
      const sep = baseDir.endsWith("\\") || baseDir.endsWith("/") ? "" : "\\";
      const path = `${baseDir}${sep}${name}`;
      if (kind === "carpeta") {
        return { intent: { type: "create_folder", path }, confidence: 0.85 };
      }
      if (name.includes(".")) {
        return { intent: { type: "create_file", path }, confidence: 0.85 };
      }
    }
  }

  // Saludos directos (conversación con 0 tokens de router).
  if (
    /^(?:hola|buenos\s+d[ií]as|buenas\s+(?:tardes|noches)|adi[oó]s|hasta\s+luego|gracias|muchas\s+gracias)(?:\s+(?:aster|asisther))?[.!]?$/i.test(
      textToMatch,
    )
  ) {
    return { intent: { type: "conversation" }, confidence: 0.9 };
  }

  // Preguntas conversacionales puras: no necesitan clasificador, van directas
  // al modelo de conversación. Ahorra una llamada (y su cuota) por mensaje.
  if (
    isPlainQuestion(textToMatch) &&
    !wantsAppList(textToMatch) &&
    !wantsFileContext(textToMatch)
  ) {
    return { intent: { type: "conversation" }, confidence: 0.75 };
  }

  // Conversación pura: sin ningún verbo de acción ni sustantivo de sistema.
  if (
    !wantsAppList(textToMatch) &&
    !wantsFileContext(textToMatch) &&
    !/busca|precio|noticia|qu[eé] es|qui[eé]n|dime|explica|resume|traduce|genera|crea/i.test(
      textToMatch,
    )
  ) {
    return { intent: { type: "conversation" }, confidence: 0.6 };
  }
  return null;
}

/**
 * Convierte el JSON crudo del modelo en una intención tipada. Función pura
 * (sin llamadas a la API) para poder probarla.
 */
export function parseRoutedIntent(raw: string, userText: string): RoutedIntent {
  const confidence = (parsed: unknown): number => {
    const value = (parsed as { confidence?: unknown } | null)?.confidence;
    return typeof value === "number" && Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : 0.6;
  };

  try {
    const parsed = JSON.parse(extractJson(raw));
    if (parsed.type === "automation") {
      const kind = parsed.kind ?? "open_url";
      const target = parsed.target ?? userText;
      if (
        kind === "open_url" &&
        typeof target === "string" &&
        !/^https?:\/\//i.test(target.trim())
      ) {
        return {
          intent: { type: "open_authorized_app", app: asText(target, userText) },
          confidence: confidence(parsed),
        };
      }
      return {
        intent: { type: "automation", action: { kind, target } },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "vision") {
      return {
        intent: { type: "vision", question: parsed.question ?? userText },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "image") {
      return {
        intent: { type: "image", prompt: parsed.prompt ?? userText },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "open_authorized_app") {
      return {
        intent: { type: "open_authorized_app", app: asText(parsed.app, userText) },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "web_search") {
      return {
        intent: {
          type: "web_search",
          query: asText(parsed.query, userText),
          openSources: parsed.openSources === true,
        },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "system_info") {
      return {
        intent: { type: "system_info", topic: asText(parsed.topic, "resumen") },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "find_files") {
      return {
        intent: {
          type: "find_files",
          query: asText(parsed.query, userText),
          scope: asText(parsed.scope, "all"),
          ...(parsed.foldersOnly === true ? { foldersOnly: true } : {}),
        },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "create_folder") {
      return {
        intent: { type: "create_folder", path: asText(parsed.path, "") },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "create_file") {
      return {
        intent: { type: "create_file", path: asText(parsed.path, "") },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "move_files") {
      const sources = Array.isArray(parsed.sources)
        ? parsed.sources.filter((s: unknown): s is string => typeof s === "string" && s.trim() !== "")
        : [];
      return {
        intent: {
          type: "move_files",
          sources,
          destination: asText(parsed.destination, ""),
        },
        confidence: confidence(parsed),
      };
    }
    if (parsed.type === "action_history") {
      return {
        intent: {
          type: "action_history",
          action: typeof parsed.action === "string" ? parsed.action : "",
          limit: typeof parsed.limit === "number" ? parsed.limit : undefined,
        },
        confidence: confidence(parsed),
      };
    }
    return { intent: { type: "conversation" }, confidence: 0.5 };
  } catch {
    return { intent: { type: "conversation" }, confidence: 0.4 };
  }
}

/** Normaliza un valor de texto del JSON, con reserva al texto original. */
function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * Aísla el JSON de una respuesta que puede venir con texto o bloques ```json
 * (Groq, Mistral y Ollama no siempre respetan el modo JSON estricto).
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}
