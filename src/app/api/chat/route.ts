import { NextRequest } from 'next/server';
import { streamText, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { AI_MODELS, DEFAULT_MODEL_ID, type ModelProvider } from '@/lib/types';

const SYSTEM_PROMPT = `你是一個由 Cloudflare AI 驅動的智慧助理。你可以回答一般性問題，並提供有關 Cloudflare 產品與功能的資訊。

回答時請使用繁體中文，除非使用者使用其他語言提問。回答要精確、有幫助。`;

const TOOL_CAPABLE_WORKERS_AI = [
  /llama.*instruct/i,
  /llama.*function/i,
  /gpt-oss/i,
  /gemma.*instruct/i,
  /qwen.*instruct/i,
  /mistral.*instruct/i,
];

function modelSupportsTools(provider: ModelProvider, modelId: string): boolean {
  if (provider === 'openai' || provider === 'anthropic') return true;
  if (provider === 'perplexity') return false;
  return TOOL_CAPABLE_WORKERS_AI.some((re) => re.test(modelId));
}

function isReasoningModel(modelId: string): boolean {
  return /deepseek/i.test(modelId) || /qwq/i.test(modelId);
}

// Models that require max_completion_tokens instead of max_tokens
function usesMaxCompletionTokens(modelId: string): boolean {
  return /gpt-5/i.test(modelId) || /gpt-4o/i.test(modelId) || /o1/i.test(modelId) || /o3/i.test(modelId) || /o4/i.test(modelId);
}

// Wrap tool execute to catch errors gracefully instead of crashing the stream
function safeTool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (err) {
      console.error('[Chat API] Tool error:', err);
      return { error: `Tool execution failed: ${(err as Error).message || String(err)}` };
    }
  };
}

function buildSearchKnowledgeTool(env: Record<string, unknown>) {
  return {
    description: '搜尋知識庫中已爬取的網站內容。當使用者詢問與已爬取網站相關的問題時使用此工具。',
    inputSchema: z.object({
      query: z.string().describe('搜尋查詢，使用與使用者問題相同的語言'),
      maxResults: z.number().optional().default(5).describe('最大結果數量 (1-10)'),
    }),
    execute: safeTool(async ({ query, maxResults }: { query: string; maxResults: number }) => {
      try {
        console.log('[Chat API] searchKnowledge:', query);
        // AI Search (AutoRAG) requires Cloudflare AI binding — not available in local dev
        if (!(env.AI as any)?.autorag) {
          return { error: 'AI Search 在本地開發環境不可用，請部署到 Cloudflare Workers 後使用。' };
        }
        const numResults = Math.min(Math.max(maxResults ?? 5, 1), 10);
        const autoragName = (env.AUTORAG_NAME as string) || 'cf-demo-ai-search';
        const searchPromise = (env.AI as any).autorag(autoragName).search({
          query,
          max_num_results: numResults,
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AutoRAG 搜尋逾時（15s）')), 15000)
        );
        const ragResult = await Promise.race([searchPromise, timeoutPromise]);
        if (!ragResult?.data?.length) return { found: false, message: '未找到相關的知識庫內容。' };
        const filtered = ragResult.data
          .filter((item: { score: number }) => item.score >= 0.3)
          .map((item: { filename: string; score: number; content: Array<{ text: string }> }) => ({
            filename: item.filename,
            score: item.score,
            text: item.content?.map((c: { text: string }) => c.text).join('\n'),
          }));
        if (!filtered.length) return { found: false, message: '找到結果但相關性不足，請嘗試換個問法。' };
        return { found: true, count: filtered.length, results: filtered };
      } catch (err) {
        console.error('[Chat API] searchKnowledge error:', err);
        return { error: `知識庫搜尋失敗: ${(err as Error).message}` };
      }
    }),
  };
}

// Merge consecutive same-role messages (some providers reject them)
function sanitizeMessages(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.content = last.content + '\n' + msg.content;
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  return result;
}

export async function POST(request: NextRequest) {
  const { env } = await getCloudflareContext();

  const body = await request.json();
  const {
    messages,
    model: modelIdFromClient,
    provider: rawProvider,
    toolsEnabled = false,
  } = body as {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    provider?: ModelProvider;
    toolsEnabled?: boolean;
  };

  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'messages is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Resolve model from AI_MODELS or use defaults
  const provider: ModelProvider = rawProvider || 'workers-ai';
  const defaultModels: Record<string, string> = {
    openai: 'gpt-3.5-turbo',
    anthropic: 'claude-sonnet-4-20250514',
    perplexity: 'sonar',
    'workers-ai': '@cf/meta/llama-3.1-8b-instruct',
  };
  const modelId = modelIdFromClient || defaultModels[provider] || '@cf/meta/llama-3.1-8b-instruct';

  // Build compat model ID for AI Gateway
  let compatModelId: string;
  switch (provider) {
    case 'workers-ai': compatModelId = `workers-ai/${modelId}`; break;
    case 'openai': compatModelId = `openai/${modelId}`; break;
    case 'anthropic': compatModelId = `anthropic/${modelId}`; break;
    case 'perplexity': compatModelId = `perplexity-ai/${modelId}`; break;
    default: compatModelId = `workers-ai/${modelId}`;
  }

  console.log('[Chat API] provider:', provider, 'model:', modelId, 'compat:', compatModelId, 'messages:', messages.length, 'toolsEnabled:', toolsEnabled);

  // AI Gateway /compat — all providers through unified endpoint
  const accountId = (env as any).CF_ACCOUNT_ID || '5efa272dc28e4e3933324c44165b6dbe';
  const gatewayId = (env as any).AI_GATEWAY_ID || 'nkcf-gateway-01';
  const baseURL = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`;
  const aigToken = (env as any).CF_AIG_TOKEN;
  const cfApiToken = (env as any).CF_API_TOKEN;

  // Workers AI: CF_API_TOKEN as Authorization header
  // External providers: strip Authorization so AI Gateway uses stored credentials
  const isExternal = provider !== 'workers-ai';
  // Build metadata header for AI Gateway analytics
  const metadata = JSON.stringify({
    model: compatModelId,
    provider,
    tools_enabled: toolsEnabled,
  });

  const openai = createOpenAI({
    apiKey: isExternal ? 'aig-managed' : (cfApiToken || 'dummy'),
    baseURL,
    headers: {
      ...(aigToken ? { 'cf-aig-authorization': `Bearer ${aigToken}` } : {}),
      'cf-aig-metadata': metadata,
    },
    fetch: isExternal
      ? (url, init) => {
          const headers = new Headers(init?.headers as HeadersInit);
          headers.delete('Authorization');
          return fetch(url, { ...init, headers });
        }
      : undefined,
  });

  const useTools = toolsEnabled && modelSupportsTools(provider, modelId);
  const chatMessages = sanitizeMessages(messages);

  // Only parse <think> tags for reasoning models that embed reasoning in text
  const needsThinkParsing = isReasoningModel(modelId);
  const maxTokens = needsThinkParsing ? 16384 : 4096;
  const skipMaxTokens = usesMaxCompletionTokens(modelId);

  const tools = useTools ? { searchKnowledge: buildSearchKnowledgeTool(env as any) } : undefined;

  function createStream(attempt: number) {
    return streamText({
      model: openai.chat(compatModelId),
      system: SYSTEM_PROMPT,
      messages: chatMessages as any,
      ...(skipMaxTokens ? {} : { maxOutputTokens: maxTokens }),
      ...(tools ? { tools, stopWhen: stepCountIs(8) } : {}),
      abortSignal: AbortSignal.timeout(60_000),
      onFinish: ({ text, finishReason, usage }) => {
        console.log(JSON.stringify({ event: 'chat_finish', attempt, model: compatModelId, finishReason, textLen: text?.length || 0, usage }));
      },
    });
  }

  // Stream NDJSON events for text, tool calls, reasoning
  const encoder = new TextEncoder();
  let insideThink = false;
  let thinkBuffer = '';

  function send(controller: ReadableStreamDefaultController, data: Record<string, unknown>) {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
    } catch {
      // Controller already closed — ignore
    }
  }

  // Process text-delta: split on <think>/</think> boundaries when needed
  function processTextDelta(controller: ReadableStreamDefaultController, raw: string) {
    if (!needsThinkParsing) {
      send(controller, { type: 'text-delta', text: raw });
      return;
    }

    let text = thinkBuffer + raw;
    thinkBuffer = '';

    // Buffer potential partial tags at the end
    const partial = text.match(/<\/?(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/);
    if (partial) {
      thinkBuffer = partial[0];
      text = text.slice(0, -thinkBuffer.length);
    }

    let remaining = text;
    while (remaining.length > 0) {
      if (insideThink) {
        const closeIdx = remaining.indexOf('</think>');
        if (closeIdx !== -1) {
          const reasoningText = remaining.slice(0, closeIdx);
          if (reasoningText) send(controller, { type: 'reasoning-delta', text: reasoningText });
          insideThink = false;
          remaining = remaining.slice(closeIdx + '</think>'.length);
        } else {
          if (remaining) send(controller, { type: 'reasoning-delta', text: remaining });
          remaining = '';
        }
      } else {
        const openIdx = remaining.indexOf('<think>');
        if (openIdx !== -1) {
          const normalText = remaining.slice(0, openIdx);
          if (normalText) send(controller, { type: 'text-delta', text: normalText });
          insideThink = true;
          remaining = remaining.slice(openIdx + '<think>'.length);
        } else {
          if (remaining) send(controller, { type: 'text-delta', text: remaining });
          remaining = '';
        }
      }
    }
  }

  // Collected tool results for smart retry
  interface ToolResultEntry {
    toolName: string;
    result: unknown;
  }

  // Process a single stream attempt
  async function processStream(
    controller: ReadableStreamDefaultController,
    attempt: number
  ): Promise<{ hasTextContent: boolean; hasToolCalls: boolean; hasError: boolean; toolResults: ToolResultEntry[] }> {
    const result = createStream(attempt);
    let hasTextContent = false;
    let hasToolCalls = false;
    let hasError = false;
    const toolResults: ToolResultEntry[] = [];

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          hasTextContent = true;
          processTextDelta(controller, part.text);
          break;
        case 'reasoning-delta':
          hasTextContent = true;
          send(controller, { type: 'reasoning-delta', text: part.text });
          break;
        case 'tool-input-start':
          hasToolCalls = true;
          send(controller, { type: 'tool-call-start', toolCallId: part.id, toolName: part.toolName });
          break;
        case 'tool-call':
          send(controller, { type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, args: part.input });
          break;
        case 'tool-result':
          send(controller, { type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, result: part.output });
          toolResults.push({ toolName: part.toolName, result: part.output });
          break;
        case 'finish':
          // Flush any remaining thinkBuffer
          if (thinkBuffer) {
            const eventType = insideThink ? 'reasoning-delta' : 'text-delta';
            send(controller, { type: eventType, text: thinkBuffer });
            thinkBuffer = '';
          }
          if (part.finishReason === 'length') {
            send(controller, { type: 'text-delta', text: '\n\n⚠️ *回覆因長度限制被截斷，請嘗試縮小問題範圍。*' });
          }
          console.log(`[Chat API] Stream finished (attempt ${attempt}): ${part.finishReason}, text=${hasTextContent}, tools=${hasToolCalls}`);
          break;
        case 'error': {
          // Parse AI Gateway structured error from AI_APICallError
          const err = part.error as Record<string, unknown>;
          const errStatusCode = Number(err?.statusCode || err?.status || 0);
          const errResponseBody = String(err?.responseBody || '');
          const errHeaders = err?.responseHeaders as Record<string, string> | undefined;
          const errRayId = errHeaders?.['cf-ray'] ?? (typeof errHeaders?.get === 'function' ? (errHeaders as any).get('cf-ray') : null) ?? null;
          const errLogId = errHeaders?.['cf-aig-log-id'] ?? (typeof errHeaders?.get === 'function' ? (errHeaders as any).get('cf-aig-log-id') : null) ?? null;

          let errType: 'firewall' | 'gateway' | 'dlp' | 'general' = 'general';
          let errCode: string | null = null;
          let errMsg = '';

          try {
            const body = JSON.parse(errResponseBody) as { error?: Array<{ code: number; message: string }> };
            if (body?.error?.[0]) {
              const gwErr = body.error[0];
              errCode = String(gwErr.code);
              errMsg = gwErr.message;
              if (gwErr.code === 2029) errType = 'dlp';
              else if (gwErr.code === 2016) errType = 'firewall';
              else if (gwErr.code >= 2000 && gwErr.code < 3000) errType = 'gateway';
            }
          } catch { /* not JSON */ }

          if (!errMsg) errMsg = String(part.error);

          console.error(JSON.stringify({ event: 'chat_stream_error', attempt, model: compatModelId, errorType: errType, gatewayCode: errCode, statusCode: errStatusCode, error: errMsg }));
          send(controller, {
            type: 'error',
            errorType: errType,
            message: errMsg,
            statusCode: errStatusCode || null,
            rayId: errRayId,
            gatewayLogId: errLogId,
            gatewayCode: errCode,
          });
          hasError = true;
          break;
        }
        // Known informational events — ignore silently
        case 'start':
        case 'start-step':
        case 'finish-step':
        case 'text-start':
        case 'text-end':
        case 'tool-input-delta':
        case 'tool-input-end':
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
    controller: ReadableStreamDefaultController,
    toolResults: ToolResultEntry[]
  ): Promise<boolean> {
    const resultsSummary = toolResults.map((tr) => {
      const data = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2);
      return `[${tr.toolName}]\n${data}`;
    }).join('\n\n');

    const lastUserMessage = [...messages].reverse().find((m: { role: string }) => m.role === 'user')?.content || '';

    const retryMessages = [
      ...chatMessages,
      { role: 'assistant' as const, content: '我查詢了相關資料，以下是查詢結果：' },
      { role: 'user' as const, content: `請根據以下查詢結果回答我的問題。不要再呼叫任何工具，直接用自然語言回答。\n\n查詢結果：\n${resultsSummary}\n\n原始問題：${lastUserMessage}` },
    ];

    console.log(`[Chat API] Smart retry: injecting ${toolResults.length} tool result(s) as context`);

    const retryResult = streamText({
      model: openai.chat(compatModelId),
      system: SYSTEM_PROMPT,
      messages: retryMessages as any,
      // No tools — force text generation
      ...(skipMaxTokens ? {} : { maxOutputTokens: maxTokens }),
      abortSignal: AbortSignal.timeout(60_000),
      onFinish: ({ text, finishReason, usage }) => {
        console.log(JSON.stringify({ event: 'chat_finish', attempt: 'smart-retry', model: compatModelId, finishReason, textLen: text?.length || 0, usage }));
      },
    });

    let hasText = false;
    for await (const part of retryResult.fullStream) {
      switch (part.type) {
        case 'text-delta':
          hasText = true;
          processTextDelta(controller, part.text);
          break;
        case 'reasoning-delta':
          hasText = true;
          send(controller, { type: 'reasoning-delta', text: part.text });
          break;
        case 'finish':
          if (thinkBuffer) {
            const eventType = insideThink ? 'reasoning-delta' : 'text-delta';
            send(controller, { type: eventType, text: thinkBuffer });
            thinkBuffer = '';
          }
          console.log(`[Chat API] Smart retry finished: ${part.finishReason}, text=${hasText}`);
          break;
        case 'error':
          console.error('[Chat API] Smart retry error:', part.error);
          break;
        default:
          break;
      }
    }
    return hasText;
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Step 1: Normal stream with tools
        insideThink = false;
        thinkBuffer = '';
        const firstResult = await processStream(controller, 1);

        let resolved = firstResult.hasTextContent || firstResult.hasError;

        // Step 2: Smart retry — inject tool results as context, no tools
        if (!resolved && firstResult.hasToolCalls && firstResult.toolResults.length > 0) {
          console.warn('[Chat API] Tool calls succeeded but no text, using smart retry...');
          insideThink = false;
          thinkBuffer = '';
          const smartRetryOk = await processSmartRetry(controller, firstResult.toolResults);
          resolved = smartRetryOk;
        }

        // Step 3: If still nothing, try a plain retry
        if (!resolved) {
          console.warn('[Chat API] No content after first attempt, plain retry...');
          insideThink = false;
          thinkBuffer = '';
          const retryResult = await processStream(controller, 2);
          resolved = retryResult.hasTextContent || retryResult.hasError;

          // Smart retry for the plain retry too
          if (!resolved && retryResult.hasToolCalls && retryResult.toolResults.length > 0) {
            insideThink = false;
            thinkBuffer = '';
            resolved = await processSmartRetry(controller, retryResult.toolResults);
          }
        }

        // Final fallback
        if (!resolved) {
          console.error('[Chat API] All attempts failed, sending fallback');
          send(controller, { type: 'text-delta', text: '抱歉，我無法產生回覆。請再試一次或換一種方式提問。' });
        }

        send(controller, { type: 'finish', finishReason: 'stop' });
        send(controller, { type: 'done' });
      } catch (err: unknown) {
        const error = err as Record<string, unknown>;
        const statusCode = Number(error?.statusCode || error?.status || 0);
        const responseBody = String(error?.responseBody || '');
        const responseHeaders = (error?.responseHeaders || {}) as Record<string, string>;

        // Extract AI Gateway metadata from response headers
        const rayId = responseHeaders['cf-ray'] || null;
        const gatewayLogId = responseHeaders['cf-aig-log-id'] || null;

        // Try to parse AI Gateway JSON error response
        let errorType: 'firewall' | 'gateway' | 'dlp' | 'general' = 'general';
        let gatewayCode: string | null = null;
        let message = '';

        try {
          const body = JSON.parse(responseBody) as { error?: Array<{ code: number; message: string }> };
          if (body?.error?.[0]) {
            const gwErr = body.error[0];
            gatewayCode = String(gwErr.code);
            message = gwErr.message;

            // Classify error type by code
            // 2029 = DLP policy violation
            if (gwErr.code === 2029) {
              errorType = 'dlp';
            }
            // 2016 = Firewall for AI block
            else if (gwErr.code === 2016) {
              errorType = 'firewall';
            }
            // Other 2xxx = AI Gateway errors
            else if (gwErr.code >= 2000 && gwErr.code < 3000) {
              errorType = 'gateway';
            }
          }
        } catch {
          // responseBody is not JSON — use raw message
          message = statusCode
            ? `API Error ${statusCode}: ${responseBody || error?.message || err}`
            : String(err);
        }

        if (!message) {
          message = statusCode
            ? `API Error ${statusCode}: ${error?.message || err}`
            : String(err);
        }

        console.error(JSON.stringify({ event: 'chat_catch', model: compatModelId, errorType, gatewayCode, statusCode, error: message }));
        send(controller, {
          type: 'error',
          errorType,
          message,
          statusCode: statusCode || null,
          rayId,
          gatewayLogId,
          gatewayCode,
        });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
