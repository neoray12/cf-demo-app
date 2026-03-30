import { createWorkersAI } from "workers-ai-provider";
import { createAiGateway } from "ai-gateway-provider";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { createAnthropic } from "ai-gateway-provider/providers/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, stepCountIs, APICallError } from "ai";
import { z } from "zod";
import type { Env } from "../types";
import type { ModelProvider } from "../../lib/types";

const TOOL_CAPABLE_WORKERS_AI = [
  /llama.*instruct/i,
  /llama.*function/i,
  /gpt-oss/i,
  /gemma.*instruct/i,
  /qwen.*instruct/i,
  /mistral.*instruct/i,
];

function modelSupportsTools(provider: ModelProvider, modelId: string): boolean {
  if (provider === "openai" || provider === "anthropic") return true;
  if (provider === "perplexity") return false;
  return TOOL_CAPABLE_WORKERS_AI.some((re) => re.test(modelId));
}

const SYSTEM_PROMPT = `你是一個由 Cloudflare AI 驅動的智慧助理。你可以回答一般性問題，並提供有關 Cloudflare 產品與功能的資訊。

回答時請使用繁體中文，除非使用者使用其他語言提問。回答要精確、有幫助。`;


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
  userIp: string | null;
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
    userIp: null,
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
    base.userIp = extractIpFromHtml(body);
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
    html.match(/Cloudflare Ray ID[:\s]*<[^>]+>([a-f0-9]{16,})<\/[^>]+>/i) ||
    html.match(/Cloudflare Ray ID[:\s]*([a-f0-9]{16,})/i) ||
    html.match(/Ray ID[:\s]*([a-f0-9]{16,})/i) ||
    html.match(/ray[_\-\s]*id[:\s]*([a-f0-9]{16,})/i);
  return m?.[1] ?? null;
}

function extractIpFromHtml(html: string): string | null {
  // <span class="hidden" id="cf-footer-ip">1.162.151.201</span>
  const m =
    html.match(/id=["']cf-footer-ip["'][^>]*>([\d.:a-fA-F]+)<\/span>/i) ||
    html.match(/Your IP[:\s]*([\d.:a-fA-F]+)/i);
  return m?.[1] ?? null;
}


function buildSearchKnowledgeTool(env: Env) {
  return {
    description: "搜尋知識庫中已爬取的網站內容。當使用者詢問與已爬取網站相關的問題時使用此工具。",
    inputSchema: z.object({
      query: z.string().describe("搜尋查詢，使用與使用者問題相同的語言"),
      maxResults: z.number().optional().default(5).describe("最大結果數量 (1-10)"),
    }),
    execute: async ({ query, maxResults }: { query: string; maxResults?: number }) => {
      try {
        console.log("[Chat API] searchKnowledge:", query);
        const numResults = Math.min(Math.max(maxResults ?? 5, 1), 10);
        const ragResult = await (env.AI as any).autorag(env.AUTORAG_NAME).search({
          query,
          max_num_results: numResults,
        });
        if (!ragResult?.data?.length) return { found: false, message: "未找到相關的知識庫內容。" };
        const filtered = ragResult.data
          .filter((item: { score: number }) => item.score >= 0.3)
          .map((item: { filename: string; score: number; content: Array<{ text: string }> }) => ({
            filename: item.filename,
            score: item.score,
            text: item.content?.map((c: { text: string }) => c.text).join("\n"),
          }));
        if (!filtered.length) return { found: false, message: "找到結果但相關性不足，請嘗試換個問法。" };
        return { found: true, count: filtered.length, results: filtered };
      } catch (err) {
        console.error("[Chat API] searchKnowledge error:", err);
        return { error: `知識庫搜尋失敗: ${(err as Error).message}` };
      }
    },
  };
}

type SimpleChatMessage = { role: string; content: string };

const STREAMING_HEADERS: Record<string, string> = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-cache",
  "Access-Control-Allow-Origin": "*",
};

function makeNdjsonStream(
  fn: (send: (data: Record<string, unknown>) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const send = (data: Record<string, unknown>) => {
    writer.write(encoder.encode(JSON.stringify(data) + "\n")).catch(() => { /* closed */ });
  };

  // Fire-and-forget: Workers runtime keeps the response alive while the writer is open
  (async () => {
    try {
      await fn(send);
    } catch (err) {
      try { send(parseStreamError(err) as unknown as Record<string, unknown>); } catch { /* closed */ }
    } finally {
      try { await writer.close(); } catch { /* closed */ }
    }
  })();

  return new Response(readable, { headers: STREAMING_HEADERS });
}

async function streamTextToNdjson(
  result: { fullStream: AsyncIterable<any> },
  send: (data: Record<string, unknown>) => void,
): Promise<void> {
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        send({ type: "text-delta", text: part.text });
        break;
      case "reasoning-delta":
        send({ type: "reasoning-delta", text: part.text });
        break;
      case "tool-input-start":
        send({ type: "tool-call-start", toolCallId: part.id, toolName: part.toolName });
        break;
      case "tool-call":
        send({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args: part.input });
        break;
      case "tool-result":
        send({ type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, result: part.output });
        break;
      case "error":
        send(parseStreamError(part.error) as unknown as Record<string, unknown>);
        break;
    }
  }
  send({ type: "finish" });
  send({ type: "done" });
}

// Workers AI: use binding + gateway option
async function handleWorkersAI(
  messages: SimpleChatMessage[],
  modelId: string,
  env: Env,
  toolsEnabled: boolean,
): Promise<Response> {
  const gatewayId = env.AI_GATEWAY_ID || "nkcf-gateway-01";
  const workersai = createWorkersAI({
    binding: env.AI,
    gateway: { id: gatewayId },
  });

  const useTools = toolsEnabled && modelSupportsTools("workers-ai", modelId);
  const chatMessages = sanitizeMessages(messages);

  return makeNdjsonStream(async (send) => {
    const result = streamText({
      model: workersai(modelId),
      system: SYSTEM_PROMPT,
      messages: chatMessages as any,
      maxOutputTokens: 4096,
      ...(useTools ? {
        tools: { searchKnowledge: buildSearchKnowledgeTool(env) },
        stopWhen: stepCountIs(5),
      } : {}),
    });
    await streamTextToNdjson(result, send);
  });
}

// External providers: use ai-gateway-provider (OpenAI, Anthropic, Perplexity)
async function handleExternalProvider(
  messages: SimpleChatMessage[],
  provider: "openai" | "anthropic" | "perplexity",
  modelId: string,
  env: Env,
  toolsEnabled: boolean,
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

  const useTools = toolsEnabled && modelSupportsTools(provider, modelId);
  const chatMessages = sanitizeMessages(messages);

  return makeNdjsonStream(async (send) => {
    const result = streamText({
      model: aiModel,
      system: SYSTEM_PROMPT,
      messages: chatMessages as any,
      maxOutputTokens: 4096,
      ...(useTools ? {
        tools: { searchKnowledge: buildSearchKnowledgeTool(env) },
        stopWhen: stepCountIs(5),
      } : {}),
    });
    await streamTextToNdjson(result, send);
  });
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
    messages: SimpleChatMessage[];
    model?: string;
    provider?: ModelProvider;
    toolsEnabled?: boolean;
  };

  const { messages, model, provider, toolsEnabled = false } = body;

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

  console.log("[Chat API] provider:", provider, "model:", modelId, "messages:", messages.length, "toolsEnabled:", toolsEnabled);

  try {
    if (provider === "openai" || provider === "anthropic" || provider === "perplexity") {
      return await handleExternalProvider(messages, provider, modelId, env, toolsEnabled);
    }
    // Default: Workers AI via binding + gateway
    return await handleWorkersAI(messages, modelId, env, toolsEnabled);
  } catch (err) {
    console.error("[Chat API] Error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message || "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
