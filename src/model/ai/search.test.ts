import { describe, expect, it } from "vitest";
import { buildSearchContext } from "./search";
import type { WebSearchHit } from "../../services/web/search";

function hit(overrides: Partial<WebSearchHit> = {}): WebSearchHit {
  return {
    title: "Precio del dólar",
    url: "https://example.com/dolar",
    snippet: "Cotización de hoy",
    content: "El dólar cerró en 3,45 soles.",
    ...overrides,
  };
}

describe("buildSearchContext", () => {
  it("incluye título, enlace, resumen y contenido de cada resultado", () => {
    const context = buildSearchContext([hit()]);
    expect(context).toContain("[1] Precio del dólar");
    expect(context).toContain("https://example.com/dolar");
    expect(context).toContain("Resumen: Cotización de hoy");
    expect(context).toContain("Contenido: El dólar cerró en 3,45 soles.");
  });

  it("numera los resultados y colapsa los espacios", () => {
    const context = buildSearchContext([
      hit({ title: "Uno\n  con   espacios", snippet: "" }),
      hit({ title: "Dos", content: "" }),
    ]);
    expect(context).toContain("[1] Uno con espacios");
    expect(context).toContain("[2] Dos");
    expect(context).not.toContain("Resumen: \n");
  });

  it("respeta el presupuesto de contexto", () => {
    const long = Array.from({ length: 6 }, (_, index) =>
      hit({ title: `Resultado ${index}`, content: "x".repeat(5000) }),
    );
    const context = buildSearchContext(long);
    expect(context.length).toBeLessThanOrEqual(10000);
    expect(context).not.toContain("[6]");
  });

  it("devuelve cadena vacía sin resultados", () => {
    expect(buildSearchContext([])).toBe("");
  });
});
