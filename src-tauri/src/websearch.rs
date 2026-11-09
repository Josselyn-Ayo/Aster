//! Búsqueda web sin cuota de modelos.
//!
//! Los proveedores de IA con búsqueda integrada (Gemini + Google Search) tienen
//! cuota propia y en la capa gratuita suele estar a cero. Para que «busca en
//! Internet…» funcione siempre, el backend consulta un buscador HTML, descarga
//! las primeras páginas y devuelve su texto; el modelo de conversación solo
//! tiene que resumirlo.
//!
//! Se prueban dos buscadores en orden: DuckDuckGo y Bing. El primero devuelve
//! un desafío anti-bots (HTTP 202 sin resultados) cuando detecta consultas
//! repetidas, así que no basta con un único motor.
//!
//! La descarga vive en Rust y no en el WebView porque los buscadores no envían
//! cabeceras CORS: un `fetch` del frontend sería rechazado por el navegador.
//!
//! Seguridad: las consultas van solo a esos dos hosts fijos y las páginas de
//! resultado se validan (solo `http`/`https`, nunca hosts locales o privados)
//! para que una redirección no acabe golpeando servicios internos.
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use futures_util::future::join_all;
use reqwest::Client;
use serde::Serialize;

/// Buscador HTML de DuckDuckGo (sin JavaScript ni clave de API).
const DUCKDUCKGO_ENDPOINT: &str = "https://html.duckduckgo.com/html/";
/// Respaldo cuando DuckDuckGo pide un captcha.
const BING_ENDPOINT: &str = "https://www.bing.com/search";
/// Resultados que se devuelven al modelo.
const MAX_RESULTS: usize = 6;
/// Páginas completas que se descargan (las demás solo aportan el resumen).
const MAX_PAGES: usize = 3;
/// Texto legible que se conserva de cada página.
const MAX_PAGE_CHARS: usize = 3000;
/// Caracteres de HTML que se procesan por página (evita descargar visores enormes).
const MAX_HTML_CHARS: usize = 500_000;
/// Longitud máxima de la consulta.
const MAX_QUERY_CHARS: usize = 400;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Idioma y país del usuario (`navigator.language`, p. ej. `es-PE`).
#[derive(Clone, Debug)]
struct LocaleHint {
    language: String,
    region: String,
}

/// Acepta solo locales con idioma y país de dos letras (`es-PE`, `en_US`).
fn parse_locale(locale: Option<&str>) -> Option<LocaleHint> {
    let raw = locale?.trim();
    let (language, region) = raw.split_once(['-', '_'])?;
    let language = language.to_ascii_lowercase();
    let region = region.to_ascii_uppercase();
    let valid = |value: &str| value.len() == 2 && value.bytes().all(|b| b.is_ascii_alphabetic());
    if !valid(&language) || !valid(&region) {
        return None;
    }
    Some(LocaleHint { language, region })
}

/// Cabecera `Accept-Language` coherente con el locale del usuario.
fn accept_language(hint: &Option<LocaleHint>) -> String {
    match hint {
        Some(hint) => format!(
            "{}-{},{};q=0.9,en;q=0.8",
            hint.language, hint.region, hint.language
        ),
        None => "es,en;q=0.8".to_string(),
    }
}

/// Parámetros de la consulta: `kl` regionaliza DuckDuckGo; Bing usa `setlang`.
fn search_params(
    query: &str,
    hint: &Option<LocaleHint>,
    regional: bool,
) -> Vec<(&'static str, String)> {
    let mut params = vec![("q", query.to_string())];
    if let Some(hint) = hint {
        if regional {
            params.push((
                "kl",
                format!("{}-{}", hint.region.to_ascii_lowercase(), hint.language),
            ));
        } else {
            params.push(("setlang", hint.language.clone()));
        }
    }
    params
}

/// Un resultado de búsqueda con el texto ya extraído de la página.
#[derive(Serialize, Debug, Clone)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    /// Texto legible de la página (vacío si no se pudo descargar).
    pub content: String,
}

/// Busca en Internet y devuelve los resultados con el texto de las páginas.
///
/// `locale` es el idioma del usuario (`navigator.language`): se usa para
/// regionalizar los resultados y para pedir las páginas en su idioma.
#[tauri::command]
pub async fn web_search(query: String, locale: Option<String>) -> Result<Vec<SearchHit>, String> {
    let term = query.trim();
    if term.is_empty() {
        return Err("No hay nada que buscar.".into());
    }
    let term = truncate_chars(term, MAX_QUERY_CHARS);
    let hint = parse_locale(locale.as_deref());
    let language = accept_language(&hint);

    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("No se pudo preparar la búsqueda: {e}"))?;

    let engines: [(&str, fn(&str) -> Vec<SearchHit>, bool); 2] = [
        (DUCKDUCKGO_ENDPOINT, parse_duckduckgo, true),
        (BING_ENDPOINT, parse_bing, false),
    ];
    let mut hits = Vec::new();
    let mut last_error: Option<String> = None;

    for (endpoint, parse, regional) in engines {
        let params = search_params(term, &hint, regional);
        match fetch_results(&client, endpoint, &params, &language, parse).await {
            Ok(found) if !found.is_empty() => {
                hits = found;
                break;
            }
            Ok(_) => last_error = Some("La búsqueda no devolvió resultados.".into()),
            Err(error) => last_error = Some(error),
        }
    }

    if hits.is_empty() {
        return Err(last_error.unwrap_or_else(|| "La búsqueda no devolvió resultados.".into()));
    }

    // Se descargan las primeras páginas en paralelo; si una falla, el resultado
    // sigue siendo útil con el resumen del buscador.
    let pages = join_all(
        hits.iter()
            .take(MAX_PAGES)
            .map(|hit| fetch_text(&client, &hit.url)),
    )
    .await;

    for (hit, page) in hits.iter_mut().take(MAX_PAGES).zip(pages) {
        if let Some(text) = page {
            hit.content = text;
        }
    }

    Ok(hits)
}

/// Consulta un buscador y delega el parseo en la función correspondiente.
async fn fetch_results(
    client: &Client,
    endpoint: &str,
    params: &[(&str, String)],
    accept_language: &str,
    parse: fn(&str) -> Vec<SearchHit>,
) -> Result<Vec<SearchHit>, String> {
    let response = client
        .get(endpoint)
        .query(params)
        .header("Accept-Language", accept_language)
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con el buscador: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "El buscador respondió {}.",
            response.status().as_u16()
        ));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("No se pudo leer la respuesta del buscador: {e}"))?;
    Ok(parse(&html))
}

/// Descarga una página y la reduce a texto legible (o `None` si no se puede).
async fn fetch_text(client: &Client, url: &str) -> Option<String> {
    if !is_fetchable(url) {
        return None;
    }

    let response = client
        .get(url)
        .timeout(Duration::from_secs(9))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    // Un visor o un vídeo no aporta texto; no se descarga.
    if response.content_length().unwrap_or(0) > 3_000_000 {
        return None;
    }

    // `text()` respeta el charset declarado por el servidor (algunas webs
    // peruanas siguen en ISO-8859-1); luego se recorta para acotar el coste.
    let html = response.text().await.ok()?;
    let text = html_to_text(truncate_chars(&html, MAX_HTML_CHARS));
    if text.is_empty() {
        return None;
    }
    Some(truncate_chars(&text, MAX_PAGE_CHARS).to_string())
}

/// Solo se descargan páginas http(s) de Internet, nunca hosts locales.
fn is_fetchable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = match lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    {
        Some(rest) => rest,
        None => return false,
    };

    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@') // descarta credenciales embebidas
        .next()
        .unwrap_or("");

    // Separa el puerto: `localhost:11434` debe seguir siendo localhost.
    let host = if let Some(ipv6) = host.strip_prefix('[') {
        ipv6.split(']').next().unwrap_or(ipv6)
    } else {
        host.split(':').next().unwrap_or(host)
    };

    if host.is_empty()
        || host == "localhost"
        || host == "::1"
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || host.starts_with("169.254.")
    {
        return false;
    }

    // 172.16.0.0/12
    if let Some(octet) = host
        .strip_prefix("172.")
        .and_then(|rest| rest.split('.').next())
        .and_then(|octet| octet.parse::<u8>().ok())
    {
        if (16..=31).contains(&octet) {
            return false;
        }
    }

    true
}

/// Extrae título, URL y resumen de la página HTML de resultados de DuckDuckGo.
///
/// Es `pub` para los benchmarks de `benches/websearch_parse.rs`; no forma parte
/// de la API pública de la aplicación.
pub fn parse_duckduckgo(html: &str) -> Vec<SearchHit> {
    const MARKER: &str = "class=\"result__a\"";
    const SNIPPET: &str = "class=\"result__snippet\"";

    let mut hits = Vec::new();
    let mut rest = html;

    while hits.len() < MAX_RESULTS {
        let Some(position) = rest.find(MARKER) else {
            break;
        };
        rest = &rest[position + MARKER.len()..];

        let Some(href_at) = rest.find("href=\"") else {
            continue;
        };
        let after_href = &rest[href_at + 6..];
        let Some(href_end) = after_href.find('"') else {
            continue;
        };
        let href = &after_href[..href_end];

        let Some(gt) = after_href.find('>') else {
            continue;
        };
        let inner = &after_href[gt + 1..];
        let Some(title_end) = inner.find("</a>") else {
            continue;
        };

        let title = clean_text(&inner[..title_end]);
        let url = resolve_duckduckgo_url(href);
        if title.is_empty() || !url.starts_with("http") {
            continue;
        }

        // El resumen debe pertenecer a este resultado: se corta en el siguiente.
        let after_title = &inner[title_end + 4..];
        let segment_end = after_title.find(MARKER).unwrap_or(after_title.len());
        let segment = &after_title[..segment_end];
        let snippet = match segment.find(SNIPPET) {
            Some(at) => {
                let tail = &segment[at..];
                match tail.find('>') {
                    Some(gt) => {
                        let content = &tail[gt + 1..];
                        let end = content.find("</a>").unwrap_or(content.len());
                        clean_text(&content[..end])
                    }
                    None => String::new(),
                }
            }
            None => String::new(),
        };

        hits.push(SearchHit {
            title: truncate_chars(&title, 160).to_string(),
            url,
            snippet: truncate_chars(&snippet, 320).to_string(),
            content: String::new(),
        });
    }

    hits
}

/// Extrae resultados de la página HTML de Bing (`<li class="b_algo">`).
///
/// Es `pub` para los benchmarks de `benches/websearch_parse.rs`; no forma parte
/// de la API pública de la aplicación.
pub fn parse_bing(html: &str) -> Vec<SearchHit> {
    const MARKER: &str = "class=\"b_algo\"";

    let mut hits = Vec::new();
    let mut rest = html;

    while hits.len() < MAX_RESULTS {
        let Some(position) = rest.find(MARKER) else {
            break;
        };
        rest = &rest[position + MARKER.len()..];

        // El bloque termina donde empieza el siguiente resultado.
        let segment_end = rest.find(MARKER).unwrap_or(rest.len());
        let block = &rest[..segment_end];

        let Some(heading) = block.find("<h2") else {
            continue;
        };
        let after_heading = &block[heading..];
        let Some(href_at) = after_heading.find("href=\"") else {
            continue;
        };
        let after_href = &after_heading[href_at + 6..];
        let Some(href_end) = after_href.find('"') else {
            continue;
        };
        let href = &after_href[..href_end];

        let Some(gt) = after_href.find('>') else {
            continue;
        };
        let inner = &after_href[gt + 1..];
        let Some(title_end) = inner.find("</a>") else {
            continue;
        };

        let title = clean_text(&inner[..title_end]);
        let url = resolve_bing_url(href);
        if title.is_empty() || !url.starts_with("http") {
            continue;
        }

        let snippet = match block.find("class=\"b_caption\"") {
            Some(at) => {
                let tail = &block[at..];
                match tail.find("<p") {
                    Some(p) => match tail[p..].find('>') {
                        Some(gt) => {
                            let content = &tail[p + gt + 1..];
                            let end = content.find("</p>").unwrap_or(content.len());
                            clean_text(&content[..end])
                        }
                        None => String::new(),
                    },
                    None => String::new(),
                }
            }
            None => String::new(),
        };

        hits.push(SearchHit {
            title: truncate_chars(&title, 160).to_string(),
            url,
            snippet: truncate_chars(&snippet, 320).to_string(),
            content: String::new(),
        });
    }

    hits
}

/// Bing envuelve los enlaces en `bing.com/ck/a?…&u=a1<base64url>`.
fn resolve_bing_url(href: &str) -> String {
    let href = decode_entities(href);

    if let Some(at) = href.find("u=a1") {
        let tail = &href[at + 4..];
        let encoded = tail.split('&').next().unwrap_or(tail);
        if let Some(decoded) = base64_url_decode(encoded) {
            if decoded.starts_with("http") {
                return decoded;
            }
        }
    }

    // Algunos resultados usan la URL percent-encoded en lugar de base64.
    if let Some(at) = href.find("u=") {
        let tail = &href[at + 2..];
        let encoded = tail.split('&').next().unwrap_or(tail);
        let decoded = percent_decode(encoded);
        if decoded.starts_with("http") {
            return decoded;
        }
    }

    if href.starts_with("//") {
        format!("https:{href}")
    } else {
        href
    }
}

fn base64_url_decode(input: &str) -> Option<String> {
    let trimmed = input.trim_end_matches('=');
    let bytes = URL_SAFE_NO_PAD.decode(trimmed).ok()?;
    String::from_utf8(bytes).ok()
}

/// Resuelve el enlace real: DuckDuckGo envuelve los resultados en `?uddg=…`.
fn resolve_duckduckgo_url(href: &str) -> String {
    let href = decode_entities(href);
    let raw = match href.find("uddg=") {
        Some(at) => {
            let tail = &href[at + 5..];
            let encoded = tail.split('&').next().unwrap_or(tail);
            percent_decode(encoded)
        }
        None => href,
    };

    if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw
    }
}

/// Convierte HTML en texto: quita etiquetas y bloques que no aportan contenido.
///
/// Es `pub` para los benchmarks de `benches/websearch_parse.rs`; no forma parte
/// de la API pública de la aplicación.
pub fn html_to_text(html: &str) -> String {
    /// Bloques cuyo contenido es código o datos, no texto visible.
    const RAW_BLOCKS: [(&str, &str); 5] = [
        ("<script", "</script>"),
        ("<style", "</style>"),
        ("<noscript", "</noscript>"),
        ("<template", "</template>"),
        ("<svg", "</svg>"),
    ];

    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut out = String::with_capacity(html.len() / 3);
    let mut i = 0;

    while i < html.len() {
        if bytes[i] != b'<' {
            let ch = html[i..].chars().next().unwrap_or(' ');
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }

        if lower[i..].starts_with("<!--") {
            match lower[i..].find("-->") {
                Some(end) => i += end + 3,
                None => break,
            }
            continue;
        }

        let mut skipped = false;
        for (open, close) in RAW_BLOCKS {
            if lower[i..].starts_with(open) {
                match lower[i..].find(close) {
                    Some(end) => i += end + close.len(),
                    None => i = html.len(),
                }
                skipped = true;
                break;
            }
        }
        if skipped {
            continue;
        }

        match lower[i..].find('>') {
            Some(end) => {
                i += end + 1;
                out.push(' ');
            }
            None => break,
        }
    }

    let text = decode_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    tidy_spaces(text)
}

/// Elimina el espacio que dejan las etiquetas en línea antes de la puntuación
/// («hoy <b>:</b> 3,45» → «hoy: 3,45»).
fn tidy_spaces(text: String) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(ch, ',' | '.' | ':' | ';' | '!' | '?' | ')' | ']') && out.ends_with(' ') {
            out.pop();
        }
        out.push(ch);
    }
    out
}

/// Texto limpio de un fragmento (título o resumen del buscador).
fn clean_text(html: &str) -> String {
    html_to_text(html)
}

/// Decodifica las entidades HTML más habituales (incluidas las del español).
fn decode_entities(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] != b'&' {
            let ch = text[i..].chars().next().unwrap_or('&');
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }

        let end = match text[i..].find(';') {
            Some(end) if end <= 10 => end,
            _ => {
                out.push('&');
                i += 1;
                continue;
            }
        };
        let entity = &text[i + 1..i + end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            "aacute" => Some('á'),
            "eacute" => Some('é'),
            "iacute" => Some('í'),
            "oacute" => Some('ó'),
            "uacute" => Some('ú'),
            "ntilde" => Some('ñ'),
            "Aacute" => Some('Á'),
            "Eacute" => Some('É'),
            "Iacute" => Some('Í'),
            "Oacute" => Some('Ó'),
            "Uacute" => Some('Ú'),
            "Ntilde" => Some('Ñ'),
            "iquest" => Some('¿'),
            "iexcl" => Some('¡'),
            "laquo" => Some('«'),
            "raquo" => Some('»'),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "hellip" => Some('…'),
            "middot" => Some('·'),
            "deg" => Some('°'),
            "euro" => Some('€'),
            "copy" => Some('©'),
            "reg" => Some('®'),
            "trade" => Some('™'),
            "times" => Some('×'),
            _ => decode_numeric_entity(entity),
        };

        match decoded {
            Some(ch) => {
                out.push(ch);
                i += end + 1;
            }
            None => {
                out.push('&');
                i += 1;
            }
        }
    }

    out
}

fn decode_numeric_entity(entity: &str) -> Option<char> {
    let digits = entity.strip_prefix('#')?;
    let code = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => digits.parse::<u32>().ok()?,
    };
    char::from_u32(code)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push(high * 16 + low);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn truncate_chars(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
        <div class="result">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a"
               href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdolar&amp;rut=abc">
              Precio del <b>d&oacute;lar</b> &amp; algo
            </a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">
            Cotizaci&oacute;n <b>hoy</b>: 3,45 &quot;soles&quot;.
          </a>
        </div>
        <div class="result">
          <h2 class="result__title">
            <a class="result__a" href="https://example.org/tipo-cambio">Tipo de cambio</a>
          </h2>
        </div>
    "#;

    #[test]
    fn extrae_titulo_url_y_resumen() {
        let hits = parse_duckduckgo(SAMPLE);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://example.com/dolar");
        assert_eq!(hits[0].title, "Precio del dólar & algo");
        assert_eq!(hits[0].snippet, "Cotización hoy: 3,45 \"soles\".");
        assert_eq!(hits[1].url, "https://example.org/tipo-cambio");
        assert_eq!(hits[1].snippet, "");
    }

    #[test]
    fn el_texto_descarta_scripts_estilos_y_etiquetas() {
        let html = "<html><head><style>.x{color:red}</style></head><body><script>alert(1)</script><h1>Hola</h1><p>mundo &amp; c&iacute;a</p></body></html>";
        assert_eq!(html_to_text(html), "Hola mundo & cía");
    }

    #[test]
    fn descarta_hosts_locales_y_esquemas_raros() {
        assert!(is_fetchable("https://cuantoestaeldolar.pe/"));
        assert!(!is_fetchable("http://localhost:11434/v1/models"));
        assert!(!is_fetchable("http://127.0.0.1/"));
        assert!(!is_fetchable("http://192.168.1.10/admin"));
        assert!(!is_fetchable("http://172.20.0.5/"));
        assert!(!is_fetchable("file:///C:/Windows/win.ini"));
    }

    #[test]
    fn decodifica_el_enlace_envuelto_de_duckduckgo() {
        assert_eq!(
            resolve_duckduckgo_url(
                "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=z"
            ),
            "https://example.com/a?b=1"
        );
    }

    #[test]
    fn extrae_resultados_de_bing_con_enlace_base64() {
        let html = r#"
          <li class="b_algo" data-id>
            <h2><a target="_blank"
              href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9kb2xhcg&amp;ntb=1">
              Precio del <strong>dólar</strong>
            </a></h2>
            <div class="b_caption">
              <p class="b_lineclamp2"><span class="news_dt">29 de ene</span>&#32;El dólar está en 3,45.</p>
            </div>
          </li>
        "#;

        let hits = parse_bing(html);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.com/dolar");
        assert_eq!(hits[0].title, "Precio del dólar");
        assert_eq!(hits[0].snippet, "29 de ene El dólar está en 3,45.");
    }

    #[test]
    fn interpreta_el_locale_del_usuario() {
        let hint = parse_locale(Some("es-PE")).expect("es-PE es válido");
        assert_eq!(hint.language, "es");
        assert_eq!(hint.region, "PE");
        assert!(parse_locale(Some("es-419")).is_none());
        assert!(parse_locale(Some("")).is_none());
        assert!(parse_locale(None).is_none());

        let params = search_params("dólar", &Some(hint), true);
        assert!(params.contains(&("kl", "pe-es".to_string())));
    }

    /// Comprobación manual contra el buscador real: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore = "requiere conexión a Internet"]
    async fn busca_en_vivo() {
        let hits = web_search("precio del dólar hoy".into(), Some("es-PE".into()))
            .await
            .expect("la búsqueda debería responder");
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|hit| hit.url.starts_with("http")));
        assert!(
            hits.iter().any(|hit| !hit.content.is_empty()),
            "al menos una página debería aportar texto"
        );
        for hit in &hits {
            println!(
                "· {} → {} ({} chars de texto)",
                hit.title,
                hit.url,
                hit.content.chars().count()
            );
        }
    }
}
