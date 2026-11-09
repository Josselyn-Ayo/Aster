# Resultados de rendimiento (E1–E6)

Artefactos generados por la batería de pruebas descrita en
[`../PRUEBAS_RENDIMIENTO.md`](../PRUEBAS_RENDIMIENTO.md).

| Archivo | Prueba | Contenido |
| --- | --- | --- |
| `raw/frontend-bench.jsonl` | E1, E4 | Una línea por tarea medida con `tinybench` (mediana, p95, muestras). |
| `rust-bench.md` / `rust-bench.json` | E2, E3 | Medianas e intervalos de confianza de criterion. |
| `resumen-metricas.md` / `.csv` / `.json` | E5 | Estadísticas por acción de `metrics.jsonl`. |
| `resumen-auditoria.md` / `.csv` | E5 | Estados y latencias de `audit.jsonl`. |
| `raw/metrics-anon.jsonl` | E5 | Métricas sin el texto dictado por el usuario. |
| `raw/audit-anon.jsonl` | E5 | Auditoría sin rutas ni resúmenes. |
| `recursos.md` / `recursos.json` | E6 | Tamaños, arranque, RAM y CPU en reposo. |

## Cómo regenerar

```powershell
# E1 y E4: benchmarks de frontend (no forman parte de npm test)
npm run bench

# E2 y E3: benchmarks nativos (perfil perf, sin LTO)
npm run bench:rust
npm run perf:criterion

# E5: métricas reales de uso (observacional)
npm run perf:report

# E6: arranque y recursos del ejecutable de release
npm run perf:recursos
```

`npm run bench:rust` tarda varios minutos la primera vez porque compila
criterion y los árboles de prueba; las corridas siguientes son rápidas.
Los árboles sintéticos de E2 se crean en `%TEMP%` y se borran al terminar.

## Notas de interpretación

- E1, E3 y E4 son microbenchmarks deterministas: no usan red ni claves de IA.
- E2 depende del disco y del antivirus; el mismo código puede variar entre
  equipos. El informe explica el cuello de botella detectado.
- E5 es observacional: proviene del uso normal de la app, no de un guion.
  Las interacciones fallidas (cuota 429) se separan de las exitosas.
- E6 necesita un ejecutable de release. Si no existe, el script documenta los
  tamaños y explica por qué no midió el arranque.
