import { createWorkersAI } from "workers-ai-provider";
import { createAiGateway } from "ai-gateway-provider";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { createAnthropic } from "ai-gateway-provider/providers/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, convertToModelMessages, type UIMessage } from "ai";
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
        const errEvent = { type: "error", message: (err as Error).message || "Stream error" };
        controller.enqueue(encoder.encode(JSON.stringify(errEvent) + "\n"));
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
