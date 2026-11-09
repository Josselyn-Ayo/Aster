# E5 · Métricas reales de uso (observacional)

Generado: 2026-11-08T18:30:05.285Z
Origen: `C:\Users\dgcis\AppData\Roaming\com.aster.assistant`
Registros válidos: 58 (0 líneas ilegibles)

> Estas cifras provienen del uso normal de ASTER, no de un guion controlado.
> Las columnas «todas» incluyen interacciones fallidas; las de 429 agotan el
> tiempo de espera y elevan la media. La comparación principal usa «éxito».

## Totales por acción

| Acción | n | Éxito | % éxito | total p50 (todas) | total p95 (todas) | total p50 (éxito) | total p95 (éxito) | máx (éxito) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| find_files | 19 | 19 | 100 % | 1453 ms | 16384 ms | 1453 ms | 16384 ms | 16384 ms |
| web_search | 12 | 4 | 33.3 % | 1216 ms | 60459 ms | 3913 ms | 5706 ms | 5706 ms |
| conversation | 10 | 9 | 90 % | 722 ms | 1279 ms | 748 ms | 1279 ms | 1279 ms |
| open_authorized_app | 8 | 8 | 100 % | 2341 ms | 8319 ms | 2341 ms | 8319 ms | 8319 ms |
| create_folder | 2 | 0 | 0 % | 15 ms | 35 ms | — | — | — |
| system_info | 2 | 2 | 100 % | 1716 ms | 3556 ms | 1716 ms | 3556 ms | 3556 ms |
| automation:open_url | 1 | 0 | 0 % | 668 ms | 668 ms | — | — | — |
| automation:spotify | 1 | 1 | 100 % | 309 ms | 309 ms | 309 ms | 309 ms | 309 ms |
| cancelled_task | 1 | 0 | 0 % | 0 ms | 0 ms | — | — | — |
| create_file | 1 | 1 | 100 % | 21 ms | 21 ms | 21 ms | 21 ms | 21 ms |
| move_files | 1 | 1 | 100 % | 21 ms | 21 ms | 21 ms | 21 ms | 21 ms |

## Desglose por etapa (todas las interacciones)

| Acción | interpret p50 | interpret p95 | execute p50 | execute p95 | TTS p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| find_files | 45 ms | 965 ms | 1452 ms | 16368 ms | 1 ms |
| web_search | 94 ms | 60154 ms | 1216 ms | 60459 ms | 0 ms |
| conversation | 2 ms | 16 ms | 718 ms | 1279 ms | 1 ms |
| open_authorized_app | 72 ms | 8313 ms | 2339 ms | 8318 ms | 1 ms |
| create_folder | 0 ms | 13 ms | 15 ms | 33 ms | 0 ms |
| system_info | 28 ms | 2138 ms | 1688 ms | 3533 ms | 17 ms |
| automation:open_url | 660 ms | 660 ms | 668 ms | 668 ms | 0 ms |
| automation:spotify | 11 ms | 11 ms | 289 ms | 289 ms | 14 ms |
| cancelled_task | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms |
| create_file | 0 ms | 0 ms | 21 ms | 21 ms | 0 ms |
| move_files | 0 ms | 0 ms | 21 ms | 21 ms | 0 ms |

## Lectura

- `interpretMs` es el enrutado (vía rápida local o router LLM).
- `executeMs` es la ejecución: IPC nativo, búsqueda web o llamada de chat.
- `totalMs` = STT + interpretación + ejecución + TTS.
- El detalle por interacción está en `raw/metrics-anon.jsonl` (sin el texto dictado).
