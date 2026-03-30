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

  // Helper: parse AI Gateway JSON error format from any text
  // Must be defined before any early-return paths so Workers AI binding errors
  // (InferenceUpstreamError whose .message IS the JSON) can be classified correctly.
  function extractGatewayJsonEarly(text: string): {
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

  const FIREWALL_CODES = new Set([2016]);
  const DLP_CODES = new Set([2029]);

  // Workers AI InferenceUpstreamError: "error code: 1031" etc.
  const errMsg = base.message;
  const workersAiCodeMatch = errMsg.match(/error code:\s*(\d+)/i);
  if (workersAiCodeMatch) {
    const code = workersAiCodeMatch[1]!;
    const WORKERS_AI_ERRORS: Record<string, string> = {
      "1031": "Workers AI 模型推論失敗（上游錯誤），請稍後再試或換一個模型",
      "1004": "Workers AI 模型不存在或已停用",
      "1042": "Workers AI 請求逾時，請縮短輸入或稍後再試",
      "3002": "Workers AI 輸入格式錯誤",
    };
    base.message = WORKERS_AI_ERRORS[code] || `Workers AI 錯誤（代碼 ${code}），請稍後再試或換一個模型`;
    base.errorType = "general";
    return base;
  }

  // Workers AI binding errors (InferenceUpstreamError) are not APICallError instances
  // but their .message may be a raw Gateway JSON string — classify them before the
  // hasApiCallShape check so they don't fall through as "general".
  const earlyExtracted = extractGatewayJsonEarly(errMsg);
  if (earlyExtracted) {
    const codeNum = earlyExtracted.code ? Number(earlyExtracted.code) : NaN;
    if (earlyExtracted.isGatewayFormat || !isNaN(codeNum)) {
      if (!isNaN(codeNum) && FIREWALL_CODES.has(codeNum)) {
        base.errorType = "gateway";
        base.message = earlyExtracted.message || "您的請求被 Cloudflare AI Gateway Firewall for AI 攔截";
      } else if (!isNaN(codeNum) && DLP_CODES.has(codeNum)) {
        base.errorType = "dlp";
        base.message = earlyExtracted.message || "您的請求內容被 AI Gateway DLP 政策攔截";
      } else if (earlyExtracted.isGatewayFormat) {
        base.errorType = "gateway";
        base.message = earlyExtracted.message || "請求被 AI Gateway 攔截";
      } else {
        base.message = earlyExtracted.message || base.message;
      }
      if (earlyExtracted.code) base.gatewayCode = earlyExtracted.code;
      return base;
    }
  }

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
  const extracted = extractGatewayJsonEarly(body);
  if (extracted) {
    const codeNum = extracted.code ? Number(extracted.code) : NaN;
    if (extracted.isGatewayFormat || !isNaN(codeNum)) {
      if (!isNaN(codeNum) && FIREWALL_CODES.has(codeNum)) {
        base.errorType = "gateway";
        base.message = extracted.message || "您的請求被 Cloudflare AI Gateway Firewall for AI 攔截";
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
        const searchPromise = (env.AI as any).autorag(env.AUTORAG_NAME).search({
          query,
          max_num_results: numResults,
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("AutoRAG 搜尋逾時（15s）")), 15000)
        );
        const ragResult = await Promise.race([searchPromise, timeoutPromise]);
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

type NdjsonSender = (data: Record<string, unknown>) => void;

function makeNdjsonStream(
  fn: (send: NdjsonSender) => Promise<void>,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send: NdjsonSender = (data) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(data) + "\n")); } catch { /* closed */ }
      };
      try {
        await fn(send);
      } catch (err) {
        try { send(parseStreamError(err) as unknown as Record<string, unknown>); } catch { /* closed */ }
      } finally {
        try { controller.close(); } catch { /* closed */ }
      }
    },
  });

  return new Response(stream, { headers: STREAMING_HEADERS });
}

// Only parse <think> tags for reasoning models that embed reasoning in text
function needsThinkParsing(modelId: string): boolean {
  return /deepseek/i.test(modelId) || /qwq/i.test(modelId);
}

function isReasoningModel(modelId: string): boolean {
  return needsThinkParsing(modelId);
}

interface ToolResultEntry {
  toolName: string;
  result: unknown;
}

interface StreamState {
  insideThink: boolean;
  thinkBuffer: string;
}

// Process text-delta: split on <think>/<​/think> boundaries when needed
function processTextDelta(
  send: NdjsonSender,
  raw: string,
  state: StreamState,
  parseThink: boolean,
): void {
  if (!parseThink) {
    send({ type: "text-delta", text: raw });
    return;
  }

  let text = state.thinkBuffer + raw;
  state.thinkBuffer = "";

  // Buffer potential partial tags at the end (e.g. "<", "<t", "<th", "</thi", etc.)
  const partial = text.match(/<\/?(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/);
  if (partial) {
    state.thinkBuffer = partial[0];
    text = text.slice(0, -state.thinkBuffer.length);
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (state.insideThink) {
      const closeIdx = remaining.indexOf("</think>");
      if (closeIdx !== -1) {
        const reasoningText = remaining.slice(0, closeIdx);
        if (reasoningText) send({ type: "reasoning-delta", text: reasoningText });
        state.insideThink = false;
        remaining = remaining.slice(closeIdx + "</think>".length);
      } else {
        if (remaining) send({ type: "reasoning-delta", text: remaining });
        remaining = "";
      }
    } else {
      const openIdx = remaining.indexOf("<think>");
      if (openIdx !== -1) {
        const normalText = remaining.slice(0, openIdx);
        if (normalText) send({ type: "text-delta", text: normalText });
        state.insideThink = true;
        remaining = remaining.slice(openIdx + "<think>".length);
      } else {
        if (remaining) send({ type: "text-delta", text: remaining });
        remaining = "";
      }
    }
  }
}

// Process a single stream attempt; returns flags and collected tool results
async function processStream(
  result: { fullStream: AsyncIterable<any> },
  send: NdjsonSender,
  state: StreamState,
  parseThink: boolean,
  attempt: number,
): Promise<{ hasTextContent: boolean; hasToolCalls: boolean; hasError: boolean; toolResults: ToolResultEntry[] }> {
  let hasTextContent = false;
  let hasToolCalls = false;
  let hasError = false;
  const toolResults: ToolResultEntry[] = [];

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        hasTextContent = true;
        processTextDelta(send, part.text, state, parseThink);
        break;
      case "reasoning-delta":
        hasTextContent = true;
        send({ type: "reasoning-delta", text: part.text });
        break;
      case "tool-input-start":
        hasToolCalls = true;
        send({ type: "tool-call-start", toolCallId: part.id, toolName: part.toolName });
        break;
      case "tool-call":
        send({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args: part.input });
        break;
      case "tool-result":
        send({ type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, result: part.output });
        toolResults.push({ toolName: part.toolName, result: part.output });
        break;
      case "finish":
        // Flush any remaining thinkBuffer
        if (state.thinkBuffer) {
          const eventType = state.insideThink ? "reasoning-delta" : "text-delta";
          send({ type: eventType, text: state.thinkBuffer });
          state.thinkBuffer = "";
        }
        if (part.finishReason === "length") {
          send({ type: "text-delta", text: "\n\n⚠️ *回覆因長度限制被截斷，請嘗試縮小問題範圍。*" });
        }
        console.log(`[Chat API] Stream finished (attempt ${attempt}): ${part.finishReason}, text=${hasTextContent}, tools=${hasToolCalls}`);
        break;
      case "error":
        console.error(`[Chat API] Stream error (attempt ${attempt}):`, part.error);
        send(parseStreamError(part.error) as unknown as Record<string, unknown>);
        hasError = true;
        break;
      // Known informational events — ignore silently
      case "start":
      case "start-step":
      case "finish-step":
      case "text-start":
      case "text-end":
      case "tool-input-delta":
      case "tool-input-end":
        break;
      default:
        console.log(`[Chat API] Unhandled stream event: ${(part as { type: string }).type}`);
        break;
    }
  }
  return { hasTextContent, hasToolCalls, hasError, toolResults };
}

// Smart retry: inject tool results as context and call model WITHOUT tools
async function processSmartRetry(
  send: NdjsonSender,
  state: StreamState,
  parseThink: boolean,
  toolResults: ToolResultEntry[],
  messages: SimpleChatMessage[],
  createModel: () => any,
  maxTokens: number,
): Promise<boolean> {
  const resultsSummary = toolResults.map((tr) => {
    const data = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result, null, 2);
    return `[${tr.toolName}]\n${data}`;
  }).join("\n\n");

  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user")?.content || "";

  const retryMessages = [
    ...messages,
    { role: "assistant" as const, content: "我查詢了相關資料，以下是查詢結果：" },
    { role: "user" as const, content: `請根據以下查詢結果回答我的問題。不要再呼叫任何工具，直接用自然語言回答。\n\n查詢結果：\n${resultsSummary}\n\n原始問題：${lastUserMessage}` },
  ];

  console.log(`[Chat API] Smart retry: injecting ${toolResults.length} tool result(s) as context`);

  const retryResult = streamText({
    model: createModel(),
    system: SYSTEM_PROMPT,
    messages: retryMessages as any,
    maxOutputTokens: maxTokens,
    abortSignal: AbortSignal.timeout(120_000),
  });

  let hasText = false;
  for await (const part of retryResult.fullStream) {
    switch (part.type) {
      case "text-delta":
        hasText = true;
        processTextDelta(send, part.text, state, parseThink);
        break;
      case "reasoning-delta":
        hasText = true;
        send({ type: "reasoning-delta", text: part.text });
        break;
      case "finish":
        if (state.thinkBuffer) {
          const eventType = state.insideThink ? "reasoning-delta" : "text-delta";
          send({ type: eventType, text: state.thinkBuffer });
          state.thinkBuffer = "";
        }
        console.log(`[Chat API] Smart retry finished: ${part.finishReason}, text=${hasText}`);
        break;
      case "error":
        console.error("[Chat API] Smart retry error:", part.error);
        break;
      default:
        break;
    }
  }
  return hasText;
}

// Multi-attempt streaming orchestration (replicates tce-app logic)
async function orchestrateStream(
  send: NdjsonSender,
  messages: SimpleChatMessage[],
  modelId: string,
  createModel: () => any,
  tools: Record<string, any> | undefined,
): Promise<void> {
  const parseThink = needsThinkParsing(modelId);
  const maxTokens = isReasoningModel(modelId) ? 16384 : 4096;
  const state: StreamState = { insideThink: false, thinkBuffer: "" };

  const createStreamResult = (attempt: number) => streamText({
    model: createModel(),
    system: SYSTEM_PROMPT,
    messages: messages as any,
    maxOutputTokens: maxTokens,
    abortSignal: AbortSignal.timeout(60_000),
    ...(tools ? { tools, stopWhen: stepCountIs(5) } : {}),
  });

  // Step 1: Normal stream with tools
  state.insideThink = false;
  state.thinkBuffer = "";
  const firstResult = await processStream(createStreamResult(1), send, state, parseThink, 1);
  let resolved = firstResult.hasTextContent || firstResult.hasError;

  // Step 2: Smart retry — inject tool results as context, no tools
  if (!resolved && firstResult.hasToolCalls && firstResult.toolResults.length > 0) {
    console.warn("[Chat API] Tool calls succeeded but no text, using smart retry...");
    state.insideThink = false;
    state.thinkBuffer = "";
    const smartRetryOk = await processSmartRetry(send, state, parseThink, firstResult.toolResults, messages, createModel, maxTokens);
    resolved = smartRetryOk;
  }

  // Step 3: If still nothing, try a plain retry (no tool results to inject)
  if (!resolved) {
    console.warn("[Chat API] No content after first attempt, plain retry...");
    state.insideThink = false;
    state.thinkBuffer = "";
    const retryResult = await processStream(createStreamResult(2), send, state, parseThink, 2);
    resolved = retryResult.hasTextContent || retryResult.hasError;

    // Smart retry for the plain retry too
    if (!resolved && retryResult.hasToolCalls && retryResult.toolResults.length > 0) {
      state.insideThink = false;
      state.thinkBuffer = "";
      resolved = await processSmartRetry(send, state, parseThink, retryResult.toolResults, messages, createModel, maxTokens);
    }
  }

  // Final fallback
  if (!resolved) {
    console.error("[Chat API] All attempts failed, sending fallback");
    send({ type: "text-delta", text: "抱歉，我無法產生回覆。請再試一次或換一種方式提問。" });
  }

  send({ type: "finish", finishReason: "stop" });
  send({ type: "done" });
}

// Workers AI: use binding + gateway option
function handleWorkersAI(
  messages: SimpleChatMessage[],
  modelId: string,
  env: Env,
  toolsEnabled: boolean,
): Response {
  const gatewayId = env.AI_GATEWAY_ID || "nkcf-gateway-01";
  const createModel = () => {
    const workersai = createWorkersAI({
      binding: env.AI,
      gateway: { id: gatewayId, cacheTtl: 3600 },
    });
    return workersai(modelId);
  };

  const useTools = toolsEnabled && modelSupportsTools("workers-ai", modelId);
  const chatMessages = sanitizeMessages(messages);
  const tools = useTools ? { searchKnowledge: buildSearchKnowledgeTool(env) } : undefined;

  return makeNdjsonStream((send) => orchestrateStream(send, chatMessages, modelId, createModel, tools));
}

// External providers: use ai-gateway-provider (OpenAI, Anthropic, Perplexity)
function handleExternalProvider(
  messages: SimpleChatMessage[],
  provider: "openai" | "anthropic" | "perplexity",
  modelId: string,
  env: Env,
  toolsEnabled: boolean,
): Response {
  const aigateway = createAiGateway({
    accountId: env.CF_ACCOUNT_ID || "5efa272dc28e4e3933324c44165b6dbe",
    gateway: env.AI_GATEWAY_ID || "nkcf-gateway-01",
    apiKey: env.CF_AIG_TOKEN,
  });

  const createModel = () => {
    switch (provider) {
      case "openai": {
        const openai = createOpenAI();
        return aigateway(openai.chat(modelId));
      }
      case "anthropic": {
        const anthropic = createAnthropic();
        return aigateway(anthropic(modelId));
      }
      case "perplexity": {
        const perplexity = createOpenAICompatible({
          baseURL: "https://api.perplexity.ai/",
          name: "Perplexity",
          apiKey: "CF_TEMP_TOKEN",
        });
        return aigateway(perplexity.chatModel(modelId));
      }
    }
  };

  const useTools = toolsEnabled && modelSupportsTools(provider, modelId);
  const chatMessages = sanitizeMessages(messages);
  const tools = useTools ? { searchKnowledge: buildSearchKnowledgeTool(env) } : undefined;

  return makeNdjsonStream((send) => orchestrateStream(send, chatMessages, modelId, createModel, tools));
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
    "workers-ai": "@cf/meta/llama-3.1-8b-instruct",
  };
  const modelId = model || defaultModels[provider || "workers-ai"] || "@cf/meta/llama-3.1-8b-instruct";

  console.log("[Chat API] provider:", provider, "model:", modelId, "messages:", messages.length, "toolsEnabled:", toolsEnabled);

  try {
    if (provider === "openai" || provider === "anthropic" || provider === "perplexity") {
      return handleExternalProvider(messages, provider, modelId, env, toolsEnabled);
    }
    // Default: Workers AI via binding + gateway
    return handleWorkersAI(messages, modelId, env, toolsEnabled);
  } catch (err) {
    console.error("[Chat API] Error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message || "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
