//! Acciones 4, 5, 5b y 6 del catálogo: buscar archivos, crear carpetas, crear
//! archivos (vacíos) y mover archivos y carpetas.
//!
//! Las dos últimas escriben en el disco, así que siguen el patrón de dos
//! fases: [`prepare_file_operation`] solo valida y deja la operación «armada»
//! con una caducidad de dos minutos; nada se escribe hasta que el usuario
//! aprueba en el diálogo de confirmación, que llama a
//! [`confirm_file_operation`]. Además, al confirmar se **revalida** todo, por si
//! el disco cambió entre la preparación y la aprobación.
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

use tauri::State;

use crate::model::{
    human_size, now_iso, AuditInput, FileHit, FileOpOutcome, FileOpRequest, FindFilesRequest,
    PendingOperation,
};
use crate::paths;
use crate::policy::{self, all_roots, ensure_permitted, roots_for_scope};
use crate::state::{now_ms, AppState, Inner};

/** Tope duro de resultados, aunque el frontend pida más. */
const MAX_RESULTS: u32 = 200;

/**
 * Cuántas entradas (archivos y carpetas) se inspeccionan como máximo en una
 * búsqueda. El recorrido es por niveles, así que un árbol enorme no impide
 * encontrar un archivo que está en un primer nivel.
 */
const MAX_ENTRIES: usize = 20_000;

/**
 * Carpetas de trabajo que no aportan resultados útiles al usuario y que sí
 * pueden contener decenas de miles de archivos (dependencias, compilaciones,
 * cachés). Se podan solo al descender, nunca si la raíz pedida es una de ellas.
 */
const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".gradle",
];

/** Antigüedad de una operación armada: dos minutos. */
const PENDING_TTL_MS: i64 = 120_000;

/* ------------------------------------------------------------------ */
/* Búsqueda                                                            */
/* ------------------------------------------------------------------ */

/** Normaliza mayúsculas, minúsculas y tildes comunes en español y latín. */
fn normalize_str(s: &str) -> String {
    s.chars()
        .map(|c| match c.to_ascii_lowercase() {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            other => other,
        })
        .collect()
}

/** Stop-words de español e inglés que se ignoran al filtrar tokens. */
const STOP_WORDS: &[&str] = &[
    "de", "del", "la", "el", "los", "las", "en", "un", "una", "unos", "unas",
    "y", "o", "como", "para", "por", "con", "al", "a", "que", "su", "sus",
    "se", "es", "son", "fue", "ser", "lo", "le", "les", "nos", "te", "me",
    "mi", "tu", "si", "no", "ni", "ya", "the", "of", "and", "in", "to", "a",
    "an", "is", "at", "or", "but", "not",
];

/**
 * Coincide el nombre de un elemento con la consulta del usuario.
 * Soporta:
 * 1. Búsqueda por extensión («.pdf»)
 * 2. Coincidencia por subcadena exacta (insensible a mayúsculas y acentos)
 * 3. Coincidencia compacta alfanumérica (PascalCase, kebab-case, snake_case)
 * 4. Coincidencia flexible por palabras clave y raíces (tolerando plurales y stop-words)
 *    - Cada token significativo se busca como subcadena en el nombre compacto (prefijo parcial).
 *    - Para consultas largas (≥3 tokens significativos) se acepta ≥60% de coincidencia.
 *    - Para consultas cortas (1-2 tokens) se exige el 100%.
 */
fn matches(name: &str, query: &str) -> bool {
    let q_trimmed = query.trim();
    if q_trimmed.is_empty() {
        return false;
    }

    // 1. «.pdf» busca por extensión
    if let Some(ext) = q_trimmed.strip_prefix('.') {
        if !ext.is_empty() {
            let name_lower = name.to_lowercase();
            return name_lower.ends_with(&format!(".{}", ext.to_lowercase()));
        }
    }

    let norm_name = normalize_str(name);
    let norm_query = normalize_str(q_trimmed);

    // 2. Subcadena directa con acentos y mayúsculas normalizados
    if norm_name.contains(&norm_query) {
        return true;
    }

    // 3. Subcadena compacta alfanumérica
    // Ej: «LosEstudiosDeCasos» coincide con «estudios de casos»
    let compact_name: String = norm_name.chars().filter(|c| c.is_alphanumeric()).collect();
    let compact_query: String = norm_query.chars().filter(|c| c.is_alphanumeric()).collect();

    if !compact_query.is_empty() && compact_name.contains(&compact_query) {
        return true;
    }

    // 4. Búsqueda por palabras clave significativas (subcadena parcial y raíces)
    let tokens: Vec<&str> = norm_query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();

    if tokens.is_empty() {
        return false;
    }

    // Filtra stop-words; si todos son stop-words, los incluye todos
    let significant: Vec<&str> = tokens
        .iter()
        .copied()
        .filter(|t| !STOP_WORDS.contains(t) && t.len() >= 2)
        .collect();

    let tokens_to_check: &[&str] = if significant.is_empty() {
        &tokens
    } else {
        &significant
    };

    // Para cada token se acepta:
    //   a) El token literal como subcadena del nombre compacto
    //   b) La raíz (sin plural) como subcadena
    //   c) El token como prefijo de alguna «palabra» del nombre compacto
    //      (tolerancia de 3 primeros caracteres para cubrir variantes de raíces)
    let mut matched = 0usize;
    for &token in tokens_to_check {
        let stem = stem_word(token);
        if compact_name.contains(token) || compact_name.contains(stem) {
            matched += 1;
            continue;
        }
        // Coincidencia parcial de prefijo: ≥4 caracteres del token en el nombre
        if token.len() >= 4 {
            let prefix = &token[..token.len().min(token.len() - 1)];
            if compact_name.contains(prefix) {
                matched += 1;
                continue;
            }
        }
        // Coincidencia parcial de prefijo de la raíz: ≥4 caracteres
        if stem.len() >= 4 {
            let stem_prefix = &stem[..stem.len().min(stem.len() - 1)];
            if compact_name.contains(stem_prefix) {
                matched += 1;
            }
        }
    }

    let total = tokens_to_check.len();
    match total {
        0 => false,
        1 | 2 => matched == total, // palabras cortas: exigir el 100%
        3 | 4 => matched >= total - 1, // 3-4 tokens: tolera 1 fallo
        _ => {
            // 5+ tokens (consulta larga): umbral del 60%
            matched * 10 >= total * 6
        }
    }
}

/** Obtiene una raíz básica para tolerar singular y plural en español. */
fn stem_word(w: &str) -> &str {
    if w.len() > 4 {
        if let Some(s) = w.strip_suffix("es") {
            return s;
        }
        if let Some(s) = w.strip_suffix('s') {
            return s;
        }
    }
    w
}

/// Traduce una entrada del disco a un resultado presentable.
fn to_hit(path: &Path, scope: &str) -> Option<FileHit> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.is_symlink() {
        // Los enlaces simbólicos se saltan: apuntan fuera de la raíz autorizada
        // o crearían ciclos en el recorrido.
        return None;
    }
    let is_directory = meta.is_dir();
    let name = path.file_name()?.to_string_lossy().to_string();
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
        .flatten()
        .map(|t| t.to_rfc3339())
        .unwrap_or_default();

    Some(FileHit {
        // La ruta de presentación va sin el prefijo verbatim que `canonicalize`
        // añade en Windows, para que coincida con lo que ve el usuario.
        path: crate::paths::strip_verbatim(path).to_string_lossy().to_string(),
        name,
        is_directory,
        size_bytes: if is_directory { 0 } else { meta.len() },
        size_label: if is_directory {
            "carpeta".to_string()
        } else {
            human_size(meta.len())
        },
        modified_at: modified,
        scope: scope.to_string(),
    })
}

/// Busca archivos y carpetas dentro de las carpetas autorizadas.
///
/// Nunca sale de las raíces: cada candidato se comprueba contra las raíces
/// canónicas y los enlaces simbólicos se saltan.
#[tauri::command]
pub fn find_files(
    state: State<'_, AppState>,
    request: FindFilesRequest,
) -> Result<Vec<FileHit>, String> {
    paths::ensure_plain_text(&request.query, "búsqueda")?;
    let profile = state.profile()?;
    ensure_permitted(&profile, "find_files")?;

    let limit = request.limit.unwrap_or(25).clamp(1, MAX_RESULTS);
    let scope = request.scope.as_deref().unwrap_or("all");

    // Se pueden pasar las búsquedas explícitamente por una de las raíces.
    let roots = match request
        .root
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
    {
        Some(raw) => {
            let allowed = paths::canonical_roots(&all_roots(&profile));
            vec![paths::resolve_in_roots(raw, &allowed, false)?]
        }
        None => roots_for_scope(&profile, Some(scope)),
    };
    if roots.is_empty() {
        return Err("No hay ninguna carpeta autorizada donde buscar.".to_string());
    }

    search_files(&roots, &request.query, limit, request.folders_only)
}

/// Recorre las raíces por niveles y devuelve las coincidencias.
///
/// El recorrido es BFS (primero todo un nivel y después sus subcarpetas) en vez
/// de DFS. Con DFS, una carpeta enorme como `Proyectos` podía agotar el tope de
/// entradas antes de volver al nivel superior, y un archivo suelto en la raíz
/// («pago.pdf» en Documentos) nunca llegaba a verse. Con BFS, los archivos
/// superficiales se encuentran siempre antes de bajar.
///
/// Es `pub` para que los benchmarks de `benches/files_search.rs` puedan medirla
/// sin depender del estado de Tauri. No es parte de la API pública de la app.
pub fn search_files(
    roots: &[PathBuf],
    query: &str,
    limit: u32,
    folders_only: bool,
) -> Result<Vec<FileHit>, String> {
    // Las raíces deben tener la misma forma canónica con la que luego se
    // comprueba la contención: en Windows `canonicalize` añade el prefijo
    // verbatim `\\?\`, y una entrada `C:\…` quedaría fuera de su raíz
    // `\\?\C:\…` (la búsqueda devolvería siempre cero resultados).
    let mut queue: VecDeque<(PathBuf, &'static str)> = roots
        .iter()
        .filter_map(|root| {
            std::fs::canonicalize(root)
                .ok()
                .map(|dir| (dir, scope_label_of(root)))
        })
        .collect();
    if queue.is_empty() {
        return Err("No hay ninguna carpeta autorizada donde buscar.".to_string());
    }
    let canonical_roots: Vec<PathBuf> = queue.iter().map(|(dir, _)| dir.clone()).collect();

    let mut hits: Vec<FileHit> = Vec::new();
    let mut visited = 0usize;

    'search: while let Some((dir, dir_scope)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            // Sin permisos o la carpeta desapareció entre pasadas.
            continue;
        };
        for entry in entries.flatten() {
            if visited >= MAX_ENTRIES || hits.len() as u32 >= limit {
                break 'search;
            }
            visited += 1;
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if !canonical_roots.iter().any(|root| path.starts_with(root)) {
                continue;
            }
            // `Program Files` y similares nunca están en las raíces, pero un
            // punto de montaje dentro de una carpeta personal sí podría apuntar
            // al disco del sistema.
            if paths::is_forbidden_system_path(&path) {
                continue;
            }
            if file_type.is_dir() && !should_skip_dir(&path) {
                queue.push_back((path.clone(), dir_scope));
            }
            if folders_only && !file_type.is_dir() {
                continue;
            }
            if let Some(hit) = to_hit(&path, dir_scope) {
                if matches(&hit.name, query) {
                    hits.push(hit);
                }
            }
        }
    }

    // El nombre exacto pedido primero; luego carpetas; a igualdad, lo más
    // reciente arriba.
    hits.sort_by(|a, b| {
        is_exact_name(&b.name, query)
            .cmp(&is_exact_name(&a.name, query))
            .then_with(|| b.is_directory.cmp(&a.is_directory))
            .then_with(|| b.modified_at.cmp(&a.modified_at))
    });
    Ok(hits)
}

/// ¿El nombre coincide exactamente con la consulta, con extensión o sin ella?
fn is_exact_name(name: &str, query: &str) -> bool {
    let name = normalize_str(name);
    let query = normalize_str(query.trim());
    if query.is_empty() {
        return false;
    }
    name == query || file_stem(&name) == file_stem(&query)
}

/// Nombre sin la extensión final (si la tiene).
fn file_stem(value: &str) -> &str {
    value.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(value)
}

/// ¿Es una carpeta de trabajo/caché que conviene podar al descender?
fn should_skip_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| SKIP_DIR_NAMES.iter().any(|skip| skip.eq_ignore_ascii_case(name)))
}

/// Etiqueta de ámbito de una raíz concreta.
fn scope_label_of(root: &Path) -> &'static str {
    for (label, path) in policy::default_roots() {
        if path == root {
            return match label {
                "Escritorio" => "desktop",
                "Documentos" => "documents",
                "Descargas" => "downloads",
                "Imágenes" => "pictures",
                _ => "music",
            };
        }
    }
    "extra"
}

/* ------------------------------------------------------------------ */
/* Operaciones de escritura                                            */
/* ------------------------------------------------------------------ */

/** Title y resumen que ve el usuario en el diálogo de confirmación. */
fn describe(request: &FileOpRequest, resolved: &ResolvedOp) -> (String, String, Vec<String>) {
    match request {
        FileOpRequest::CreateFolder { .. } => (
            "Crear carpeta".to_string(),
            format!("Se creará la carpeta «{}».", resolved.primary()),
            vec![resolved.primary()],
        ),
        FileOpRequest::CreateFile { .. } => (
            "Crear archivo".to_string(),
            format!("Se creará el archivo vacío «{}».", resolved.primary()),
            vec![resolved.primary()],
        ),
        FileOpRequest::Move { sources, .. } => (
            "Mover archivos y carpetas".to_string(),
            format!(
                "Se moverán {} elemento(s) a «{}».",
                sources.len(),
                resolved.primary()
            ),
            resolved.details(),
        ),
    }
}

/// Rutas ya validadas de una operación, listas para ejecutar.
struct ResolvedOp {
    target: PathBuf,
    sources: Vec<PathBuf>,
    parent: PathBuf,
}

impl ResolvedOp {
    fn primary(&self) -> String {
        self.target.to_string_lossy().to_string()
    }
    fn details(&self) -> Vec<String> {
        let mut details: Vec<String> = self
            .sources
            .iter()
            .map(|p| format!("{} → {}", p.display(), self.target.display()))
            .collect();
        details.push(format!("Destino: {}", self.target.display()));
        details
    }
}

/** Valida la petición y devuelve las rutas reales, sin tocar el disco. */
fn resolve_request(request: &FileOpRequest, roots: &[PathBuf]) -> Result<ResolvedOp, String> {
    match request {
        FileOpRequest::CreateFolder { path } => {
            let target = paths::resolve_in_roots(path, roots, true)?;
            if target.exists() {
                return Err(format!(
                    "«{}» ya existe. Elige otro nombre de carpeta.",
                    target.display()
                ));
            }
            let parent = target
                .parent()
                .ok_or("La carpeta destino no tiene un directorio padre válido.")?
                .to_path_buf();
            Ok(ResolvedOp {
                target,
                sources: Vec::new(),
                parent,
            })
        }
        FileOpRequest::CreateFile { path } => {
            let target = paths::resolve_in_roots(path, roots, true)?;
            if target.exists() {
                return Err(format!(
                    "«{}» ya existe. Elige otro nombre de archivo.",
                    target.display()
                ));
            }
            // El archivo se crea vacío: debe traer nombre con extensión.
            match target.file_name().and_then(|n| n.to_str()) {
                Some(name) if name.contains('.') && !name.starts_with('.') => {}
                _ => {
                    return Err(
                        "Indica el nombre del archivo con su extensión (p. ej. notas.txt)."
                            .to_string(),
                    )
                }
            }
            // No se crean scripts ni ejecutables que luego podrían lanzarse.
            if let Some(name) = target.file_name() {
                if paths::is_shell_reference(&name.to_string_lossy()) {
                    return Err(
                        "Por seguridad no se crean scripts ni ejecutables.".to_string(),
                    );
                }
            }
            // La carpeta padre debe existir: no se crean árboles de carpetas.
            let parent = target
                .parent()
                .ok_or("La ruta destino no tiene una carpeta padre válida.")?
                .to_path_buf();
            if !parent.is_dir() {
                return Err(format!(
                    "La carpeta «{}» no existe. Crea primero la carpeta.",
                    parent.display()
                ));
            }
            Ok(ResolvedOp {
                target,
                sources: Vec::new(),
                parent,
            })
        }
        FileOpRequest::Move {
            sources,
            destination,
        } => {
            if sources.is_empty() {
                return Err("No se indicó ningún archivo que mover.".to_string());
            }
            if sources.len() > 100 {
                return Err("No se pueden mover más de 100 elementos a la vez.".to_string());
            }
            let target = paths::resolve_in_roots(destination, roots, false)?;
            if !target.is_dir() {
                return Err(format!(
                    "El destino «{}» no es una carpeta existente.",
                    target.display()
                ));
            }
            let parent = target.clone();

            let mut resolved_sources = Vec::new();
            for raw in sources {
                // Archivos y carpetas: `resolve_in_roots` ya exige que existan
                // y que estén dentro de las raíces autorizadas.
                let source = paths::resolve_in_roots(raw, roots, false)?;
                if source == target {
                    return Err("El origen y el destino son el mismo.".to_string());
                }
                if target.starts_with(&source) {
                    return Err("No se puede mover un archivo dentro de sí mismo.".to_string());
                }
                // Un archivo con el mismo nombre ya en destino se pisaría sin
                // preguntar: se rechaza para no perder datos.
                if let Some(name) = source.file_name() {
                    if target.join(name).exists() {
                        return Err(format!(
                            "«{}» ya existe en el destino. No se sobrescribe ningún archivo.",
                            name.to_string_lossy()
                        ));
                    }
                }
                resolved_sources.push(source);
            }
            Ok(ResolvedOp {
                target,
                sources: resolved_sources,
                parent,
            })
        }
    }
}

/// Prepara una operación de escritura y devuelve la ficha de confirmación.
/// No escribe nada: solo valida y arma la operación.
#[tauri::command]
pub fn prepare_file_operation(
    state: State<'_, AppState>,
    request: FileOpRequest,
    origin: String,
) -> Result<PendingOperation, String> {
    let profile = state.profile()?;
    let action = request.action();
    ensure_permitted(&profile, action)?;

    let roots = paths::canonical_roots(&all_roots(&profile));
    if roots.is_empty() {
        return Err("No hay ninguna carpeta autorizada configurada.".to_string());
    }

    let resolved = resolve_request(&request, &roots)?;
    let (title, summary, details) = describe(&request, &resolved);

    let operation = PendingOperation {
        id: uuid::Uuid::new_v4().to_string(),
        action: action.to_string(),
        title,
        summary,
        details,
        requires_confirmation: true,
        expires_at: chrono::DateTime::from_timestamp_millis(now_ms() + PENDING_TTL_MS)
            .map(|t| t.to_rfc3339())
            .unwrap_or_else(now_iso),
    };

    state.write(|inner: &mut Inner| {
        purge_expired(&mut inner.pending);
        inner.pending.insert(
            operation.id.clone(),
            crate::state::ArmedOperation {
                operation: operation.clone(),
                request: request.clone(),
                origin: origin.clone(),
                created_at_ms: now_ms(),
            },
        );
    })?;

    Ok(operation)
}

/// Descarta las operaciones que ya caducaron.
fn purge_expired(pending: &mut HashMap<String, crate::state::ArmedOperation>) {
    let now = now_ms();
    pending.retain(|_, armed| now - armed.created_at_ms <= PENDING_TTL_MS);
}

/// Confirma o rechaza la operación pendiente.
///
/// Al aprobar se revalida contra las raíces actuales: entre la preparación y el
/// clic del usuario el perfil pudo cambiar o el disco pudo responder distinto.
#[tauri::command]
pub fn confirm_file_operation(
    state: State<'_, AppState>,
    operation_id: String,
    approved: bool,
    origin: String,
) -> Result<FileOpOutcome, String> {
    let armed = state.try_write(|inner: &mut Inner| {
        purge_expired(&mut inner.pending);
        match inner.pending.remove(&operation_id) {
            Some(armed) if now_ms() - armed.created_at_ms <= PENDING_TTL_MS => Ok(armed),
            Some(_) => Err("La operación caducó. Vuelve a pedirla.".to_string()),
            None => Err("No hay ninguna operación pendiente con ese identificador.".to_string()),
        }
    })?;

    // El backend es la autoridad de la auditoría: registra aquí cada desenlace
    // (aprobado, rechazado, denegado o fallido) con un identificador real, en
    // vez de fiarse de lo que envíe el frontend.
    let latency_ms = (now_ms() - armed.created_at_ms).max(0) as u64;
    let origin = if origin.trim().is_empty() {
        armed.origin.clone()
    } else {
        origin
    };
    let action = armed.operation.action.clone();

    if !approved {
        let audit_id = record(
            &state,
            &action,
            "cancelled",
            &origin,
            String::new(),
            "Operación cancelada por el usuario.".to_string(),
            false,
            latency_ms,
            None,
        )?;
        return Ok(FileOpOutcome {
            status: "cancelled".to_string(),
            message: "Operación cancelada. No he modificado nada.".to_string(),
            affected: Vec::new(),
            audit_id,
        });
    }

    let profile = state.profile()?;
    ensure_permitted(&profile, &action)?;
    let roots = paths::canonical_roots(&all_roots(&profile));
    let resolved = match resolve_request(&armed.request, &roots) {
        Ok(resolved) => resolved,
        Err(error) => {
            let audit_id = record(
                &state,
                &action,
                "denied",
                &origin,
                String::new(),
                format!("Revalidación fallida: {error}"),
                true,
                latency_ms,
                Some(error),
            )?;
            return Ok(FileOpOutcome {
                status: "denied".to_string(),
                message: "La operación ya no es válida. No he modificado nada.".to_string(),
                affected: Vec::new(),
                audit_id,
            });
        }
    };

    let affected = match &armed.request {
        FileOpRequest::CreateFolder { .. } => match std::fs::create_dir(&resolved.target) {
            Ok(()) => vec![resolved.target.to_string_lossy().to_string()],
            Err(error) => {
                let detail = format!("No se pudo crear la carpeta: {error}");
                let audit_id = record(
                    &state,
                    &action,
                    "error",
                    &origin,
                    resolved.target.to_string_lossy().to_string(),
                    detail.clone(),
                    true,
                    latency_ms,
                    Some(detail.clone()),
                )?;
                return Ok(FileOpOutcome {
                    status: "error".to_string(),
                    message: detail,
                    affected: Vec::new(),
                    audit_id,
                });
            }
        },
        FileOpRequest::CreateFile { .. } => match std::fs::File::create(&resolved.target) {
            Ok(_) => vec![resolved.target.to_string_lossy().to_string()],
            Err(error) => {
                let detail = format!("No se pudo crear el archivo: {error}");
                let audit_id = record(
                    &state,
                    &action,
                    "error",
                    &origin,
                    resolved.target.to_string_lossy().to_string(),
                    detail.clone(),
                    true,
                    latency_ms,
                    Some(detail.clone()),
                )?;
                return Ok(FileOpOutcome {
                    status: "error".to_string(),
                    message: detail,
                    affected: Vec::new(),
                    audit_id,
                });
            }
        },
        FileOpRequest::Move { .. } => {
            let mut moved = Vec::new();
            for source in &resolved.sources {
                let name = source
                    .file_name()
                    .map(PathBuf::from)
                    .ok_or("Un elemento no tiene nombre; no se puede mover.")?;
                let destination = resolved.target.join(name);
                if let Err(error) = move_path(source, &destination) {
                    let detail = format!(
                        "Se movieron {} de {} elemento(s). Falló «{}»: {error}",
                        moved.len(),
                        resolved.sources.len(),
                        source.display()
                    );
                    let audit_id = record(
                        &state,
                        &action,
                        "error",
                        &origin,
                        resolved.target.to_string_lossy().to_string(),
                        detail.clone(),
                        true,
                        latency_ms,
                        Some(detail.clone()),
                    )?;
                    return Ok(FileOpOutcome {
                        status: "error".to_string(),
                        message: detail,
                        affected: moved,
                        audit_id,
                    });
                }
                moved.push(destination.to_string_lossy().to_string());
            }
            moved
        }
    };

    let summary = match &armed.request {
        FileOpRequest::CreateFolder { .. } => {
            format!("Carpeta creada en «{}».", resolved.parent.display())
        }
        FileOpRequest::CreateFile { .. } => {
            format!("Archivo creado en «{}».", resolved.parent.display())
        }
        FileOpRequest::Move { .. } => {
            format!("Elementos movidos a «{}».", resolved.target.display())
        }
    };
    let audit_id = record(
        &state,
        &action,
        "success",
        &origin,
        resolved.target.to_string_lossy().to_string(),
        summary.clone(),
        true,
        latency_ms,
        None,
    )?;

    Ok(FileOpOutcome {
        status: "success".to_string(),
        message: summary,
        affected,
        audit_id,
    })
}

/// Registra el desenlace de una operación de escritura y devuelve su ID.
#[allow(clippy::too_many_arguments)]
fn record(
    state: &AppState,
    action: &str,
    status: &str,
    origin: &str,
    target: String,
    summary: String,
    confirmed: bool,
    latency_ms: u64,
    error: Option<String>,
) -> Result<String, String> {
    crate::audit::append(
        state,
        AuditInput {
            action: action.to_string(),
            target,
            summary,
            status: status.to_string(),
            confirmed,
            origin: origin.to_string(),
            latency_ms,
            error,
        },
    )
    .map(|entry| entry.id)
}

/// Mueve un archivo o una carpeta. `fs::rename` falla entre volúmenes, así
/// que se recurre a copiar y borrar cuando el destino está en otra unidad.
fn move_path(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(name) = source.file_name() {
        if paths::is_shell_reference(name.to_string_lossy().as_ref()) {
            return Err(format!(
                "«{}» es un script o un intérprete: no se puede mover para ejecutarlo.",
                name.to_string_lossy()
            ));
        }
    }
    match std::fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(_) if source.is_dir() => {
            copy_dir_recursive(source, destination)?;
            std::fs::remove_dir_all(source)
                .map_err(|e| format!("se copió pero no se pudo borrar el original: {e}"))?;
            Ok(())
        }
        Err(_) => {
            std::fs::copy(source, destination).map_err(|e| format!("no se pudo copiar: {e}"))?;
            std::fs::remove_file(source)
                .map_err(|e| format!("se copió pero no se pudo borrar el original: {e}"))?;
            Ok(())
        }
    }
}

/// Copia una carpeta de forma recursiva, sin seguir enlaces simbólicos.
fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|e| format!("no se pudo crear «{}»: {e}", destination.display()))?;
    let entries = std::fs::read_dir(source)
        .map_err(|e| format!("no se pudo leer «{}»: {e}", source.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("no se pudo leer una entrada: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("no se pudo leer el tipo de una entrada: {e}"))?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if file_type.is_symlink() {
            continue;
        } else if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|e| format!("no se pudo copiar «{}»: {e}", from.display()))?;
        }
    }
    Ok(())
}

/// Descarta una operación pendiente sin registrarla como ejecución.
#[tauri::command]
pub fn cancel_file_operation(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<(), String> {
    state.write(|inner: &mut Inner| {
        purge_expired(&mut inner.pending);
        inner.pending.remove(&operation_id);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use walkdir::WalkDir;

    #[test]
    fn matches_by_extension() {
        assert!(matches("informe.PDF", ".pdf"));
        assert!(!matches("informe.pdf", ".doc"));
        assert!(!matches("pdf-informe.txt", ".pdf"));
    }

    #[test]
    fn matches_by_substring_case_insensitive() {
        assert!(matches("Informe Final.docx", "informe"));
        assert!(matches("notas.txt", "TAS"));
        assert!(!matches("notas.txt", "factura"));
    }

    #[test]
    fn matches_pascalcase_and_accents_and_stems() {
        // El caso real del usuario:
        let filename = "Dialnet-LosEstudiosDeCasosComoEnfoqueMetodologico-5757749.pdf";
        assert!(matches(
            filename,
            "estudios de casos como enfoques metodológicos"
        ));
        assert!(matches(
            filename,
            "estudios de casos como enfoques metodologicos"
        ));
        assert!(matches(filename, "enfoque metodologico"));
        assert!(matches(filename, "estudios de caso"));
    }

    #[test]
    fn empty_query_never_matches() {
        assert!(!matches("cualquier.txt", ""));
        assert!(!matches("cualquier.txt", "   "));
    }

    #[test]
    fn finds_file_under_canonicalized_root() {
        // Regresión: en Windows `canonicalize` devuelve la raíz con prefijo
        // verbatim (`\\?\C:\…`). Si el recorrido parte de la raíz sin
        // canonicalizar, `path.starts_with(root)` es falso para toda entrada y
        // la búsqueda devuelve siempre cero resultados.
        let base = std::env::temp_dir().join(format!("aster_find_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("hola.pdf"), b"x").unwrap();

        let canonical = std::fs::canonicalize(&base).unwrap();

        let mut found = false;
        for entry in WalkDir::new(&canonical)
            .follow_links(false)
            .into_iter()
            .flatten()
        {
            if entry.depth() == 0 {
                continue;
            }
            let path = entry.path();
            if !path.starts_with(&canonical) {
                continue;
            }
            if let Some(hit) = to_hit(path, "downloads") {
                if matches(&hit.name, "hola.pdf") {
                    assert!(
                        !hit.path.starts_with(r"\\?\"),
                        "la ruta mostrada no debe conservar el prefijo verbatim: {}",
                        hit.path
                    );
                    assert_eq!(
                        std::fs::canonicalize(&hit.path).unwrap(),
                        canonical.join("hola.pdf")
                    );
                    found = true;
                }
            }
        }
        assert!(found, "no se encontró hola.pdf bajo la raíz canonicalizada");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn matches_specific_filename_with_extension() {
        // Caso real: «busca pago.pdf en Documentos».
        assert!(matches("pago.pdf", "pago.pdf"));
        assert!(matches("Pago.PDF", "pago.pdf"));
        assert!(matches("pago (1).pdf", "pago.pdf"));
        assert!(matches("comprobante de pago.pdf", "pago.pdf"));
        assert!(!matches("informe.pdf", "pago.pdf"));
    }

    #[test]
    fn finds_shallow_file_before_descending_into_large_folder() {
        // Regresión: el recorrido antiguo era DFS y, si la primera carpeta del
        // nivel tenía muchas entradas, agotaba el tope antes de ver un archivo
        // suelto en la raíz (p. ej. «pago.pdf» justo en Documentos).
        let base = std::env::temp_dir().join(format!("aster_bfs_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("carpeta-grande")).unwrap();
        for i in 0..40 {
            let name = format!("relleno-{i}.pdf");
            std::fs::write(base.join("carpeta-grande").join(name), b"x").unwrap();
        }
        std::fs::write(base.join("pago.pdf"), b"x").unwrap();

        let hits = search_files(&[base.clone()], "pago.pdf", 1, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "pago.pdf");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn prunes_work_folders_but_not_the_root_itself() {
        assert!(should_skip_dir(Path::new("proyecto/node_modules")));
        assert!(should_skip_dir(Path::new("proyecto/src-tauri/target")));
        assert!(!should_skip_dir(Path::new("Documentos/pago.pdf")));
    }

    #[test]
    fn folders_only_excludes_files() {
        // «Busca la carpeta Andi»: solo debe devolver la carpeta, no Andi.zip
        // ni los archivos de Andicod.
        let base = std::env::temp_dir().join(format!("aster_folders_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("Andi")).unwrap();
        std::fs::write(base.join("Andi.zip"), b"x").unwrap();

        let hits = search_files(&[base.clone()], "Andi", 10, true).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].is_directory);
        assert_eq!(hits[0].name, "Andi");

        let _ = std::fs::remove_dir_all(&base);
    }
}

/* ------------------------------------------------------------------ */
/* Revelar en el Explorador                                            */
/* ------------------------------------------------------------------ */

/// Muestra una ruta en el Explorador de Windows (carpeta abierta o archivo
/// seleccionado). Solo acepta rutas existentes dentro de las carpetas
/// autorizadas: la misma guarda que protege buscar, crear y mover.
#[tauri::command]
pub fn reveal_in_folder(state: State<'_, AppState>, path: String) -> Result<String, String> {
    paths::ensure_plain_text(&path, "ruta")?;
    let profile = state.profile()?;
    let allowed = paths::canonical_roots(&all_roots(&profile));
    let resolved = paths::resolve_in_roots(&path, &allowed, false)?;
    let display = resolved.to_string_lossy().to_string();
    if resolved.is_dir() {
        crate::win::shell_execute(&display, "")?;
    } else {
        crate::win::shell_execute("explorer.exe", &format!("/select,\"{display}\""))?;
    }
    Ok(format!("He mostrado «{display}» en el Explorador."))
}
