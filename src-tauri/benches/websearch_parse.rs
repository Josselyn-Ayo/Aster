//! E3 — Coste de los parsers de búsqueda web sobre páginas de ~500 KB.
//!
//! Los buscadores devuelven HTML que el backend recorta y parsea a mano
//! (`websearch.rs`). Estos benchmarks aíslan ese trabajo del tiempo de red:
//! generan páginas sintéticas del tamaño máximo que acepta el módulo
//! (`MAX_HTML_BYTES = 500 000`) con la misma estructura que DuckDuckGo y Bing.

use std::hint::black_box;

use aster_desktop_assistant_lib::bench_api::{html_to_text, parse_bing, parse_duckduckgo};
use criterion::{criterion_group, criterion_main, Criterion, Throughput};

const TARGET_BYTES: usize = 500_000;

/// Repite `block` hasta alcanzar `target` bytes y cierra el documento.
fn fill_to(target: usize, block: &str) -> String {
    let mut out = String::with_capacity(target + 64);
    out.push_str("<!doctype html><html><head><title>Resultados</title></head><body>");
    while out.len() + block.len() < target {
        out.push_str(block);
    }
    out.push_str("</body></html>");
    out
}

/// Página tipo DuckDuckGo: relleno primero y los 6 resultados al final, para
/// que el parser tenga que recorrer los 500 KB antes de terminar.
fn duckduckgo_page() -> String {
    let filler = r#"<div class="filler"><a href="/x">relleno</a><p>texto sin resultados</p></div>"#;
    let mut html = fill_to(TARGET_BYTES - 6 * 400, filler);
    for i in 0..6 {
        html.push_str(&format!(
            r#"<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/resultado-{i}">Resultado sintético {i}</a></h2><a class="result__snippet" href="https://example.com/r{i}"><span>Resumen sintético número {i} con texto suficiente para el parser.</span></a></div>"#
        ));
    }
    html.push_str("</body></html>");
    html
}

/// Página tipo Bing: relleno y 6 bloques `b_algo` al final.
fn bing_page() -> String {
    let filler = r#"<div class="b_filler"><p>relleno sin resultados</p></div>"#;
    let mut html = fill_to(TARGET_BYTES - 6 * 300, filler);
    for i in 0..6 {
        html.push_str(&format!(
            r#"<li class="b_algo"><h2><a href="https://example.com/bing-{i}">Resultado Bing {i}</a></h2><div class="b_caption"><p class="b_lineclamp2">Resumen Bing número {i} con texto suficiente.</p></div></li>"#
        ));
    }
    html.push_str("</body></html>");
    html
}

/// Página genérica con etiquetas, scripts y estilos: lo que procesa
/// `html_to_text` antes de resumir una página descargada.
fn text_page() -> String {
    let block = r#"<div class="wrap"><p>Contenido visible de la página con &amp; entidades y acentos: acción, niño.</p><script>window.contador = 1;</script><style>.a{color:#f0f}</style><noscript>sin js</noscript></div>"#;
    fill_to(TARGET_BYTES, block)
}

fn bench_parsers(c: &mut Criterion) {
    let ddg = duckduckgo_page();
    let bing = bing_page();
    let text = text_page();

    // Los datos sintéticos deben ser válidos: si el parser deja de reconocerlos,
    // el benchmark fallaría aquí y no mediría un caso vacío.
    assert_eq!(parse_duckduckgo(&ddg).len(), 6, "fixture DuckDuckGo inválido");
    assert_eq!(parse_bing(&bing).len(), 6, "fixture Bing inválido");
    assert!(!html_to_text(&text).is_empty(), "fixture de texto inválido");

    let mut group = c.benchmark_group("websearch_parse");
    group.sample_size(50);

    group.throughput(Throughput::Bytes(ddg.len() as u64));
    group.bench_function("duckduckgo-500kb", |b| {
        b.iter(|| black_box(parse_duckduckgo(&ddg)))
    });

    group.throughput(Throughput::Bytes(bing.len() as u64));
    group.bench_function("bing-500kb", |b| b.iter(|| black_box(parse_bing(&bing))));

    group.throughput(Throughput::Bytes(text.len() as u64));
    group.bench_function("html-a-texto-500kb", |b| {
        b.iter(|| black_box(html_to_text(&text)))
    });

    group.finish();
}

criterion_group!(benches, bench_parsers);
criterion_main!(benches);
