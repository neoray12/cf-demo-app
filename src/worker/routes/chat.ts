import { createWorkersAI } from "workers-ai-provider";
import { createAiGateway } from "ai-gateway-provider";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { createAnthropic } from "ai-gateway-provider/providers/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, convertToModelMessages, APICallError, type UIMessage } from "ai";
import type { Env } from "../types";
import type { ModelProvider } from "../../lib/types";

const SYSTEM_PROMPT = `你是一個由 Cloudflare AI 驅動的智慧助理。你可以回答一般性問題，並提供有關 Cloudflare 產品與功能的資訊。

回答時請使用繁體中文，除非使用者使用其他語言提問。回答要精確、有幫助。`;

const STREAMING_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Transfer-Encoding": "chunked",
  "Cache-Control": "no-cache",
};

// Ensure messages strictly alternate user/assistant roles.
// Merges consecutive messages of the same role to prevent provider errors.
function sanitizeMessages(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.content = last.content + "\n" + msg.content;
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  return result;
}

interface StreamErrorEvent {
  type: "error";
  errorType: "firewall" | "gateway" | "dlp" | "general";
  message: string;
  rayId: string | null;
  gatewayLogId: string | null;
  statusCode: number | null;
  gatewayCode: string | null;
}

function parseStreamError(err: unknown): StreamErrorEvent {
  const base: StreamErrorEvent = {
    type: "error",
    errorType: "general",
    message: (err as Error).message || "Stream error",
    rayId: null,
    gatewayLogId: null,
    statusCode: null,
    gatewayCode: null,
  };

  // Duck-type check: ai-gateway-provider may use a different AICallError class
  // that doesn't pass APICallError.isInstance() from the main 'ai' package.
  const apiErr = err as Record<string, unknown>;
  const hasApiCallShape =
    APICallError.isInstance(err) ||
    (typeof apiErr.statusCode === "number" && "responseBody" in apiErr);
  if (!hasApiCallShape) return base;

  const statusCode = (apiErr.statusCode as number) ?? null;
  const rawBody = typeof apiErr.responseBody === "string" ? apiErr.responseBody : "";
  const headers = (apiErr.responseHeaders as Record<string, string> | undefined) ?? {};
  const msg = base.message; // original err.message
  // Use responseBody if available, otherwise fall back to the message string
  const body = rawBody || msg;
  const rayId = headers["cf-ray"] || extractRayIdFromHtml(body);
  const gatewayLogId = headers["cf-aig-log-id"] || null;

  base.statusCode = statusCode;
  base.rayId = rayId;
  base.gatewayLogId = gatewayLogId;

  // AI Gateway error codes
  // 2016 = Firewall for AI / security block (prompt injection, security policy)
  // 2029 = DLP policy violation
  // others = generic gateway block
  const FIREWALL_CODES = new Set([2016]);
  const DLP_CODES = new Set([2029]);

  // Try to extract a human-readable message from embedded JSON in the error body
  function extractGatewayJson(text: string): {
    message?: string;
    code?: string;
    isGatewayFormat: boolean;
  } | null {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd <= jsonStart) return null;
    try {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
        success?: boolean;
        error?: Array<{ code?: number | string; message?: string }>;
        message?: string;
      };
      // AI Gateway error format: { success: false, error: [{code, message}] }
      const isGatewayFormat =
        parsed.success === false && Array.isArray(parsed.error);
      const first = Array.isArray(parsed.error) ? parsed.error[0] : undefined;
      if (first?.message) {
        return {
          message: first.message,
          code: first.code ? String(first.code) : undefined,
          isGatewayFormat,
        };
      }
      if (parsed.message) return { message: parsed.message, isGatewayFormat };
    } catch { /* ignore */ }
    return null;
  }

  // Firewall for AI: 403 with HTML Cloudflare block page
  if (
    statusCode === 403 &&
    (body.includes("Cloudflare Ray ID") ||
      body.includes("Sorry, you have been blocked") ||
      body.includes("Firewall for AI") ||
      body.includes("security service"))
  ) {
    base.errorType = "firewall";
    base.message = "您的請求被 Cloudflare Firewall for AI 安全防護攔截";
    base.rayId = extractRayIdFromHtml(body) || rayId;
    return base;
  }

  // Universal AI Gateway JSON format detection (works for Workers AI binding too)
  const extracted = extractGatewayJson(body);
  if (extracted) {
    const codeNum = extracted.code ? Number(extracted.code) : NaN;
    if (extracted.isGatewayFormat || !isNaN(codeNum)) {
      if (!isNaN(codeNum) && FIREWALL_CODES.has(codeNum)) {
        base.errorType = "firewall";
        base.message = extracted.message || "您的請求被 Cloudflare AI Gateway 安全防護攔截";
      } else if (!isNaN(codeNum) && DLP_CODES.has(codeNum)) {
        base.errorType = "dlp";
        base.message = extracted.message || "您的請求內容被 AI Gateway DLP 政策攔截";
      } else if (extracted.isGatewayFormat) {
        base.errorType = "gateway";
        base.message = extracted.message || "請求被 AI Gateway 攔截";
      } else {
        base.message = extracted.message || base.message;
      }
      if (extracted.code) base.gatewayCode = extracted.code;
    } else {
      base.message = extracted.message || base.message;
    }
  }

  return base;
}

function extractRayIdFromHtml(html: string): string | null {
  const m =
    html.match(/Cloudflare Ray ID[:\s]*([a-f0-9]{16,})/i) ||
    html.match(/Ray ID[:\s]*([a-f0-9]{16,})/i) ||
    html.match(/ray[_\-\s]*id[:\s]*([a-f0-9]{16,})/i);
  return m?.[1] ?? null;
}

// Convert AI SDK fullStream to NDJSON events for frontend
function streamToNdjson(result: ReturnType<typeof streamText>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const part of result.fullStream) {
          let event: Record<string, unknown> | null = null;
          switch (part.type) {
            case "text-delta":
              event = { type: "text-delta", text: part.text };
              break;
            case "reasoning-delta":
              event = { type: "reasoning-delta", text: part.text };
              break;
            case "error":
              event = { type: "error", message: String(part.error) };
              break;
            case "finish":
              event = { type: "finish" };
              break;
          }
          if (event) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        }
      } catch (err) {
        controller.enqueue(encoder.encode(JSON.stringify(parseStreamError(err)) + "\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: STREAMING_HEADERS });
}

// Workers AI: use binding + gateway option (same pattern as agent.ts)
async function handleWorkersAI(
  messages: Array<{ role: string; content: string }>,
  modelId: string,
  env: Env,
): Promise<Response> {
  const gatewayId = env.AI_GATEWAY_ID || "nkcf-gateway-01";
  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: gatewayId },
  });

  const uiMessages: UIMessage[] = sanitizeMessages(messages).map((m, i) => ({
    id: `msg-${i}`,
    role: m.role as "user" | "assistant",
    content: m.content,
    parts: [{ type: "text" as const, text: m.content }],
  }));

  const chatMessages = await convertToModelMessages(uiMessages);

  const result = streamText({
    model: workersai(modelId),
    system: SYSTEM_PROMPT,
    messages: chatMessages,
    maxOutputTokens: 4096,
  });

  return streamToNdjson(result);
}

// External providers: use ai-gateway-provider (OpenAI, Anthropic, Perplexity)
async function handleExternalProvider(
  messages: Array<{ role: string; content: string }>,
  provider: "openai" | "anthropic" | "perplexity",
  modelId: string,
  env: Env,
): Promise<Response> {
  const aigateway = createAiGateway({
    accountId: env.CF_ACCOUNT_ID || "5efa272dc28e4e3933324c44165b6dbe",
    gateway: env.AI_GATEWAY_ID || "nkcf-gateway-01",
    apiKey: env.CF_AIG_TOKEN,
  });

  let aiModel;
  switch (provider) {
    case "openai": {
      const openai = createOpenAI();
      aiModel = aigateway(openai.chat(modelId));
      break;
    }
    case "anthropic": {
      const anthropic = createAnthropic();
      aiModel = aigateway(anthropic(modelId));
      break;
    }
    case "perplexity": {
      // Perplexity is OpenAI-compatible; baseURL matches "perplexity-ai" provider regex
      const perplexity = createOpenAICompatible({
        baseURL: "https://api.perplexity.ai/",
        name: "Perplexity",
        apiKey: "CF_TEMP_TOKEN",
      });
      aiModel = aigateway(perplexity.chatModel(modelId));
      break;
    }
  }

  const chatMessages = sanitizeMessages(messages).map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  const result = streamText({
    model: aiModel,
    system: SYSTEM_PROMPT,
    messages: chatMessages,
    maxOutputTokens: 4096,
  });

  return streamToNdjson(result);
}

export async function handleChat(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await request.json() as {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    provider?: ModelProvider;
  };

  const { messages, model, provider } = body;

  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: "messages is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const defaultModels: Record<string, string> = {
    openai: "gpt-3.5-turbo",
    anthropic: "claude-sonnet-4-20250514",
    perplexity: "sonar",
    "workers-ai": "@cf/openai/gpt-oss-120b",
  };
  const modelId = model || defaultModels[provider || "workers-ai"] || "@cf/openai/gpt-oss-120b";

  console.log("[Chat API] provider:", provider, "model:", modelId, "messages:", messages.length);

  try {
    if (provider === "openai" || provider === "anthropic" || provider === "perplexity") {
      return await handleExternalProvider(messages, provider, modelId, env);
    }
    // Default: Workers AI via binding + gateway
    return await handleWorkersAI(messages, modelId, env);
  } catch (err) {
    console.error("[Chat API] Error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message || "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
