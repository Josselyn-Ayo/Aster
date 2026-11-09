# Migración a Mongo Atlas (modo híbrido)

ASTER ya no depende solo del disco: cada escritura va primero a local
(`profile.json`, `audit.jsonl`, `metrics.jsonl`, `localStorage`) y luego se
espeja a Atlas. Si Atlas no responde, la app sigue en local.

## 1. Crear el cluster (si aún no lo tienes)

1. https://cloud.mongodb.com → Create → **M0 Free**.
2. Database Access → Add user `aster-app` (Read and write to any database).
3. Network Access → Add IP: tu IP (o `0.0.0.0/0` solo para probar).
4. Connect → Drivers → **Rust** → copia la URI:
   `mongodb+srv://aster-app:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`

## 2. Configurar ASTER

Opción A (recomendada, sin recompilar): abre la app → Ajustes → Datos →
pega la URI y pulsa **Guardar y migrar**. Se guarda en
`%APPDATA%\com.aster.assistant\db_config.json` (solo local, no se sube a git).

Opción B (dev): crea `.env` desde `.env.example` y pon `MONGODB_URI` y
`MONGODB_DB=aster`. La variable de entorno tiene prioridad sobre el archivo.

## 3. Migrar los datos existentes

Desde la consola de la app (o tu script) llama en orden:

```ts
import { dbConfigure, dbSync, dbSyncConversations } from "./services/aster/db";
import { loadHistory } from "./services/history/store";

await dbConfigure({ uri: "mongodb+srv://...", dbName: "aster", enabled: true });
const r = await dbSync(); // profile + audits + metrics
console.log(r); // { audits, metrics, pushedAudits, pushedMetrics, db }
await dbSyncConversations(loadHistory()); // conversaciones del localStorage
```

`db_sync` es idempotente (`_id` = id existente): puedes repetirlo sin duplicar.

## 4. Colecciones

| Colección       | `_id`       | Contenido                          |
|----------------|-------------|------------------------------------|
| `profiles`      | `"profile"` | `UserProfile`                      |
| `audits`        | audit id    | `AuditEntry` + `_id`               |
| `metrics`       | metric id   | `MetricRecord` + `_id`             |
| `conversations` | session id  | `ConversationSession` + `_id`      |

> Descripción detallada de campos por colección en el
> [README, sección 6](../README.md#6-persistencia-híbrida-mongodb-atlas).

Índices sugeridos (los crea `db_sync`): `audits.timestamp -1`,
`metrics.timestamp -1`, `conversations.endedAt -1`.

## 5. Verificar

- `db_status` → `{ connected: true, dbName: "aster", lastSource: "mongo" }`.
- En Atlas → Browse Collections: verás las 4 colecciones.
- Apaga el wifi y usa la app: todo sigue funcionando (origen `local`).

## 6. Seguridad

- Nunca commitees la URI (está en `.gitignore` vía `.env` y fuera del repo
  vía `db_config.json` en app-data).
- El usuario de Atlas debe ser de **mínimo privilegio** (solo lectura/escritura
  en `aster`, sin roles admin).
- La URI con contraseña solo vive en memoria y en `db_config.json` local.
- `db_status` nunca devuelve la URI completa.
