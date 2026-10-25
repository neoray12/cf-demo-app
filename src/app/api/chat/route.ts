import { NextRequest } from 'next/server';
import { stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { getTracedAI } from '@/lib/agents/tracing';
import { getRequestUser } from '@/lib/auth';
import { TurnRecorder, historyConfigured, isValidConversationId, saveTurn, type ModelAttempt } from '@/lib/chat-history';
import { z } from 'zod';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { AI_MODELS, DEFAULT_MODEL_ID, type ModelProvider } from '@/lib/types';
import { chatSandboxConfigured, uploadFile as sandboxUploadFile, warmSandbox } from '@/lib/chat-sandbox';
import { signCodeModeSession, codeModeSecret, describeTools, buildCodeModeModule, RETURN_SHAPE_HINT } from '@/lib/codemode';
import { parseMcpServerUrls } from '@/lib/mcp-client';
import { isPortalCodeModeUrl } from '@/lib/portal-catalog';
import { buildToolSet, safeTool, buildPortalCatalogPrompt, type ToolSetConfig, type UploadedFileInfo } from '@/lib/chat-tools';

const SYSTEM_PROMPT = `你是一個由 Cloudflare AI 驅動的智慧助理。你可以回答一般性問題，並提供有關 Cloudflare 產品與功能的資訊。

回答時請使用繁體中文，除非使用者使用其他語言提問。回答要精確、簡潔、直接，避免冗長的鋪陳和重複說明。優先給出結論，再補充必要細節。

如果工具結果含有 "blocked": true，代表該動作被組織的資安政策攔截：不要重試、不要改用其他工具繞過，直接告訴使用者哪個動作被攔截。`;

const TOOL_CAPABLE_WORKERS_AI = [
  /llama.*instruct/i,
  /llama.*function/i,
  /gpt-oss/i,
  /gemma/i,
  /qwen.*instruct/i,
  /mistral.*instruct/i,
  /kimi/i,
  /glm/i,
];

function modelSupportsTools(provider: ModelProvider, modelId: string): boolean {
  if (provider === 'openai' || provider === 'anthropic' || provider === 'auto') return true;
  if (provider === 'perplexity') return false;
  return TOOL_CAPABLE_WORKERS_AI.some((re) => re.test(modelId));
}

function isReasoningModel(modelId: string): boolean {
  return /deepseek/i.test(modelId) || /qwq/i.test(modelId);
}

// Models that require max_completion_tokens instead of max_tokens
function usesMaxCompletionTokens(modelId: string): boolean {
  return /gpt-[56]/i.test(modelId) || /gpt-4o/i.test(modelId) || /o1/i.test(modelId) || /o3/i.test(modelId) || /o4/i.test(modelId);
}

// Detect Cloudflare Firewall for AI HTML block page and extract metadata
function extractFirewallFromHtml(html: string): { isFirewall: boolean; rayId: string | null; userIp: string | null } {
  if (!html.includes('<!DOCTYPE html') && !html.includes('<html')) return { isFirewall: false, rayId: null, userIp: null };
  const isBlock = /you have been blocked/i.test(html) || /cf-error-details/i.test(html);
  if (!isBlock) return { isFirewall: false, rayId: null, userIp: null };
  const rayMatch = html.match(/Cloudflare Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/);
  const ipMatch = html.match(/id="cf-footer-ip">([^<]+)</);
  return { isFirewall: true, rayId: rayMatch?.[1] || null, userIp: ipMatch?.[1] || null };
}

// Prompts that probably want the Python sandbox / web preview (used to pre-warm it)
const SANDBOX_HINT = /計算|階乘|費氏|統計|算出|程式|python|pandas|csv|xlsx|圖表|畫圖|網頁|預覽|倒數|html|容器|sandbox|executeCode|calculate|factorial|fibonacci|chart|plot|preview/i;

// Extra system prompt guidance when the sandbox tools are available
const SANDBOX_PROMPT = `

當問題需要精確計算（數學、統計、日期、資料處理）時，使用 executeCode 工具執行 Python 程式碼取得真實結果，不要憑空心算。當使用者要求製作或展示網頁時，使用 createWebPreview 工具產生預覽網址，並在回覆中附上該網址。當使用者上傳 CSV/XLSX 檔案時，使用 executeCode 搭配 pandas 讀取分析，沙箱已安裝 pandas、openpyxl、matplotlib；若適合可用 matplotlib 畫圖，圖表會直接顯示給使用者。`;

// Extra system prompt guidance when the Browser Rendering tools are available
const BROWSER_PROMPT = `

當使用者要求截圖某個網頁時，使用 captureScreenshot 工具，截圖會直接顯示在對話中。當使用者要求閱讀、摘要或分析某個網址的內容時，使用 readWebPage 工具取得網頁的 Markdown 內容再回答。網址必須包含 http:// 或 https:// 開頭。`;

// Extra system prompt guidance when the Dynamic Worker executeJs tool is available
const DYNAMIC_WORKER_PROMPT = `

當需要執行 JavaScript 程式碼（快速計算、字串處理、演算法示範）時，優先使用 executeJs 工具——它在毫秒級啟動的 V8 isolate 中執行。需要 Python、pandas、檔案或畫圖時才用 executeCode。executeJs 的沙箱完全禁止網路存取，fetch 會失敗，這是刻意的安全設計。`;

// System prompt override when Code Mode collapses everything into one tool
const CODE_MODE_PROMPT = `

目前為 Code Mode：你只有一個 codemode 工具。需要查資料、執行程式、截圖或其他操作時，寫一段 JavaScript async arrow function，在裡面呼叫 codemode 命名空間下的函式（工具描述中列出了可用的函式與型別），一次完成多個步驟後 return 結果。這比多輪工具呼叫更快也更省 token。`;

const CODE_MODE_RETURN_HINT = `\n\n${RETURN_SHAPE_HINT}`;

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
  const { env, cf, ctx } = await getCloudflareContext();
  // POP that served this chat request — not necessarily the same colo the
  // sandbox container executes in (that's reported separately per tool call).
  const edgeColo = ((cf as { colo?: string } | undefined)?.colo as string | undefined) ?? null;

  const body = await request.json();
  const {
    messages,
    model: modelIdFromClient,
    provider: rawProvider,
    toolsEnabled = false,
    codeMode = false,
    mcpServers: mcpServerIds = [],
    userName,
    userEmail,
    attachments = [],
    images = [],
    conversationId,
    turnIndex: rawTurnIndex,
  } = body as {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    provider?: ModelProvider;
    toolsEnabled?: boolean;
    codeMode?: boolean;
    mcpServers?: string[];
    userName?: string;
    userEmail?: string;
    attachments?: Array<{ name: string; contentBase64: string }>;
    /** Pasted screenshots as data URLs, attached to the latest user turn. */
    images?: string[];
    /** Per-conversation id — Auto Router session affinity, tracing session and history key. */
    conversationId?: string;
    /** Position of this turn in the conversation; a resend at the same position replaces it in history. */
    turnIndex?: number;
  };
  const turnIndex = Number.isInteger(rawTurnIndex) && (rawTurnIndex as number) >= 0 ? (rawTurnIndex as number) : 0;

  // Verified identity (Access JWT or signed login cookie). The userEmail in the
  // body is only a fallback for gateway analytics, never for history ownership.
  const user = await getRequestUser(request, env as any);
  const analyticsEmail = user?.email ?? userEmail;
  const analyticsName = user?.name ?? userName;

  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'messages is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Resolve model from AI_MODELS or use defaults
  const provider: ModelProvider = rawProvider || 'workers-ai';
  const defaultModels: Record<string, string> = {
    openai: 'gpt-6-luna',
    anthropic: 'claude-sonnet-5-5',
    perplexity: 'sonar',
    'workers-ai': '@cf/openai/gpt-oss-20b',
  };
  const modelId = modelIdFromClient || defaultModels[provider] || '@cf/openai/gpt-oss-20b';

  // Build compat model ID for AI Gateway
  let compatModelId: string;
  switch (provider) {
    case 'workers-ai': compatModelId = `workers-ai/${modelId}`; break;
    case 'openai': compatModelId = `openai/${modelId}`; break;
    case 'anthropic': compatModelId = `anthropic/${modelId}`; break;
    case 'perplexity': compatModelId = `perplexity-ai/${modelId}`; break;
    case 'auto': compatModelId = 'cloudflare/auto'; break;
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
  // usertier: vera & kevin(menghsien) are VIP, others are regular
  const VIP_EMAILS = new Set(['vera@cloudflare.com', 'menghsien@cloudflare.com']);
  const usertier = analyticsEmail && VIP_EMAILS.has(analyticsEmail) ? 'VIP' : 'regular';

  // department: neo=技術, others=業務
  const TECH_EMAILS = new Set(['neo@cloudflare.com']);
  const department = analyticsEmail && TECH_EMAILS.has(analyticsEmail) ? '技術' : '業務';

  // Build metadata header for AI Gateway analytics
  // Use \uXXXX escape for non-ASCII chars (e.g. Chinese) to keep header Latin-1/ByteString safe
  // AI Gateway parses unicode escapes correctly — do NOT encodeURIComponent
  const metadataJson = JSON.stringify({
    tools_enabled: toolsEnabled,
    name: analyticsName ?? 'anonymous',
    email: analyticsEmail ?? 'unknown',
    usertier,
    department,
  }).replace(/[^\x20-\x7E]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

  // Sanitize SSE stream: some Workers AI models (e.g. llama-3.2-3b) return
  // delta.content as a number instead of string, causing AI_TypeValidationError.
  // This wrapper intercepts the response body and coerces content to string.
  // Auto Router reports the model it picked in response headers; captured here
  // and forwarded to the client as a `routed-model` event.
  let routedInfo: { model: string; reason: string | null } | null = null;
  // History: set once the request is fully parsed (only for a verified user).
  let recorder: TurnRecorder | null = null;
  // Which model call the next gateway request belongs to (for the history record).
  let currentAttempt = 'stream-1';

  function sanitizeSseFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers as HeadersInit);
    if (isExternal) headers.delete('Authorization');
    const attempt = currentAttempt;
    const startedMs = recorder?.elapsed() ?? 0;
    return fetch(url, { ...init, headers }).then((res) => {
      const routedModel = res.headers.get('cf-aig-routed-model');
      if (routedModel) routedInfo = { model: routedModel, reason: res.headers.get('cf-aig-routing-reason') };
      recorder?.noteGatewayCall({
        attempt,
        path: new URL(String(url instanceof Request ? url.url : url)).pathname,
        status: res.status,
        startedMs,
        cfRay: res.headers.get('cf-ray'),
        aigLogId: res.headers.get('cf-aig-log-id'),
        aigCacheStatus: res.headers.get('cf-aig-cache-status'),
        routedModel,
      });
      if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) return res;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const encoder2 = new TextEncoder();
      const transformed = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          const chunk = decoder.decode(value, { stream: true });
          const fixed = chunk.replace(/^data: ({.+})$/mg, (_, json) => {
            try {
              const obj = JSON.parse(json);
              if (obj?.choices) {
                for (const choice of obj.choices) {
                  if (choice?.delta && typeof choice.delta.content !== 'string' && choice.delta.content != null) {
                    choice.delta.content = String(choice.delta.content);
                  }
                }
              }
              return `data: ${JSON.stringify(obj)}`;
            } catch {
              return `data: ${json}`;
            }
          });
          controller.enqueue(encoder2.encode(fixed));
        },
        cancel() { reader.cancel(); },
      });
      return new Response(transformed, { status: res.status, headers: res.headers });
    });
  }

  // Auto Router: pin one model per turn (session affinity) and restrict the
  // candidate pool to providers this gateway actually has credentials for.
  const autoRouterHeaders: Record<string, string> = {};
  if (provider === 'auto') {
    const sid = (await cookies()).get('session_id')?.value || 'anonymous';
    autoRouterHeaders['cf-aig-session-id'] = `${sid}:${String(conversationId || 'default').replace(/[^\w-]/g, '').slice(0, 64)}`;
    const allowed = (env as any).AUTO_ROUTER_ALLOWED_PROVIDERS as string | undefined;
    if (allowed) autoRouterHeaders['cf-aig-allowed-providers'] = allowed;
  }

  const openai = createOpenAI({
    apiKey: isExternal ? 'aig-managed' : (cfApiToken || 'dummy'),
    baseURL,
    headers: {
      ...(aigToken ? { 'cf-aig-authorization': `Bearer ${aigToken}` } : {}),
      'cf-aig-metadata': metadataJson,
      ...autoRouterHeaders,
    },
    fetch: sanitizeSseFetch,
  });

  const useTools = toolsEnabled && modelSupportsTools(provider, modelId);
  const chatMessages: Array<{ role: string; content: unknown }> = sanitizeMessages(messages);

  // Images ride along with the newest user turn. The AI SDK converts these
  // image parts into whatever the provider expects (image_url for the
  // OpenAI-compatible gateway endpoint, source blocks for Anthropic).
  const validImages = Array.isArray(images)
    ? images.filter((u): u is string => typeof u === 'string' && u.startsWith('data:image/'))
    : [];
  if (validImages.length > 0) {
    let lastUserIdx = -1;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i]?.role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx >= 0) {
      const textContent = String(chatMessages[lastUserIdx]!.content ?? '');
      chatMessages[lastUserIdx] = {
        role: 'user',
        content: [
          // Some providers reject an empty text part, so only include one
          // when the user actually typed something alongside the image.
          ...(textContent.trim() ? [{ type: 'text', text: textContent }] : []),
          ...validImages
            .map((url) => {
              // The AI SDK treats a string `image` as a URL to fetch and
              // rejects the data: scheme, so split the data URL into its
              // media type and raw base64 payload instead.
              const comma = url.indexOf(',');
              const mediaType = url.slice(5, url.indexOf(';')) || 'image/png';
              return { type: 'image', image: url.slice(comma + 1), mediaType };
            }),
        ],
      };
      console.log(`[Chat API] ${images.length} image(s) attached to the last user message`);
    }
  }

  // Only parse <think> tags for reasoning models that embed reasoning in text
  const needsThinkParsing = isReasoningModel(modelId);
  const maxTokens = needsThinkParsing ? 16384 : 4096;
  const skipMaxTokens = usesMaxCompletionTokens(modelId);

  // Build tools: searchKnowledge + sandbox tools + MCP tools
  let tools: Record<string, any> | undefined;
  let sandboxToolsActive = false;
  let browserToolsActive = false;
  let dynamicWorkerActive = false;
  let codeModeActive = false;
  let portalCatalogPrompt = '';
  const uploadedFiles: UploadedFileInfo[] = [];
  // An MCP Portal connected with ?codemode=search_and_execute already runs the
  // model's JS on the Portal. Wrapping it in the app's Code Mode as well nests
  // two code runtimes, hides the Portal's tool catalog from the model, and
  // ends in guessed tool names — so the app's Code Mode sits that turn out.
  const portalCodeModeConnected = parseMcpServerUrls((env as any).MCP_SERVER_URLS || '')
    .some((s) => mcpServerIds.includes(s.id) && isPortalCodeModeUrl(s.url));
  const appCodeModeSkipped = useTools && codeMode && portalCodeModeConnected;
  if (useTools) {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get('session_id')?.value || 'anonymous';
    // Becomes a DNS label in preview URLs — keep it lowercase alphanumeric + hyphens,
    // and strip leading/trailing hyphens left by truncation (a UUID sliced to 24
    // chars always lands on a hyphen at position 23, e.g. "96cdf0dc-8565-4e63-8fbe-"
    // — the Sandbox SDK rejects IDs starting/ending with '-' as invalid DNS labels).
    const sanitizedSessionId = sessionId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 24)
      .replace(/^-+|-+$/g, '');
    const sandboxSessionId = `sbx-${sanitizedSessionId || 'anon'}`;

    // Boot the container now, while the model is still thinking — the first
    // executeCode/createWebPreview call then finds it warm instead of paying
    // the full cold start (and risking the tool timeout) itself.
    // Only for prompts that look like they need a sandbox — warming a container
    // for every tools-enabled chat would burn instance slots on plain Q&A.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (chatSandboxConfigured(env as any) && (attachments.length > 0 || SANDBOX_HINT.test(lastUser))) {
      ctx.waitUntil(warmSandbox(env as any, sandboxSessionId));
    }

    // Upload any attached CSV/XLSX into the sandbox before building the
    // tools, so executeCode's description can tell the model exactly where
    // to find them — the model can't discover files on its own inside the sandbox.
    if (chatSandboxConfigured(env as any)) {
      for (const att of attachments) {
        if (!att?.name || !att?.contentBase64) continue;
        const uploaded = await sandboxUploadFile(env as any, sandboxSessionId, att.name, att.contentBase64);
        if (uploaded.path) {
          uploadedFiles.push({ name: att.name, path: uploaded.path });
        } else {
          console.error('[Chat API] File upload failed:', att.name, uploaded.error);
        }
      }
    }

    const toolConfig: ToolSetConfig = { sessionId, sandboxSessionId, edgeColo, uploadedFiles, mcpServerIds };
    const built = await buildToolSet(env as any, toolConfig, validImages);
    tools = built.tools;
    sandboxToolsActive = built.sandboxToolsActive;
    browserToolsActive = built.browserToolsActive;
    dynamicWorkerActive = built.dynamicWorkerActive;

    // Code Mode: collapse the whole tool set into ONE tool — the model writes
    // a JS script that calls the other tools as functions inside a Dynamic
    // Worker, instead of stepping through multiple tool-call rounds. This is
    // the token-saving pattern Cloudflare's codemode SDK implements.
    if (codeMode && !appCodeModeSkipped && (env as any).LOADER && (env as any).SELF) {
      // executeJs is redundant inside Code Mode (the script itself IS the JS);
      // searchKnowledgeByImage depends on this request's images, which the
      // codemode-exec isolate can't rebuild from the signed session.
      const { executeJs: _omitted, searchKnowledgeByImage: _omittedImg, ...wrappedTools } = tools;
      const toolNames = Object.keys(wrappedTools);
      const token = await signCodeModeSession(codeModeSecret(env as any), { ...toolConfig, toolNames });

      tools = {
        codemode: {
          description:
            '一次執行多個工具：寫一段 JavaScript async 程式碼，在裡面呼叫下列函式並 return 最終結果。這比多輪工具呼叫更快、更省 token。可用函式：\n' +
            describeTools(wrappedTools as any) +
            '\n用 await 呼叫（如 const page = await codemode.readWebPage({ url }); ），用 return 回傳結果，可用 console.log() 輸出過程。',
          inputSchema: z.object({
            code: z.string().describe('JavaScript 程式碼，呼叫 codemode.<工具名>(args) 並 return 結果'),
          }),
          execute: safeTool(async ({ code }: { code: string }) => {
            console.log('[Chat API] codemode script:', code.length, 'chars');
            const loader = (env as any).LOADER as {
              load: (opts: Record<string, unknown>) => { getEntrypoint: () => { fetch: (req: Request) => Promise<Response> } };
            };
            const started = Date.now();
            const worker = loader.load({
              compatibilityDate: '2026-01-01',
              mainModule: 'main.js',
              modules: { 'main.js': buildCodeModeModule(code, token) },
              // Route the sandbox's egress back to this Worker: codemode.*
              // calls reach /api/codemode-exec; anything else 404s here and
              // never touches the real internet.
              globalOutbound: (env as any).SELF,
            });
            const res = await worker
              .getEntrypoint()
              .fetch(new Request('https://codemode.internal/', { signal: AbortSignal.timeout(45_000) }));
            const executionMs = Date.now() - started;
            const data = (await res.json()) as { logs: string[]; result: unknown; error: string | null };
            return { code, ...data, engine: 'codemode', executionMs, toolCount: toolNames.length };
          }),
        },
      };
      codeModeActive = true;
      console.log(`[Chat API] Code Mode: wrapped ${toolNames.length} tool(s) into codemode`);
    }

    console.log('[Chat API] Tools registered:', Object.keys(tools).join(', '));
    if (mcpServerIds.length) portalCatalogPrompt = await buildPortalCatalogPrompt(env as any, sessionId, mcpServerIds);
  }

  const systemPrompt = codeModeActive
    ? SYSTEM_PROMPT + CODE_MODE_PROMPT + CODE_MODE_RETURN_HINT
    : SYSTEM_PROMPT +
      (sandboxToolsActive ? SANDBOX_PROMPT : '') +
      (browserToolsActive ? BROWSER_PROMPT : '') +
      (dynamicWorkerActive ? DYNAMIC_WORKER_PROMPT : '') +
      portalCatalogPrompt;

  // Cloudflare Agents tracing (production only; plain `ai` in next dev). Payloads
  // are recorded so the dashboard's session replay shows the whole turn.
  const ai = await getTracedAI({ storeContent: true });
  const traceConversationId = isValidConversationId(conversationId) ? conversationId : undefined;
  const telemetry = {
    isEnabled: true,
    functionId: 'main-chat',
    metadata: {
      agentId: 'main-chat-demo',
      ...(traceConversationId ? { conversationId: traceConversationId } : {}),
      model: compatModelId,
      turnIndex,
      ...(user ? { email: user.email } : {}),
    },
  };

  // Full turn record for the signed-in user's history (D1 index + R2 record).
  if (user && traceConversationId && historyConfigured(env as any)) {
    recorder = new TurnRecorder({
      conversationId: traceConversationId,
      turnIndex,
      user,
      request: {
        model: modelId,
        provider,
        compatModelId,
        toolsEnabled,
        codeMode,
        codeModeActive,
        appCodeModeSkipped,
        mcpServers: mcpServerIds,
        edgeColo,
        country: ((cf as { country?: string } | undefined)?.country as string | undefined) ?? null,
        userAgent: request.headers.get('user-agent'),
        maxOutputTokens: skipMaxTokens ? null : maxTokens,
        systemPrompt,
        tools: Object.entries(tools ?? {}).map(([name, t]) => ({ name, description: String((t as { description?: string }).description ?? '') })),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        userText: [...messages].reverse().find((m) => m.role === 'user')?.content ?? '',
        imageKeys: [],
        attachments: attachments.map((a) => ({
          name: a.name,
          bytes: Math.floor(((a.contentBase64?.length ?? 0) * 3) / 4),
          sandboxPath: uploadedFiles.find((f) => f.name === a.name)?.path ?? null,
        })),
      },
    });
  }

  // One history entry per model call: usage and per-step details from onFinish,
  // or the error when the call never finished.
  function trackAttempt(label: string) {
    const startedMs = recorder?.elapsed() ?? 0;
    let finished = false;
    return {
      onFinish(e: { finishReason?: string; totalUsage?: unknown; usage?: unknown; steps?: Array<Record<string, any>> }) {
        finished = true;
        recorder?.noteAttempt({
          attempt: label,
          startedMs,
          endedMs: recorder.elapsed(),
          finishReason: e.finishReason ?? null,
          usage: (e.totalUsage ?? e.usage ?? null) as ModelAttempt['usage'],
          steps: (e.steps ?? []).map((s) => ({
            finishReason: s.finishReason ?? null,
            usage: s.usage ?? null,
            responseId: s.response?.id ?? null,
            modelId: s.response?.modelId ?? null,
            toolCalls: Array.isArray(s.toolCalls) ? s.toolCalls.length : 0,
          })),
          error: null,
        });
      },
      end(error: unknown) {
        if (finished || !recorder) return;
        recorder.noteAttempt({
          attempt: label,
          startedMs,
          endedMs: recorder.elapsed(),
          finishReason: null,
          usage: null,
          steps: [],
          error: error ? String((error as Error)?.message ?? error) : 'stream ended without finish',
        });
      },
    };
  }

  // Abort on inactivity rather than on a fixed total budget. One 60s signal
  // spanned every step of a multi-step run (tool-call argument streaming, tool
  // execution, then the answer), so a long Code Mode script — Kimi streams a
  // 1.4k-char script in ~50s — used up the budget before the answer step began.
  const IDLE_MS = 90_000;
  const HARD_CAP_MS = 240_000;
  function createStream(attempt: number) {
    const ac = new AbortController();
    const hardCap = setTimeout(() => ac.abort(new Error('hard cap')), HARD_CAP_MS);
    let idle: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => ac.abort(new Error('idle')), IDLE_MS);
    };
    const done = () => {
      clearTimeout(hardCap);
      if (idle) clearTimeout(idle);
    };
    bump();
    currentAttempt = `stream-${attempt}`;
    const tracked = trackAttempt(currentAttempt);
    const result = ai.streamText({
      model: openai.chat(compatModelId),
      system: systemPrompt,
      messages: chatMessages as any,
      ...(skipMaxTokens ? {} : { maxOutputTokens: maxTokens }),
      ...(tools ? { tools, stopWhen: stepCountIs(8) } : {}),
      abortSignal: ac.signal,
      experimental_telemetry: telemetry,
      onFinish: (e) => {
        tracked.onFinish(e as any);
        console.log(JSON.stringify({ event: 'chat_finish', attempt, model: compatModelId, finishReason: e.finishReason, textLen: e.text?.length || 0, usage: e.usage }));
      },
    });
    return { result, bump, done, tracked };
  }

  // Stream NDJSON events for text, tool calls, reasoning
  const encoder = new TextEncoder();
  let insideThink = false;
  let thinkBuffer = '';
  let routedSent = false;

  function send(controller: ReadableStreamDefaultController, data: Record<string, unknown>) {
    // Every event the browser sees also goes into the history record.
    recorder?.onEvent(data as { type: string });
    try {
      controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
    } catch {
      // Controller already closed — ignore
    }
  }

  // Process text-delta: split on <think>/</think> boundaries when needed
  function processTextDelta(controller: ReadableStreamDefaultController, raw: string) {
    if (!raw) return;
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
    const { result, bump, done, tracked } = createStream(attempt);
    let hasTextContent = false;
    let hasToolCalls = false;
    let hasError = false;
    let streamError: unknown = null;
    const toolResults: ToolResultEntry[] = [];

    try {
    for await (const part of result.fullStream) {
      bump();
      if (routedInfo && !routedSent) {
        routedSent = true;
        send(controller, { type: 'routed-model', ...(routedInfo as { model: string; reason: string | null }) });
      }
      switch (part.type) {
        case 'text-delta':
          hasTextContent = true;
          processTextDelta(controller, part.text);
          break;
        case 'reasoning-delta':
          if (part.text) {
            hasTextContent = true;
            send(controller, { type: 'reasoning-delta', text: part.text });
          }
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
        case 'tool-error':
          send(controller, {
            type: 'tool-error',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            error: String((part.error as Error)?.message ?? part.error),
          });
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
          let finalRayId = errRayId;
          let userIp: string | null = null;

          // Check for Firewall for AI HTML block page
          const fwCheck = extractFirewallFromHtml(errResponseBody);
          if (fwCheck.isFirewall) {
            errType = 'firewall';
            errMsg = '您的請求已被 Cloudflare Firewall for AI 攔截。';
            finalRayId = fwCheck.rayId || finalRayId;
            userIp = fwCheck.userIp;
          } else {
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
          }

          if (!errMsg) errMsg = String(part.error);
          streamError = errMsg;

          console.error(JSON.stringify({ event: 'chat_stream_error', attempt, model: compatModelId, errorType: errType, gatewayCode: errCode, statusCode: errStatusCode, error: errMsg }));
          send(controller, {
            type: 'error',
            errorType: errType,
            message: errMsg,
            statusCode: errStatusCode || null,
            rayId: finalRayId,
            gatewayLogId: errLogId,
            gatewayCode: errCode,
            userIp,
          });
          hasError = true;
          break;
        }
        case 'abort':
          console.warn(JSON.stringify({ event: 'chat_stream_abort', attempt, model: compatModelId, text: hasTextContent, tools: hasToolCalls, toolResults: toolResults.length }));
          break;
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
    } catch (err) {
      streamError = err;
      throw err;
    } finally {
      done();
      tracked.end(streamError);
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

    currentAttempt = 'smart-retry';
    const tracked = trackAttempt(currentAttempt);
    const retryResult = ai.streamText({
      model: openai.chat(compatModelId),
      system: SYSTEM_PROMPT,
      messages: retryMessages as any,
      // No tools — force text generation
      ...(skipMaxTokens ? {} : { maxOutputTokens: maxTokens }),
      abortSignal: AbortSignal.timeout(120_000),
      experimental_telemetry: telemetry,
      onFinish: (e) => {
        tracked.onFinish(e as any);
        console.log(JSON.stringify({ event: 'chat_finish', attempt: 'smart-retry', model: compatModelId, finishReason: e.finishReason, textLen: e.text?.length || 0, usage: e.usage }));
      },
    });

    let hasText = false;
    let retryError: unknown = null;
    try {
    for await (const part of retryResult.fullStream) {
      switch (part.type) {
        case 'text-delta':
          hasText = true;
          processTextDelta(controller, part.text);
          break;
        case 'reasoning-delta':
          if (part.text) {
            hasText = true;
            send(controller, { type: 'reasoning-delta', text: part.text });
          }
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
          retryError = part.error;
          break;
        default:
          break;
      }
    }
    } catch (err) {
      retryError = err;
      throw err;
    } finally {
      tracked.end(retryError);
    }
    return hasText;
  }

  // The history write runs after the stream closes, so it is registered with
  // waitUntil up front (the response may already be finished by then).
  let historySaved: () => void = () => {};
  if (recorder) {
    ctx.waitUntil(new Promise<void>((resolve) => { historySaved = resolve; }));
    request.signal?.addEventListener('abort', () => { if (recorder) recorder.clientGone = true; });
  }
  async function saveHistory() {
    if (!recorder) return;
    try {
      await saveTurn(env as any, recorder.finish(), validImages);
    } catch (err) {
      console.error('[Chat API] history save failed:', (err as Error)?.message ?? err);
    } finally {
      historySaved();
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (appCodeModeSkipped) send(controller, { type: 'notice', kind: 'portal-codemode' });
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
        let finalRayId = rayId;
        let userIp: string | null = null;

        // Check for Firewall for AI HTML block page
        const fwCheck = extractFirewallFromHtml(responseBody);
        if (fwCheck.isFirewall) {
          errorType = 'firewall';
          message = '您的請求已被 Cloudflare Firewall for AI 攔截。';
          finalRayId = fwCheck.rayId || finalRayId;
          userIp = fwCheck.userIp;
        } else {
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
              ? `API Error ${statusCode}: ${responseBody?.substring(0, 200) || error?.message || err}`
              : String(err);
          }
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
          rayId: finalRayId,
          gatewayLogId,
          gatewayCode,
          userIp,
        });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
        await saveHistory();
      }
    },
    cancel() {
      // The browser went away (stop button / closed tab); the model call still
      // runs to the end, and the record says the user never saw all of it.
      if (recorder) recorder.clientGone = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
