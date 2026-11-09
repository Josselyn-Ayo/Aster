# ASTER — Asistente Virtual Multimodal de Escritorio

**ASTER** es un asistente virtual de escritorio multimodal desarrollado con
**Tauri 2**, **React**, **TypeScript**, **Tailwind CSS** y varios proveedores
de IA (Groq, Google Gemini, OpenRouter, Mistral u Ollama). Combina una interfaz
moderna y futurista con un backend nativo en Rust para el análisis visual de la
pantalla, la generación de imágenes, la búsqueda en Internet y un catálogo
cerrado de acciones controladas por el modelo.

Este repositorio constituye la base tecnológica de la tesis de ingeniería:
***ASTER: Asistente Virtual Multimodal de Escritorio***.

---

## 1. Inicio rápido

### 1.1 Requisitos

| Requisito            | Uso                                                 |
| -------------------- | --------------------------------------------------- |
| Node.js ≥ 20         | Frontend (Vite, React, Tailwind)                    |
| Rust (rustup, MSVC)  | Compilación del backend nativo de Tauri             |
| MSVC Build Tools     | Linker `link.exe` y compilador C/C++ (workload C++) |
| WebView2 Runtime     | Motor web de la app (incluido en Windows 11)        |

```powershell
# Rust + toolchain MSVC
winget install Rustlang.Rustup

# Visual Studio Build Tools con la carga "Desktop development with C++"
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --norestart"
```

### 1.2 Variables de entorno

Copia `.env.example` a `.env` y añade al menos una clave. El reparto
recomendado usa Groq para texto y voz, y Gemini para visión e imágenes:

```
GROQ_API_KEY=tu_clave_de_groq
GEMINI_API_KEY=tu_clave_de_gemini
```

Las claves se leen en el backend (`dotenvy`) y se piden por IPC, así que **no**
se incrustan en el bundle del instalador. También pueden introducirse desde
Ajustes → IA, donde se guardan solo en el `localStorage` del dispositivo.

### 1.3 Comandos para ejecutar todo

```powershell
# 1) Instalar dependencias del frontend (solo la primera vez)
npm install

# 2) Modo desarrollo: Vite en el puerto 1420 + backend nativo con HMR
npm run tauri dev

# 3) Compilar solo el frontend (typecheck + bundle)
npm run build

# 4) Compilar la aplicación nativa sin empaquetar (exe de release)
npm run tauri build -- --no-bundle

# 5) Generar el instalador de producción (.msi / .exe, NSIS)
npm run tauri build
```

> El puerto **1420** está fijado en `vite.config.ts`; mantenlo libre o el modo
> desarrollo no arrancará.

> El crate Rust se compila por separado con `cargo build` dentro de `src-tauri/`
> (o `cargo build --release` para la build optimizada con LTO).

### 1.4 Archivos a eliminar antes de comprimir el código fuente en .zip

Estos elementos son artefactos, dependencias instaladas o secretos: no forman
parte del código fuente y ocupan la mayor parte del peso.

```text
node_modules/          # dependencias de Node (~200 MB); se regenera con npm install
src-tauri/target/      # artefactos de compilación de Rust (~2-8 GB)
src-tauri/gen/         # esquemas generados por Tauri; se regeneran al compilar
dist/                  # bundle del frontend; se regenera con npm run build
.env                   # contiene tu clave de API: nunca debe salir del equipo
*.log                  # logs de compilación o de la app
Thumbs.db              # caché de miniaturas de Windows
desktop.ini            # metadatos de carpeta de Windows
.DS_Store              # metadatos de macOS
.vscode/.history/      # historial local del editor
```

PowerShell para limpiarlo antes de comprimir:

```powershell
Remove-Item -Recurse -Force node_modules, src-tauri\target, src-tauri\gen, dist -ErrorAction SilentlyContinue
Get-ChildItem -Recurse -Force -Include *.log, Thumbs.db, desktop.ini, .DS_Store |
  Remove-Item -Force -ErrorAction SilentlyContinue
```

**No elimines** `src-tauri/Cargo.lock` ni `package-lock.json`: fijan las
versiones exactas de las dependencias y permiten reconstruir el proyecto de
forma reproducible.

---

## 2. Arquitectura del proyecto

El proyecto se divide en dos subsistemas que se comunican únicamente por el
mecanismo de **IPC (Inter-Process Communication)** que expone Tauri:

- **Frontend (React + Tailwind)**: interfaz, voz (STT/TTS) e integración con
  los proveedores de IA. Decide *qué acción del catálogo* corresponde a la
  orden del usuario.
- **Backend nativo (Rust)**: autoridad de seguridad. Valida permisos, confines
  rutas, ejecuta las acciones y registra la auditoría.

```
aster-desktop-assistant/
│
├── src/                          # FRONTEND (React + TypeScript + Tailwind)
│   ├── views/                    # V · UI: ChatBox, Visualizer, SettingsModal,
│   │                             #     ConfirmDialog, HistoryPanel, DataPolicy,
│   │                             #     AuthorizedApps, ProfileSettings, AiSettings
│   ├── hooks/                    # V→C · useAster.ts (adaptador del controlador),
│   │                             #     useSpeech.ts, useAiConfig.ts
│   ├── controllers/              # C · AsterController: orquesta el flujo completo
│   │                             #     (interpretar → catálogo → hablar → medir)
│   ├── model/                    # M · Dominio puro, sin React ni IPC
│   │   └── ai/                   #     runAi + cadena de proveedores, routing,
│   │                             #     configuración, contador de consumo
│   ├── services/
│   │   ├── aster/                #   Contrato IPC del catálogo cerrado
│   │   │   ├── commands.ts       #     Las ocho acciones + política
│   │   │   ├── audit.ts          #     Historial, exportación y métricas
│   │   │   └── db.ts             #     Puente IPC con Mongo Atlas (híbrido)
│   │   ├── speech/               #   stt.ts (STT) y tts.ts (TTS)
│   │   ├── history/              #   Historial de conversación local
│   │   ├── web/search.ts         #   Puente IPC con la búsqueda DuckDuckGo
│   │   └── automation/system.ts  #   YouTube, Spotify y URLs
│   ├── types/                    #   index.ts y aster.ts (tipos del dominio)
│   └── App.tsx, main.tsx, index.css
│
├── src-tauri/                    # BACKEND NATIVO (Rust)
│   ├── icons/                    #   Iconos de la aplicación (.ico, .png)
│   ├── capabilities/default.json #   Permisos: solo `core:default`, sin plugins
│   ├── src/
│   │   ├── lib.rs                #   Ventana, micrófono e invoke_handler
│   │   ├── main.rs               #   Punto de entrada binario
│   │   ├── ai.rs                 #   Claves de IA leídas del .env (IPC)
│   │   ├── model.rs              #   Contratos serde en camelCase
│   │   ├── paths.rs              #   Guardas anti-shell y canonicalización
│   │   ├── policy.rs             #   Catálogo, permisos y lista blanca
│   │   ├── files.rs              #   Búsqueda, creación y movimiento
│   │   ├── audit.rs              #   Auditoría y métricas de evaluación
│   │   ├── db.rs                 #   Mongo Atlas: espejo y lecturas híbridas
│   │   ├── conversations.rs      #   Colección `conversations` (IPC)
│   │   ├── sysreport.rs          #   Acción 3: información del sistema
│   │   ├── screen.rs             #   Captura JPEG reducida (1280 px)
│   │   ├── websearch.rs          #   Búsqueda DuckDuckGo + texto de páginas
│   │   ├── automation.rs         #   Apps autorizadas y URLs
│   │   ├── win.rs                #   ShellExecuteW, menú Inicio, batería
│   │   ├── state.rs              #   Estado compartido y persistencia
│   │   └── commands.rs           #   Utilidades
│   ├── Cargo.toml, Cargo.lock, build.rs, tauri.conf.json
│
├── .env.example                  # Plantilla de variables de entorno
├── index.html                    # HTML raíz y tipografías
├── package.json                  # Dependencias de Node
├── tailwind.config.js            # Paleta `aster` y estilos
├── postcss.config.js             # PostCSS (Tailwind + Autoprefixer)
├── vite.config.ts                # Puerto fijo 1420
├── tsconfig.json                 # Configuración de TypeScript
└── README.md                     # Este documento
```

### 2.1 El catálogo cerrado de acciones

El asistente solo puede ejecutar estas siete acciones, definidas en
`src-tauri/src/policy.rs` y expuestas por `invoke_handler`:

| Acción                 | Confirmación | Toca el disco |
| ---------------------- | :----------: | :-----------: |
| `open_authorized_app`  |      no      |      no       |
| `web_search`           |      no      |      no       |
| `system_info`          |      no      |      no       |
| `find_files`           |      no      |      no       |
| `create_folder`        |    **sí**    |      sí       |
| `move_files`           |    **sí**    |      sí       |
| `action_history`       |      no      |      no       |

No existe ningún comando genérico de «ejecuta esto» ni de «lee este archivo».
El modelo elige una acción del catálogo y el backend la revalida.

---

## 3. Diseño de módulos clave

### 3.1 Módulo de Voz (STT y TTS)

El subsistema de voz vive en `src/services/speech/` y se controla desde
`useSpeech`.

- **Speech-to-Text** (`stt.ts`): estrategia en dos niveles.
  1. **Web Speech API** (`SpeechRecognition`) cuando el motor del WebView2 la
     expone.
  2. **Respaldo Gemini**: captura con `MediaRecorder`, conversión a Base64 y
     transcripción con el modelo multimodal (`transcribeAudio` en `chat.ts`).
- **Text-to-Speech** (`tts.ts`): usa `speechSynthesis`, que en Windows expone
  las voces SAPI nativas: síntesis local con prioridad a español.

El ciclo cerrado se orquesta en `AsterController.sendText`, que termina leyendo
la respuesta en voz alta.

> El micrófono se autoriza en `src-tauri/src/lib.rs` con `on_permission_request`,
> concediendo solo `PermissionKind::Microphone`. WebView2 no muestra su propio
> diálogo, así que sin ese handler `getUserMedia()` se rechaza en silencio.

### 3.2 Acciones de escritura y confirmación

`create_folder` y `move_files` siguen un patrón de dos fases:

1. `prepare_file_operation` valida la petición (raíces permitidas, sin `..`, sin
   enlaces simbólicos, sin zonas del sistema) y deja la operación *armada* con
   dos minutos de caducidad. No escribe nada.
2. `confirm_file_operation` **revalida** contra el perfil y el disco actuales, y
   solo entonces ejecuta. Registra el desenlace en la auditoría con un
   identificador propio y devuelve ese `auditId`.

### 3.3 Módulo de Visión Multimodal

1. **Captura**: `capture_screen_jpeg` (`screen.rs`) obtiene el bitmap con la
   crate `screenshots`, lo reduce a 1280 px de ancho y lo codifica como JPEG
   (calidad 80) antes de devolverlo en Base64: así cada consulta cuesta una
   fracción de los tokens que costaba el PNG a resolución nativa.
2. **Análisis**: `describeScreen()` (`model/ai/service.ts`) envía la imagen al
   proveedor de visión configurado (Gemini por defecto) junto a la pregunta y
   devuelve una descripción que ASTER lee en voz alta.

### 3.4 Módulo de Generación de Imágenes

`generateImage()` (`model/ai/service.ts`) pide la imagen a la capacidad
`image`, que por defecto usa un modelo `gemini-*-image` vía `generateContent`
(los modelos Imagen no están en la capa gratuita). El flujo interpreta la
orden, genera la imagen, la muestra como burbuja en el `ChatBox` y confirma
verbalmente. Si la cuota de imágenes está agotada, el error lo dice con
claridad y no se pierde la conversación.

### 3.5 Módulo de Búsqueda en Internet

`webSearch()` (`model/ai/search.ts`) no depende de la cuota de búsqueda de
Gemini, que en la capa gratuita está a cero:

1. El comando Rust `web_search` (`websearch.rs`) consulta DuckDuckGo (y, si
   este pide un captcha, Bing), descarga las tres primeras páginas y devuelve
   su texto legible. Se hace en Rust porque los buscadores no permiten CORS
   desde el WebView.
2. El modelo de conversación (Groq por defecto) resume esos textos en un
   párrafo breve con cifras y fechas. El idioma del sistema
   (`navigator.language`) se pasa como pista para regionalizar los resultados
   y no mezclar países (por ejemplo, el precio del dólar de otro país).
3. Solo si lo anterior falla se usa la capacidad `search` configurada (Gemini
   con Google Search), que actúa como respaldo.

Las fuentes que se muestran son los enlaces reales de los resultados. Las
páginas se validan en Rust: solo `http`/`https` y nunca hosts locales o
privados.

---

## 4. Comandos IPC expuestos por Rust

### Catálogo cerrado

| Comando                  | Módulo   | Función                                          |
| ------------------------ | -------- | ------------------------------------------------ |
| `open_authorized_app`    | policy   | Abre una app de la lista blanca                 |
| `system_report`          | sysreport| Informe de CPU, RAM, discos, batería y procesos |
| `find_files`             | files    | Busca archivos y carpetas en las raíces         |
| `prepare_file_operation` | files    | Prepara y arma una escritura para confirmar     |
| `confirm_file_operation` | files    | Ejecuta (o cancela) la operación armada          |
| `cancel_file_operation`  | files    | Descarta la operación pendiente                 |
| `audit_list`             | audit    | Historial filtrado y paginado                   |
| `audit_stats`            | audit    | Agregados del historial                         |

### Política y lista blanca de aplicaciones

| Comando              | Módulo | Función                                     |
| -------------------- | ------ | ------------------------------------------- |
| `policy_catalog`     | policy | Catálogo de acciones y sus permisos         |
| `policy_get`         | policy | Perfil del usuario                          |
| `policy_update`      | policy | Actualiza nombre, permisos, raíces y retención |
| `policy_is_allowed`  | policy | ¿La acción está permitida?                 |
| `policy_roots`       | policy | Raíces autorizadas                          |
| `apps_scan`          | policy | Detecta instaladores del menú Inicio        |
| `app_set_allowed`    | policy | Autoriza o revoca una aplicación            |
| `apps_allowed`       | policy | Aplicaciones autorizadas                    |

### Auditoría y métricas

| Comando             | Módulo | Función                                |
| ------------------- | ------ | -------------------------------------- |
| `audit_append`      | audit  | Registra una acción                    |
| `audit_export`      | audit  | Exporta el historial a CSV o JSON      |
| `audit_clear`       | audit  | Vacía el historial                     |
| `metrics_append`    | audit  | Registra una interacción evaluada      |
| `metrics_rate`      | audit  | Voto de usabilidad (👍/👎)             |
| `metrics_summary`   | audit  | Indicadores de latencia y éxito        |
| `metrics_clear`     | audit  | Vacía las métricas                    |

### Persistencia híbrida (Mongo Atlas)

| Comando                    | Módulo        | Función                                        |
| -------------------------- | ------------- | ---------------------------------------------- |
| `db_status`                | db            | Estado de la conexión (sin exponer la URI)     |
| `db_configure`             | db            | Guarda la URI/BD y comprueba la conexión       |
| `db_sync`                  | db            | Migra perfil + auditoría + métricas a Atlas    |
| `db_sync_conversations`    | db            | Sube las sesiones del `localStorage`           |
| `conversation_save`        | conversations | Espeja una sesión (segundo plano)              |
| `conversations_list`       | conversations | Sesiones desde Atlas (o local si falla)        |
| `conversation_delete`      | conversations | Elimina una sesión                             |
| `conversations_clear`      | conversations | Vacía la colección `conversations`             |

### Automatización, visión y utilidades

| Comando              | Módulo     | Función                                     |
| -------------------- | ---------- | ------------------------------------------- |
| `play_youtube`       | automation | Abre YouTube con una búsqueda              |
| `play_spotify`       | automation | Busca o reproduce en Spotify               |
| `launch_app`         | automation | Abre una app **solo si está autorizada**   |
| `open_url`           | automation | Abre una URL `http`/`https`               |
| `capture_screen_jpeg` | screen    | Captura la pantalla en JPEG reducido (Base64) |
| `screen_count`       | screen     | Número de pantallas                       |
| `web_search`         | websearch  | Busca en DuckDuckGo y devuelve el texto de las páginas |
| `provider_env_key`   | ai         | Clave de IA leída del `.env`              |
| `get_system_info`    | commands   | Metadatos del sistema                     |
| `data_dir`           | commands   | Ruta del directorio de datos de la app     |

> Las llamadas a los proveedores de IA salen del frontend; sus dominios están
> declarados en `connect-src` del CSP de `tauri.conf.json`
> (`generativelanguage.googleapis.com`, `api.groq.com`, `openrouter.ai`,
> `api.mistral.ai` y `localhost:11434` para Ollama). Si añades otro proveedor,
> añade también su dominio o la petición se bloquea en silencio. La búsqueda
> web no necesita CSP: la descarga la hace Rust (`web_search`).

---

## 5. Seguridad

- **Sin plugins de Tauri**: `capabilities/default.json` concede únicamente
  `core:default`. No se registra `plugin-shell`, `plugin-fs` ni `plugin-http`, y
  sus dependencias se eliminaron de `package.json`.
- **Sin shell**: nada se ejecuta con `cmd` o PowerShell. Todo se abre con
  `ShellExecuteW` sobre un objetivo ya resuelto y validado.
- **Anti-inyección**: `paths.rs` rechaza metacaracteres de shell (`& | ; < > `
  $ ( )`), opciones que empiezan por `-`, intérprete de comandos, scripts
  (`.bat`, `.cmd`, `.ps1`, `.vbs`, `.js`, …) y los dispositivos reservados
  (`CON`, `PRN`, `NUL`, `COM1`…).
- **Confinamiento de rutas**: las rutas se canonicalizan y solo se aceptan
  dentro de las raíces permitidas (Escritorio, Documentos, Descargas, Imágenes,
  Música, más las que añadas). Se rechazan `..`, enlaces simbólicos y carpetas
  del sistema (`Windows`, `Program Files`).
- **Lista blanca de aplicaciones**: `launch_app` y `open_authorized_app` solo
  abren objetivos que el usuario haya autorizado en Ajustes.
- **Mínimo privilegio**: cada permiso del perfil se vuelve a comprobar en el
  backend antes de ejecutar, no solo en la interfaz.
- **Confirmación obligatoria**: las dos acciones que escriben en el disco
  requieren confirmación explícita y revalidación en el momento del clic.
- **Auditoría autoritativa**: el backend registra cada acción intentada,
  incluidas las denegadas. Las operaciones de escritura las registra el propio
  backend con un ID real.
- **Datos locales**: perfil, auditoría y métricas viven en el directorio de
  datos de la app (`%APPDATA%\com.aster.assistant`) como `profile.json`,
  `audit.jsonl` y `metrics.jsonl`, con retención y presupuesto de disco.
- **Datos en la nube (opcional)**: con Atlas la copia se hace en segundo plano.
  La URI nunca se registra en logs, no se devuelve completa por IPC (solo una
  vista con `***`) y vive únicamente en `.env` o en `db_config.json` local.
- **API key**: nunca se commitea. Vive en `.env` o en el `localStorage` del
  dispositivo.

---

## 6. Persistencia híbrida (MongoDB Atlas)

ASTER guarda todo **primero en local** y luego lo espeja a **MongoDB Atlas** en
segundo plano. El almacenamiento local —`profile.json`, `audit.jsonl`,
`metrics.jsonl` y el historial en `localStorage`— sigue siendo la **fuente de
verdad**; Atlas es la **copia en la nube**. Si Atlas no responde (sin internet,
IP no autorizada o cluster pausado), la app sigue funcionando en local y
reintenta después (disyuntor de 30 s). Las lecturas intentan Atlas primero y
caen a local si falla. La configuración está en `docs/MONGODB_ATLAS.md`.

Las 4 colecciones viven en la base **`aster`** y cada una es el espejo exacto de
una fuente local. El campo `_id` se fija explícitamente para que la migración
sea **idempotente**: volver a subir actualiza el documento en juego, no lo
duplica.

| Fuente local                     | Colección       | `_id`       | Sincronización       |
| -------------------------------- | --------------- | ----------- | -------------------- |
| `profile.json`                   | `profiles`      | `"profile"` | reemplaza (upsert)   |
| `audit.jsonl` (1 línea = 1 acción)| `audits`       | id auditoría| inserta (idempotente)|
| `metrics.jsonl` (1 línea = 1 uso)| `metrics`       | id métrica  | inserta (idempotente)|
| `localStorage` (historial de chat)| `conversations`| id sesión   | reemplaza (upsert)   |

> En MongoDB no son «tablas» sino **colecciones** de documentos BSON; se
> serializan en `camelCase` porque es el formato que espera el frontend.

### 6.1 `profiles` — perfil del usuario

Un **único documento** con `_id = "profile"` que guarda toda la configuración
del perfil.

| Campo                            | Tipo              | Descripción                                          |
| -------------------------------- | ----------------- | ---------------------------------------------------- |
| `_id`                            | string            | Siempre `"profile"`                                  |
| `userName`                       | string            | Nombre de la cuenta local                            |
| `permissions`                    | objeto `{acción: bool}` | Qué acciones del catálogo están permitidas    |
| `allowedApps[].displayName`      | string            | Nombre visible de la app autorizada                  |
| `allowedApps[].target`           | string            | Ejecutable o ruta (`notepad.exe`)                    |
| `allowedApps[].allowed`          | bool              | Autorizada o no (por defecto `false`)                |
| `allowedApps[].source`           | string            | `"core"` (propuesta) o el origen detectado           |
| `extraRoots`                     | array de string   | Carpetas extra donde puede buscar/operar             |
| `retentionDays`                  | número            | Días de retención del historial                      |
| `maxHistoryKb`                   | número            | Tope de tamaño del historial                         |
| `createdAt`                      | string ISO        | Fecha de creación                                    |

```json
{
  "_id": "profile",
  "userName": "dgcis",
  "permissions": { "create_folder": true, "open_app": false },
  "allowedApps": [
    { "displayName": "Explorador de archivos", "target": "explorer.exe", "allowed": true, "source": "core" }
  ],
  "extraRoots": ["C:\\Proyectos"],
  "retentionDays": 30,
  "maxHistoryKb": 2048,
  "createdAt": "2026-10-11T18:00:00.000Z"
}
```

### 6.2 `audits` — registro de acciones

Un documento por acción ejecutada (cada línea de `audit.jsonl`). Índice en
`timestamp` descendente.

| Campo        | Tipo             | Descripción                                              |
| ------------ | ---------------- | -------------------------------------------------------- |
| `_id`        | string           | Id único de la entrada                                   |
| `timestamp`  | string ISO       | Cuándo ocurrió                                           |
| `action`     | string           | Acción del catálogo (`conversation`, `move_files`, …)    |
| `label`      | string           | Nombre legible para mostrar                              |
| `status`     | string           | `success`, `error`, `denied`, `cancelled`…               |
| `target`     | string           | Sobre qué actuó (ruta, app, URL)                         |
| `summary`    | string           | Resumen para el historial                                |
| `confirmed`  | bool             | Si el usuario confirmó una operación sensible            |
| `origin`     | string           | Origen: `ui`, `voice`, `automation`…                     |
| `latencyMs`  | número           | Duración de la acción en milisegundos                    |
| `error`      | string (opcional)| Mensaje de error; se omite si no hay                     |

### 6.3 `metrics` — muestras de evaluación

Un documento por interacción (cada línea de `metrics.jsonl`). Es la colección
analítica: mide latencias, aciertos y la calificación del usuario. Índice en
`timestamp` descendente.

| Campo                    | Tipo              | Descripción                                    |
| ------------------------ | ----------------- | ---------------------------------------------- |
| `_id`                    | string            | Id de la muestra                               |
| `timestamp`              | string ISO        | Cuándo se midió                                |
| `action` / `label`       | string            | Acción realizada y su nombre legible           |
| `origin`                 | string            | `ui` / `voice`                                 |
| `sttMs`                  | número            | ms de reconocimiento de voz                    |
| `interpretMs`            | número            | ms de interpretar la intención                 |
| `executeMs`              | número            | ms de ejecutar la acción                       |
| `ttsMs`                  | número            | ms de sintetizar voz                           |
| `totalMs`                | número            | ms totales de la interacción                   |
| `confidence`             | número            | Confianza de la interpretación (0–1)           |
| `success`                | bool              | Si la tarea salió bien                         |
| `confirmationRequested`  | bool              | Si se pidió confirmación                       |
| `confirmationAccepted`   | bool              | Si el usuario la aceptó                        |
| `usabilityVote`          | número (opcional) | Voto manual de usabilidad                      |
| `utterance`              | string            | Lo que dijo o escribió el usuario              |
| `error`                  | string (opcional) | Error si hubo                                  |

Con estos campos se calculan los indicadores de `metrics_summary`: tasa de
éxito, precisión de interpretación, percentiles de latencia (p50/p95) e índice
de usabilidad.

### 6.4 `conversations` — sesiones de chat

Un documento por sesión de conversación (espejo del historial en `localStorage`,
clave `aster.conversation.history`). Los mensajes van anidados como array.
Índice en `endedAt` descendente.

| Campo                   | Tipo        | Descripción                          |
| ----------------------- | ----------- | ------------------------------------ |
| `_id`                   | string      | Id de la sesión                      |
| `startedAt`             | string ISO  | Inicio de la sesión                  |
| `endedAt`               | string ISO  | Fin (se usa para ordenar)            |
| `turns`                 | número      | Número de turnos                     |
| `preview`               | string      | Resumen corto para la lista          |
| `messages[].id`         | string      | Id del mensaje                       |
| `messages[].role`       | string      | `user` / `assistant`                 |
| `messages[].content`    | string      | Texto del mensaje                    |
| `messages[].timestamp`  | string ISO  | Hora del mensaje                     |

### 6.5 Índices

`db_sync` crea estos índices de forma best-effort:

- `audits.timestamp` (descendente)
- `metrics.timestamp` (descendente)
- `conversations.endedAt` (descendente)

---

## 7. Roadmap

- [x] Arquitectura Tauri 2 + React + Tailwind
- [x] Catálogo cerrado de acciones con validación en el backend
- [x] Módulo de voz (STT/TTS)
- [x] Acciones de escritura con confirmación y revalidación
- [x] Lista blanca de aplicaciones y confinement de rutas
- [x] Auditoría e indicadores de evaluación
- [x] Visión multimodal (captura + análisis)
- [x] Generación de imágenes por orden de voz
- [x] Empaquetado e instalador
- [ ] Pruebas de usabilidad con usuarios reales
