/**
 * Tests de la limpieza de texto para TTS: la voz no debe leer markdown,
 * URLs ni la sección de fuentes.
 */
import { describe, expect, it } from "vitest";
import { sanitizeForSpeech } from "./tts";

describe("sanitizeForSpeech", () => {
  it("quita bloques de código", () => {
    const out = sanitizeForSpeech("Mira ```const a = 1;``` listo");
    expect(out).not.toContain("const a");
    expect(out).toContain("código");
  });

  it("deja solo el título de los enlaces", () => {
    const out = sanitizeForSpeech("Ver [Guía](https://example.com/guia) ahora");
    expect(out).toContain("Guía");
    expect(out).not.toContain("https://");
  });

  it("corta la sección de fuentes", () => {
    const out = sanitizeForSpeech("Respuesta.\n\nFuentes: [A](https://a.com)");
    expect(out).toBe("Respuesta.");
  });

  it("elimina URLs sueltas y marcas", () => {
    const out = sanitizeForSpeech("Abre https://example.com **ya** `listo`");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
  });

  it("recorta respuestas muy largas", () => {
    const out = sanitizeForSpeech("palabra ".repeat(500));
    expect(out.length).toBeLessThanOrEqual(800);
  });
});
