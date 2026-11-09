//! Visión por computadora: captura de la pantalla principal para que el modelo
//! pueda analizarla.
//!
//! La captura se reduce a un ancho máximo y se codifica en JPEG antes de salir
//! hacia el frontend. Es deliberado: un PNG a resolución nativa (1440p o 4K)
//! pesa varios MB y cuesta miles de tokens en cada consulta de visión; el JPEG
//! reducido baja a unos cientos de kB sin perder legibilidad para el modelo.
use base64::Engine;
use image::imageops::FilterType;
use image::RgbaImage;
use screenshots::Screen;
use serde::Serialize;

/// Ancho máximo de la captura enviada al modelo.
const MAX_WIDTH: u32 = 1280;
/// Calidad del JPEG (0-100).
const JPEG_QUALITY: u8 = 80;

/// Captura lista para el modelo: Base64 sin prefijo `data:`.
#[derive(Serialize)]
pub struct CapturedScreen {
    pub base64: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

/// Número de pantallas conectadas al sistema.
pub(crate) fn count_screens() -> usize {
    Screen::all().map(|screens| screens.len()).unwrap_or(0)
}

/// Captura la pantalla principal y la devuelve como JPEG reducido en Base64.
///
/// Si la captura de la pantalla principal falla se recorre el resto de
/// monitores, porque en equipos con GPU dedicada Windows puede denegar la
/// captura del display principal.
pub fn capture_screen() -> Result<CapturedScreen, String> {
    let screens =
        Screen::all().map_err(|e| format!("No se pudieron enumerar las pantallas: {e}"))?;
    if screens.is_empty() {
        return Err("No se detectó ninguna pantalla.".to_string());
    }

    // `Screen::all()` sigue el orden de `EnumDisplayMonitors`, que en Windows
    // empieza por el display principal; el id solo sirve para estabilizar ese
    // orden cuando Windows devuelve varios monitores.
    let mut screens = screens;
    screens.sort_by_key(|screen| screen.display_info.id);

    let mut last_error = String::new();
    for screen in &screens {
        match screen.capture() {
            Ok(image) => match encode_jpeg(&image) {
                Ok(base64) => {
                    return Ok(CapturedScreen {
                        base64,
                        mime_type: "image/jpeg".to_string(),
                    })
                }
                Err(error) => last_error = error,
            },
            Err(error) => {
                last_error = format!(
                    "No se pudo capturar la pantalla {id}: {error}",
                    id = screen.display_info.id
                )
            }
        }
    }
    Err(last_error)
}

/// Captura la pantalla principal como JPEG reducido en Base64.
#[tauri::command]
pub fn capture_screen_jpeg() -> Result<CapturedScreen, String> {
    capture_screen()
}

/// Número de pantallas conectadas.
#[tauri::command]
pub fn screen_count() -> Result<usize, String> {
    Ok(count_screens())
}

/// Reduce la captura a `MAX_WIDTH` y la codifica como JPEG.
fn encode_jpeg(image: &RgbaImage) -> Result<String, String> {
    let resized = if image.width() > MAX_WIDTH {
        let scale = MAX_WIDTH as f32 / image.width() as f32;
        let height = ((image.height() as f32 * scale).round() as u32).max(1);
        image::imageops::resize(image, MAX_WIDTH, height, FilterType::Triangle)
    } else {
        image.clone()
    };

    let rgb = image::DynamicImage::ImageRgba8(resized).to_rgb8();
    let mut buffer: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buffer);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|e| format!("No se pudo codificar la captura como JPEG: {e}"))?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&buffer))
}
