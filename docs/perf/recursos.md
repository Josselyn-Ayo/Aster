# E6 - Arranque y consumo de recursos

Generado: 2026-11-08T13:28:40.6131624-05:00

## Entorno

| Dato | Valor |
| --- | --- |
| Sistema | Microsoft Windows 11 Pro 10.0.26200 |
| CPU | 11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz (4 nucleos / 8 hilos) |
| RAM | 15.75 GB |
| Node / npm | v24.14.1 / 11.5.2 |
| Rust | rustc 1.98.0 (88d9e12ae 2026-08-18) |

## Artefactos

| Tipo | Ruta | Tamano |
| --- | --- | ---: |
| Ejecutable release | src-tauri\target\release\aster-desktop-assistant.exe | 13.54 MB |
| Ejecutable debug | src-tauri\target\debug\aster-desktop-assistant.exe | 35.73 MB |

Frontend compilado (dist/): **838.2 KB** en 4 archivos.

| Archivo | Tamano |
| --- | ---: |
| dist\assets\index-hsaV-MUY.js | 801.3 KB |
| dist\assets\index-BoQT653X.css | 21.9 KB |
| dist\assets\window-Bn9gJKIB.js | 14.3 KB |
| dist\index.html | 783 B |

## Arranque

Tiempo desde Start-Process hasta que MainWindowHandle deja de ser 0.
La corrida 1 es **fria** (primer proceso de la tanda); las siguientes son **calientes**.

| Corrida | Tipo | Ventana (ms) | RAM total | RAM privada | Procesos | WebView2 | CPU reposo |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | frio | 1190.5 | 398.38 MB | 177.90 MB | 8 | 7 | 4.98 % |

| Estadistica | Ventana (ms) | RAM (MB) |
| --- | ---: | ---: |
| n | 1 | 1 |
| Media | 1190.5 | 398.4 |
| Mediana | 1190.5 | 398.4 |
| p95 | 1190.5 | 398.4 |
| Minimo | 1190.5 | 398.4 |
| Maximo | 1190.5 | 398.4 |

La RAM incluye el proceso principal y todos sus descendientes (motor de WebView2).

## Limitaciones

- La primera corrida no vacia la cache de archivos del sistema: es un arranque en frio de **proceso**, no tras reiniciar Windows.
- MainWindowHandle indica que la ventana ya existe; no garantiza que React haya pintado el primer cuadro.
- El consumo en reposo varia con la pagina visible, el motor de voz y la sincronizacion de OneDrive.
- Los procesos de WebView2 se atribuyen por arbol de descendencia; otras apps con WebView2 no se cuentan.
