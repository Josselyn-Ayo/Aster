# E2 y E3 · Benchmarks nativos (criterion)

Generado: 2026-11-08T18:43:05.233Z

Perfil `perf` (hereda de release: `opt-level = 3`, sin LTO). Cada fila
resume la mediana de criterion con su intervalo de confianza del 95 %.

| Benchmark | Mediana | IC 95 % | Media | Rendimiento |
| --- | ---: | ---: | ---: | ---: |
| Acierto profundo · árbol 20k | 4.68 s | 4.54 s – 4.76 s | 4.71 s | 233.75 µs/entrada |
| Barrido completo · árbol 1k | 277.31 ms | 250.9 ms – 290.71 ms | 271.22 ms | 277.03 µs/entrada |
| Barrido completo · árbol 20k | 4.47 s | 4.43 s – 4.66 s | 4.62 s | 223.27 µs/entrada |
| Barrido completo · árbol 5k + node_modules (poda) | 1.13 s | 1.11 s – 1.18 s | 1.14 s | 160.71 µs/entrada |
| Solo carpetas · árbol 5k + poda | 65.97 ms | 62.62 ms – 69.34 ms | 66 ms | 9.42 µs/entrada |
| Parser Bing · página 500 KB | 109.96 µs | 105.09 µs – 115.38 µs | 110.89 µs | 4541.44 MB/s |
| Parser DuckDuckGo · página 500 KB | 76.13 µs | 72.13 µs – 84.02 µs | 81.22 µs | 6559.83 MB/s |
| HTML a texto · página 500 KB | 5.48 ms | 5.21 ms – 5.73 ms | 5.58 ms | 91.19 MB/s |

> El árbol de 20k tarda segundos porque `search_files` pide metadatos de
> cada entrada (`symlink_metadata`) antes de comparar el nombre. El informe
> de E2 explica el diagnóstico y su impacto.
