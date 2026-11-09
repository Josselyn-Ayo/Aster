# E5 · Auditoría de acciones (observacional)

Registros válidos: 42 (0 líneas ilegibles)

| Acción | n | Estados | p50 | p95 | máx | Confirmadas |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| find_files | 19 | success: 19 | 1451 ms | 16367 ms | 16367 ms | 0 |
| web_search | 10 | error: 6, success: 4 | 1148 ms | 5693 ms | 5693 ms | 0 |
| open_authorized_app | 5 | success: 5 | 2038 ms | 2872 ms | 2872 ms | 0 |
| create_folder | 2 | error: 1, cancelled: 1 | 32 ms | 9739 ms | 9739 ms | 0 |
| automation:open_url | 1 | error: 1 | 667 ms | 667 ms | 667 ms | 0 |
| cancelled_task | 1 | cancelled: 1 | 0 ms | 0 ms | 0 ms | 0 |
| conversation | 1 | error: 1 | 2 ms | 2 ms | 2 ms | 0 |
| create_file | 1 | success: 1 | 16299 ms | 16299 ms | 16299 ms | 1 |
| move_files | 1 | success: 1 | 7126 ms | 7126 ms | 7126 ms | 1 |
| system_info | 1 | success: 1 | 3532 ms | 3532 ms | 3532 ms | 0 |

> Los tiempos de auditoría incluyen el trabajo del backend nativo (por ejemplo,
> una búsqueda de archivos completa), por eso no son comparables con las
> etapas del frontend.
