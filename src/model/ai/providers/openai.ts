/**
 * Adaptador para cualquier proveedor con API compatible con OpenAI
 * (`/chat/completions`, `/audio/transcriptions`, `/models`).
 *
 * Cubre Groq, OpenRouter, Mistral y Ollama: solo cambia la `baseUrl` y la
 * clave. No usa SDK para no añadir dependencias al bundle.
 */
import type {
  AiProvider,
  ChatRequest,
  ProviderContext,
  ProviderId,
  TextResponse,
  TranscribeRequest,
  VisionRequest,
  Capability,
} from "../types";
import { AiProviderError } from "../types";

/** Cabeceras comunes de una petición autenticada. */
function headers(provider: ProviderId, ctx: ProviderContext): Record<string, string> {
  const result: Record<string, string> = { "Content-Type": "application/json" };
  if (ctx.apiKey) result.Authorization = `Bearer ${ctx.apiKey}`;
  if (provider === "openrouter") {
    result["X-Title"] = "ASTER";
    result["HTTP-Referer"] = "https://aster.local";
  }
  return result;
}

/** Convierte la respuesta de error en un `AiProviderError` con su status. */
async function toError(provider: ProviderId, response: Response): Promise<AiProviderError> {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = response.statusText;
  }
  return new AiProviderError(provider, response.status, detail || response.statusText);
}

/** Extrae el texto de una respuesta `choices[0].message.content`. */
function textOf(data: unknown): string {
  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  // Algunos proveedores devuelven un array de fragmentos.
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part as { text?: string })?.text ?? ""))
      .join("")
      .trim();
  }
  return "";
}

async function chat(
  provider: ProviderId,
  request: ChatRequest,
  ctx: ProviderContext,
): Promise<TextResponse> {
  const messages = [
    ...(request.system ? [{ role: "system", content: request.system }] : []),
    ...request.messages.map((turn) => ({ role: turn.role, content: turn.content })),
  ];

  const payload: Record<string, unknown> = {
    model: ctx.model,
    messages,
    max_tokens: request.maxOutputTokens ?? 512,
    temperature: request.temperature ?? 0.7,
    ...(request.json ? { response_format: { type: "json_object" } } : {}),
  };

  const send = (body: Record<string, unknown>) =>
    fetch(`${ctx.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(provider, ctx),
      body: JSON.stringify(body),
    });

  let response = await send(payload);

  // Algunos modelos (p. ej. los `gpt-oss` de Groq) rechazan `response_format`.
  // En ese caso se reintenta sin él: el prompt ya pide JSON y el parser tolera
  // bloques de código, así que no se pierde la llamada.
  if (response.status === 400 && request.json) {
    delete payload.response_format;
    response = await send(payload);
  }

  if (!response.ok) throw await toError(provider, response);
  return { text: textOf(await response.json()) };
}

async function vision(
  provider: ProviderId,
  request: VisionRequest,
  ctx: ProviderContext,
): Promise<TextResponse> {
  const response = await fetch(`${ctx.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(provider, ctx),
    body: JSON.stringify({
      model: ctx.model,
      max_tokens: request.maxOutputTokens ?? 512,
      temperature: 0.5,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: request.question },
            {
              type: "image_url",
              image_url: { url: `data:${request.mimeType};base64,${request.imageBase64}` },
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) throw await toError(provider, response);
  return { text: textOf(await response.json()) };
}

async function transcribe(
  provider: ProviderId,
  request: TranscribeRequest,
  ctx: ProviderContext,
): Promise<TextResponse> {
  const binary = atob(request.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const form = new FormData();
  form.append("model", ctx.model);
  form.append("file", new Blob([bytes], { type: request.mimeType }), "audio.webm");

  const response = await fetch(`${ctx.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
    body: form,
  });
  if (!response.ok) throw await toError(provider, response);
  const data = (await response.json()) as { text?: string };
  return { text: (data.text ?? "").trim() };
}

async function listModels(provider: ProviderId, ctx: ProviderContext): Promise<string[]> {
  const response = await fetch(`${ctx.baseUrl}/models`, {
    headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
  });
  if (!response.ok) throw await toError(provider, response);
  const data = (await response.json()) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ name?: string }>;
  };
  return [
    ...(data.data ?? []).map((model) => model.id ?? ""),
    ...(data.models ?? []).map((model) => model.name ?? ""),
  ].filter(Boolean);
}

/** Fábrica de adaptadores OpenAI-compatibles. */
export function createOpenAiProvider(
  provider: ProviderId,
  label: string,
  supports: Capability[],
  requiresKey = true,
): AiProvider {
  return {
    id: provider,
    label,
    requiresKey,
    supports,
    chat: (request, ctx) => chat(provider, request, ctx),
    ...(supports.includes("vision")
      ? { vision: (request: VisionRequest, ctx: ProviderContext) => vision(provider, request, ctx) }
      : {}),
    ...(supports.includes("transcribe")
      ? {
          transcribe: (request: TranscribeRequest, ctx: ProviderContext) =>
            transcribe(provider, request, ctx),
        }
      : {}),
    listModels: (ctx) => listModels(provider, ctx),
  };
}
