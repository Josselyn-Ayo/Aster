# AGENTS.md

ASTER is a Tauri 2 desktop app: `src/` is the React + TypeScript + Tailwind frontend; `src-tauri/` is the native Rust backend. Frontend and backend talk only over Tauri IPC. Windows-only (WebView2 + MSVC).

## Commands
- `npm run tauri dev` — full dev with HMR (Vite on fixed port **1420**; keep it free).
- `npm run build` — typechecks then builds the frontend (`tsc && vite build`).
- `npm run test` — frontend unit tests (`vitest run`): router, TTS sanitizer, formatters.
- `npm run bench` — benchmarks de frontend E1/E4 con `tinybench` (`*.bench.ts`). No forman parte de `npm test`.
- `npm run bench:rust` — benchmarks nativos E2/E3 con `criterion` y `--profile perf` (aquí `panic = "unwind"`, porque release usa `abort`). La primera compilación tarda varios minutos.
- `npm run perf:criterion` — exporta las medianas de criterion a `docs/perf/rust-bench.md`.
- `npm run perf:report` — resume `metrics.jsonl` y `audit.jsonl` en `docs/perf/` (E5, observacional).
- `npm run perf:recursos` — mide arranque, RAM y CPU del ejecutable de release (E6).
- `npm run tauri build` — production installer (.msi/.exe).
- Build each backend change with `cargo build` in `src-tauri/`.
- `cargo test` in `src-tauri/` — backend unit tests (file search, web search parsers, paths). The live network test is `#[ignore]`; run it with `cargo test -- --ignored`.
- There is no lint script. Verification = `npm test` + `npm run build` + `cargo test` + `cargo build`.

## Architecture (read these before changing behavior)

The frontend follows **MVC adaptado a React**. Layers only talk downwards:

```
src/views/          V  Componentes React. Solo pintan y emiten eventos.
src/hooks/          V→C  Adaptadores: useAster, useSpeech, useAiConfig.
src/controllers/    C  AsterController: orquesta el flujo, estado observable.
src/model/          M  Dominio puro: IA (proveedores/rutas), enrutado, uso.
src/services/       Infraestructura: IPC Tauri, voz, historial, auditoría.
```

- `AsterController` (`src/controllers/AsterController.ts`) es el único orquestador: interpretar → ejecutar en el catálogo → hablar → medir. Es una clase TS sin React; las vistas se suscriben con `useSyncExternalStore` y la voz entra por el puerto `SpeechPort`. No metas lógica de negocio en `src/hooks/useAster.ts` (solo cablea el controlador) ni llamadas a IA en las vistas.
- Intent routing is two-tier: `fastRoute()` in `src/model/ai/chat.ts` resolves obvious cases locally (zero tokens, including plain questions/greetings); only ambiguous input calls the LLM router. Add new patterns to `fastRoute` AND a case in `src/model/ai/chat.test.ts`.
- Chat history sent to the model is capped (`MAX_HISTORY_MESSAGES`, images stripped) and outputs are capped per call site. Do not re-send base64 images in history.
- 429/quota errors are NOT retried (only 503 is). Keep it that way: `runAi` skips to the next provider on 429/401/403 and retries once on 503.
- **IA multi-proveedor** (`src/model/ai/`): `runAi(capability, request)` recorre la cadena configurada para `chat | router | vision | transcribe | image | search`. Adaptadores: `providers/gemini.ts` (SDK) y `providers/openai.ts` (Groq/OpenRouter/Mistral/Ollama, API OpenAI-compatible con `fetch`). Para añadir un proveedor: una entrada en `providers/index.ts` y ya aparece en Ajustes.
- **Búsqueda en Internet** (`src/model/ai/search.ts`): no usa la capacidad `search` por defecto. Llama al comando Rust `web_search` (`websearch.rs`), que consulta DuckDuckGo (con Bing de respaldo si hay captcha) y devuelve el texto de las 3 primeras páginas, y resume con la capacidad `chat`. Recibe `navigator.language` para regionalizar (`kl=pe-es`, `setlang`). La capacidad `search` (Gemini + Google Search) solo se usa como respaldo: su cuota gratuita es 0 y responde 429 aunque no hayas buscado hoy. La descarga va en Rust porque DuckDuckGo no envía CORS.
- **Búsqueda local de archivos** (`src-tauri/src/files.rs`): `find_files` delega en `search_files`, que recorre las raíces **por niveles (BFS)** con tope `MAX_ENTRIES` (20 000) y poda carpetas de trabajo (`node_modules`, `.git`, `target`, `dist`, `build`, `.venv`, `__pycache__`, `.cache`, `.gradle`). **No volver a un DFS**: con DFS una carpeta enorme agotaba el tope antes de ver un archivo suelto en la raíz (caso real: `pago.pdf` en Documentos). Los nombres exactos se ordenan primero, luego carpetas y por fecha. El recorrido debe partir de raíces canonicalizadas (prefijo verbatim de Windows) y cada candidato se revalida contra ellas. `folders_only` filtra archivos en el backend.
- **«Busca la carpeta X»**: `extractFileSearch` (`src/model/ai/chat.ts`) devuelve `{ query, scope, foldersOnly }`; `foldersOnly` viaja en `AsterIntent.find_files` → `AsterController` → `aster.findFiles` → Rust. El esquema del enrutador LLM lo incluye como `foldersOnly` y `parseRoutedIntent` lo lee. Si se pierde ese campo, la búsqueda vuelve a mezclar archivos y carpetas (p. ej. «Andi» trae `Andicod` y `Andi.zip`).
- Defaults in `src/model/ai/config.ts`: `DEFAULT_PROVIDERS` + `DEFAULT_ROUTES` (Groq first for chat/router/transcribe; Gemini for vision/image/search). `loadAiConfig()` migrates the old `aster.gemini.config`. Watch for stale/renamed model IDs.
- **API keys**: priority = key typed in Ajustes → `.env` read by the Rust command `ai::provider_env_key` (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, plus the `VITE_*` variants) → `import.meta.env` (browser-only dev). Keys do reach the WebView (same trust level as the old `VITE_`), but they are not baked into the installer. Never log or commit a key.
- Vision screenshots are captured by the Rust command `capture_screen_jpeg`: resized to **1280 px wide** and encoded as **JPEG q=80** before Base64, which cuts the tokens per capture by roughly an order of magnitude. Keep the resize when touching `screen.rs`.
- `usage.ts` keeps a local per-provider/per-capability counter in `aster.ai.usage` (reset daily); Ajustes shows it under «Consumo de hoy».
- Chat messages can carry structured extras (`ChatMessage.systemReport` / `fileHits` / `undoMove` in `src/types/index.ts`) rendered as cards in `views/ChatBox.tsx`. TTS speaks a sanitized version (`sanitizeForSpeech` in `tts.ts`), never raw markdown/URLs.
- localStorage keys: `aster.ai.config` (providers + routes), `aster.ai.usage`, `aster.gemini.config` (legacy, read-only), `aster.speech.policy`, `aster.conversation.history`.

## Adding a new IPC command (2 required places)
1. Implement it as a `#[tauri::command]` in a module under `src-tauri/src/` (e.g. `files.rs`, `automation.rs`, `screen.rs`).
2. Register it in `invoke_handler!` in `src-tauri/src/lib.rs` (`generate_handler![...]`).
(`src-tauri/capabilities/default.json` only grants `core:default`; custom `invoke` commands need no extra permission entry.)
Then call it from the frontend with `invoke(...)` (`src/services/aster/commands.ts` shows the pattern).
Security rule: every command that opens/launches/reveals must validate against the profile (`ensure_permitted` + whitelist/roots) — see `automation::launch_app` and `files::reveal_in_folder`.

## Gotchas
- Mic: `lib.rs` builds the window with `on_permission_request` that auto-approves `PermissionKind::Microphone` in WebView2. If removed, voice input silently fails. Preserve it when touching `setup`.
- Rust lib name is `aster_desktop_assistant_lib` (`_lib` suffix is required on Windows to avoid bin name clash); bin is `aster-desktop-assistant`.
- IPC arg names are passed as-is from JS: Rust `uri_or_query` ↔ JS `{ uriOrQuery }`, `app_name` ↔ `{ appName }`, `screen_count` uses no args.
- `launch_authorized` (`src-tauri/src/win.rs`) must try the full target path FIRST (Start Menu `.lnk` paths contain spaces); only split `program + args` when the whole path doesn't resolve (e.g. `explorer.exe https://…`). Every resolved target is launched with `ShellExecuteW`, never `cmd start`. `in_start_menu` matches by name or by saved `.lnk` filename (self-heals moved shortcuts).
- `files::confirm_file_operation` returns `affected` = NEW locations for moves (used by undo). Audit/metrics append single JSONL lines (`append_jsonl_line`); full rewrites only on prune/clear.
- Tailwind custom palette/extras live in `tailwind.config.js` under `aster` (e.g. `bg-aster-bg`, `text-aster-text`); base styles are in `src/index.css` (`body` has `user-select: none` — add `select-text` to anything copyable).
- `src-tauri/target` and `src-tauri/gen` are gitignored build artifacts — don't edit them.
- `ai::provider_env_key` only reads the allow-listed env vars; it is not a security boundary (the value crosses IPC). If keys must never reach the WebView, move the provider calls to Rust — that is the planned Phase 1.5 (`reqwest` proxy, and `reqwest` is already a dependency for `websearch.rs`).
- `web_search` (`websearch.rs`) only fetches public `http(s)` URLs (rejects localhost/private ranges), trims HTML to 500 000 chars per page and keeps 3000 chars of text. DuckDuckGo's markup is parsed by hand: if you touch it, run `cargo test` (the module has parser tests).
- Ollama (local fallback) needs `OLLAMA_ORIGINS=*` when running, and its OpenAI-compatible endpoint is `http://localhost:11434/v1`. The registry skips providers without a key, so Ollama is only used if added to a chain.
- Runtime data lives in `%APPDATA%\com.aster.assistant`: `profile.json` (permissions, roots, apps), `audit.jsonl`, `metrics.jsonl`, `db_config.json`. Read `audit.jsonl` before guessing about routing bugs: it records the exact `find_files` query, result count and latency the backend actually got.
- Frontend tests: `src/model/ai/chat.test.ts` (`fastRoute`/`extractFileSearch`), `src/model/ai/intent.test.ts` (`parseRoutedIntent`), `src/services/aster/commands.test.ts` (IPC mapping), plus formatter/TTS/router suites. Backend tests are inline `#[cfg(test)]` modules next to each `src-tauri` module.

## Docs map
- `README.md` — instalación y uso para el usuario final.
- `PATRON.md` — prompt para generar la figura MVC de la tesis (layers + tools). Si cambian las capas MVC o la lista de herramientas, actualízalo también.
- `docs/PRUEBAS_RENDIMIENTO.md` — informe de las pruebas E1–E6 y resultados versionados en `docs/perf/`.
- `AGENTS.md` — este archivo: invariantes que debe respetar cualquier agente.

## Known limitations
- `image` capability requires Gemini billing: `gemini-3.1-flash-image` returns 429 on the free tier.
- Gemini grounded search (`search` capability with Google Search) returns 429 `RESOURCE_EXHAUSTED` even with no prior usage on the free tier. Keep the local `web_search` + `chat` synthesis as the default; the `search` chain is fallback only.
