/**
 * Adaptador de Google Gemini (SDK oficial `@google/genai`).
 *
 * Es el único proveedor que cubre las seis capacidades: conversación, visión,
 * transcripción, imágenes y búsqueda con Google Search. Se usa sobre todo para
 * lo que los proveedores OpenAI-compatibles no ofrecen.
 */
import {
  GoogleGenAI,
  createPartFromBase64,
  createPartFromText,
  type Content,
} from "@google/genai";
import type {
  AiProvider,
  ImageRequest,
  ImageResponse,
  ProviderContext,
  SearchRequest,
  SearchResponse,
  TextResponse,
  TranscribeRequest,
  VisionRequest,
  ChatRequest,
} from "../types";
import { AiProviderError } from "../types";

/** Cliente reutilizable: se recrea solo si cambia la clave. */
let cached: { apiKey: string; client: GoogleGenAI } | null = null;

function client(apiKey: string): GoogleGenAI {
  if (!cached || cached.apiKey !== apiKey) {
    cached = { apiKey, client: new GoogleGenAI({ apiKey }) };
  }
  return cached.client;
}

/** Código HTTP de un error del SDK (o 500 si no lo declara). */
function statusOf(error: unknown): number {
  const candidate = error as { status?: number; code?: number; statusCode?: number };
  const code = candidate?.status ?? candidate?.code ?? candidate?.statusCode;
  return typeof code === "number" ? code : 500;
}

function fail(error: unknown, fallback: string): never {
  const detail = error instanceof Error ? error.message : fallback;
  throw new AiProviderError("gemini", statusOf(error), detail);
}

/** Convierte el historial de la UI al formato `Content[]` del SDK. */
function toContents(request: ChatRequest): Content[] {
  return request.messages.map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: [createPartFromText(turn.content)],
  }));
}

async function chat(request: ChatRequest, ctx: ProviderContext): Promise<TextResponse> {
  const contents = toContents(request);
  if (contents.length === 0) contents.push({ role: "user", parts: [createPartFromText("Hola")] });

  try {
    const response = await client(ctx.apiKey).models.generateContent({
      model: ctx.model,
      contents,
      config: {
        ...(request.system ? { systemInstruction: request.system } : {}),
        maxOutputTokens: request.maxOutputTokens ?? 512,
        temperature: request.temperature ?? 0.7,
        ...(request.json ? { responseMimeType: "application/json" } : {}),
      },
    });
    return { text: response.text ?? "" };
  } catch (error) {
    fail(error, "Gemini no devolvió respuesta");
  }
}

async function vision(request: VisionRequest, ctx: ProviderContext): Promise<TextResponse> {
  try {
    const response = await client(ctx.apiKey).models.generateContent({
      model: ctx.model,
      contents: [
        {
          role: "user",
          parts: [
            createPartFromBase64(request.imageBase64, request.mimeType),
            createPartFromText(request.question),
          ],
        },
      ],
      config: { maxOutputTokens: request.maxOutputTokens ?? 512, temperature: 0.5 },
    });
    return { text: response.text ?? "" };
  } catch (error) {
    fail(error, "Gemini no pudo analizar la imagen");
  }
}

async function transcribe(
  request: TranscribeRequest,
  ctx: ProviderContext,
): Promise<TextResponse> {
  try {
    const response = await client(ctx.apiKey).models.generateContent({
      model: ctx.model,
      contents: [
        {
          role: "user",
          parts: [
            createPartFromBase64(request.audioBase64, request.mimeType),
            createPartFromText("Transcribe la voz de este audio devolviendo SOLO el texto."),
          ],
        },
      ],
      config: { maxOutputTokens: 128, temperature: 0 },
    });
    return { text: response.text?.trim() ?? "" };
  } catch (error) {
    fail(error, "Gemini no pudo transcribir el audio");
  }
}

/**
 * Generación de imágenes con los modelos `*-image` de Gemini.
 *
 * No se usa `generateImages`/Imagen: en la capa gratuita esos modelos no están
 * disponibles (responden 404) y los `gemini-*-image` sí, devolviendo la imagen
 * como una parte `inlineData` de `generateContent`.
 */
async function image(request: ImageRequest, ctx: ProviderContext): Promise<ImageResponse> {
  try {
    const response = await client(ctx.apiKey).models.generateContent({
      model: ctx.model,
      contents: [{ role: "user", parts: [createPartFromText(request.prompt)] }],
      config: { responseModalities: ["TEXT", "IMAGE"] },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((part) => part.inlineData?.data);
    const bytes = imagePart?.inlineData?.data;
    if (!bytes) {
      throw new Error(
        "El modelo no devolvió ninguna imagen. Puede que tu clave no tenga cuota de generación de imágenes.",
      );
    }

    return {
      text: `Imagen generada a partir de tu instrucción: "${request.prompt}"`,
      imageDataUrl: `data:${imagePart?.inlineData?.mimeType || "image/png"};base64,${bytes}`,
    };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    fail(error, "Gemini no pudo generar la imagen");
  }
}

async function search(request: SearchRequest, ctx: ProviderContext): Promise<SearchResponse> {
  try {
    const response = await client(ctx.apiKey).models.generateContent({
      model: ctx.model,
      contents: [
        {
          role: "user",
          parts: [
            createPartFromText(
              [
                `Responde a esta consulta usando información actual de Internet: "${request.query}".`,
                "Reglas de estilo:",
                "- Responde en el idioma de la consulta, de forma directa y concisa (máximo 5 frases).",
                "- Incluye las fechas o cifras concretas cuando sean relevantes.",
                "- No menciones que usaste una herramienta de búsqueda.",
              ].join("\n"),
            ),
          ],
        },
      ],
      config: { tools: [{ googleSearch: {} }], maxOutputTokens: 512, temperature: 0.3 },
    });

    const answer = response.text?.trim() ?? "";
    if (!answer) throw new Error("La búsqueda no devolvió resultados.");

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const seen = new Set<string>();
    const sources: SearchResponse["sources"] = [];
    for (const chunk of chunks) {
      const uri = chunk.web?.uri?.trim();
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      sources.push({ uri, title: chunk.web?.title?.trim() || uri });
      if (sources.length >= 6) break;
    }
    return { answer, sources };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    fail(error, "Gemini no pudo completar la búsqueda");
  }
}

async function listModels(ctx: ProviderContext): Promise<string[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(ctx.apiKey)}`,
  );
  if (!response.ok) {
    throw new AiProviderError("gemini", response.status, await response.text());
  }
  const data = (await response.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  return (data.models ?? [])
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .map((model) => (model.name ?? "").replace(/^models\//, ""))
    .filter(Boolean);
}

export const geminiProvider: AiProvider = {
  id: "gemini",
  label: "Google Gemini",
  requiresKey: true,
  supports: ["router", "chat", "vision", "transcribe", "image", "search"],
  chat,
  vision,
  transcribe,
  image,
  search,
  listModels,
};
