# PATRÓN — Prompt para la imagen de arquitectura

Prompt listo para generar la figura de arquitectura de ASTER. La imagen debe dejar clarísimo, a primera vista:

1. **El MVC**: tres paneles grandes con las letras **V**, **C** y **M**.
2. **Las herramientas**: cada capa muestra sus tecnologías en chips legibles.

Está pensado para lectores de tesis: vistoso, con iconos 3D, pero entendible sin explicación previa.

---

## Prompt principal (copiar y pegar)

```text
Ilustración tecnológica 3D isométrica suave, moderna y llamativa, para la figura de una tesis. Fondo ciruela oscuro (#140d16) con rejilla isométrica sutil y resplandor magenta y dorado muy tenue. Tarjetas de vidrio (glassmorphism) flotando, bordes luminosos, sombras suaves e iconos 3D coloridos. Estilo premium tipo Stripe / Apple, no caricaturesco, no minimalista. Composición limpia: solo los elementos indicados, mucho aire entre ellos y todo el texto legible.

Lo que MÁS debe notarse: el MVC y las herramientas. Detrás de los tres paneles MVC, un gran letrero luminoso semitransparente con las letras «MVC».

TÍTULO arriba, grande y luminoso: «Arquitectura MVC de ASTER»
Subtítulo pequeño: «MVC adaptado a React + Tauri 2»

En la parte superior, una tarjeta pequeña:
«USUARIO», subtítulo «voz o texto». Icono 3D: persona con micrófono y teclado.

Debajo, TRES PANELES GRANDES de vidrio apilados de arriba abajo. Cada panel ocupa todo el ancho y tiene una letra gigante a la izquierda. Entre panel y panel, flechas luminosas gruesas que bajan.

PANEL 1 (color magenta #d63384):
Letra gigante «V». Título «VISTA». Subtítulo «interfaz y voz». Icono 3D: ventana de chat con onda de audio.
Chips de herramientas dentro del panel: «React · TypeScript · Tailwind · Vite · WebView2».

PANEL 2 (color dorado #f0b429):
Letra gigante «C». Título «CONTROLADOR». Subtítulo «AsterController: interpreta, ejecuta, habla y mide». Icono 3D: cerebro con engranajes y flechas de coordinación.
Chips de herramientas dentro del panel: «useAster · useSpeech · useAiConfig».

PANEL 3 (color rosa #f061a8):
Letra gigante «M». Título «MODELO». Subtítulo «dominio e inteligencia artificial». Icono 3D: chip cerebral brillante con destellos.
Chips de herramientas dentro del panel: «runAi · fastRoute · providers · Groq · Gemini · OpenRouter · Mistral · Ollama».

Debajo de los tres paneles, una banda más delgada:
«SERVICIOS E INFRAESTRUCTURA». Icono 3D: engranaje con monitor.
Chips: «Tauri IPC · Rust · Windows · archivos · pantalla · búsqueda web · auditoría».

A la derecha, dos tarjetas flotantes unidas con líneas punteadas luminosas:
«SEGURIDAD», subtítulo «permisos y carpetas autorizadas». Icono: escudo con candado.
«REGISTRO», subtítulo «historial y auditoría». Icono: portapapeles con reloj.

A la izquierda, una flecha de retorno curva y más fina desde la banda de SERVICIOS hasta el panel VISTA, rotulada «respuesta en voz y texto».

Números en círculos del color de cada capa, de arriba abajo: 1 USUARIO, 2 VISTA, 3 CONTROLADOR, 4 MODELO, 5 SERVICIOS.

Leyenda abajo: V = magenta #d63384, C = dorado #f0b429, M = rosa #f061a8, infraestructura = lila #b08fae.

Escribe los textos EXACTAMENTE como se indican, con tipografía sans-serif grande y nítida. Sin párrafos, sin código, sin logotipos de marcas, sin iconos extra, sin texto inventado, sin personas realistas, sin 3D tosco, sin desorden.
```

---

## Versión sin texto (para montar los rótulos aparte)

Si el generador deforma las palabras, pide la imagen limpia y escribe encima en Figma, PowerPoint o Canva:

```text
La misma ilustración isométrica de vidrio, pero SIN ningún texto ni números: solo la tarjeta del usuario, los tres paneles grandes MVC con sus iconos 3D y chips vacíos, la banda de servicios, las dos tarjetas laterales y las flechas. Deja espacios libres para los rótulos. Mismo fondo, colores y estilo.
```

---

## Qué debe quedar claro en la figura

| Elemento | Qué representa | Herramientas que muestra |
|---|---|---|
| **V — Vista** | Lo que el usuario ve y usa | React, TypeScript, Tailwind, Vite, WebView2 |
| **C — Controlador** | El coordinador que interpreta y ordena | AsterController, useAster, useSpeech, useAiConfig |
| **M — Modelo** | Las reglas y la inteligencia artificial | runAi, fastRoute, providers, Groq, Gemini, OpenRouter, Mistral, Ollama |
| **Servicios e infraestructura** | Lo que ejecuta las acciones en el equipo | Tauri IPC, Rust, Windows, archivos, pantalla, búsqueda web, auditoría |
| **Seguridad** | Solo permite lo autorizado | Permisos y carpetas autorizadas |
| **Registro** | Deja constancia de lo ocurrido | Historial y auditoría |

**Flechas:** bajan en orden 1→5 (la orden del usuario); la de retorno representa la respuesta en voz y texto. Seguridad y registro son transversales: acompañan todo el flujo.

---

## Paleta e iconos

- Fondo: `#140d16` · Tarjetas: `#1f1222` · Bordes: `#5e3567` · Texto: `#f8eef5`
- V: `#d63384` · C: `#f0b429` · M: `#f061a8` · Infraestructura: `#b08fae`
- Iconos 3D: micrófono, ventana de chat, cerebro con engranajes, chip cerebral, carpeta, monitor, globo terráqueo, escudo, portapapeles.
- Sin logotipos de marcas: los nombres de las herramientas van en chips de texto.

## Pie de figura sugerido

> **Figura N.** Arquitectura MVC de ASTER. La vista capta la orden del usuario, el controlador la interpreta y la capa del modelo decide la acción mediante IA; los servicios de infraestructura la ejecutan sobre Windows. Seguridad y registro actúan de forma transversal.

---

## Herramientas recomendadas para generarla

- **Con texto bien escrito:** Ideogram, Recraft o GPT Image.
- **Con mucho estilo:** Midjourney o Flux (mejor generar sin texto y rotular aparte).
- **Figura 100 % fiel para la tesis:** diagrama vectorial en Figma, Excalidraw o draw.io con los mismos textos e iconos.
