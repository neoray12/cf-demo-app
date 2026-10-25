import { NextRequest } from 'next/server';
import { stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { getTracedAI, isTracingActive, setActiveSpanAttributes, withToolSpan } from '@/lib/agents/tracing';
import { runTracedTool, type RunContext } from '@/lib/agents/runtime';
import type { TraceEvent } from '@/lib/agents/trace-events';
import { createChatSpanTracker, MAIN_ROOT_SPAN, type GatewayInfo } from '@/lib/chat-spans';
import { buildGatewayMetadata } from '@/lib/gateway-metadata';
import { resolveToolPolicy, turnCodeMode } from '@/lib/tool-policy';
import { buildDelegateTool } from '@/lib/mcp-subagent';
import { createIdleGuard } from '@/lib/idle-guard';
import { parseRoutingHeaders, type AutoRouting } from '@/lib/auto-router';
import { DEFAULT_SYSTEM_PROMPT, composeSystemPrompt, systemPromptKey } from '@/lib/system-prompt';
import { getRequestUser } from '@/lib/auth';
import { TurnRecorder, historyConfigured, isValidConversationId, saveTurn, type ModelAttempt } from '@/lib/chat-history';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { AI_MODELS, DEFAULT_MODEL_ID, type ModelProvider } from '@/lib/types';
import { chatSandboxConfigured, uploadFile as sandboxUploadFile, warmSandbox } from '@/lib/chat-sandbox';
import { parseMcpServerUrls } from '@/lib/mcp-client';
import { buildToolSet, browserRenderingConfigured, listServerTools, buildServerTools, type ToolSetConfig, type UploadedFileInfo } from '@/lib/chat-tools';

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
    mcpServers: mcpServerIds = [],
    userEmail,
    attachments = [],
    images = [],
    conversationId,
    turnIndex: rawTurnIndex,
  } = body as {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    provider?: ModelProvider;
    mcpServers?: string[];
    userEmail?: string;
    attachments?: Array<{ name: string; contentBase64: string }>;
    /** Pasted screenshots as data URLs, attached to the latest user turn. */
    images?: string[];
    /** Per-conversation id — Auto Router session affinity, tracing session and history key. */
    conversationId?: string;
    /** Position of this turn in the conversation; a resend at the same position replaces it in history. */
    turnIndex?: number;
    /** Code Mode comparison example — the only request-level Code Mode override. */
    experiment?: { id?: unknown; codeMode?: unknown };
  };
  const rawExperiment = (body as { experiment?: { id?: unknown; codeMode?: unknown } }).experiment;
  const experiment =
    rawExperiment && typeof rawExperiment.id === 'string' && /^[\w-]{1,40}$/.test(rawExperiment.id) && typeof rawExperiment.codeMode === 'boolean'
      ? { id: rawExperiment.id, codeMode: rawExperiment.codeMode }
      : undefined;
  const turnIndex = Number.isInteger(rawTurnIndex) && (rawTurnIndex as number) >= 0 ? (rawTurnIndex as number) : 0;

  // Verified identity (Access JWT or signed login cookie). The userEmail in the
  // body is only a fallback for gateway analytics, never for history ownership.
  const user = await getRequestUser(request, env as any);
  const analyticsEmail = user?.email ?? userEmail;

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

  console.log('[Chat API] provider:', provider, 'model:', modelId, 'compat:', compatModelId, 'messages:', messages.length, 'experiment:', experiment?.id ?? 'none');

  // AI Gateway /compat — all providers through unified endpoint
  const accountId = (env as any).CF_ACCOUNT_ID || '5efa272dc28e4e3933324c44165b6dbe';
  const gatewayId = (env as any).AI_GATEWAY_ID || 'nkcf-gateway-01';
  const baseURL = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`;
  const aigToken = (env as any).CF_AIG_TOKEN;
  const cfApiToken = (env as any).CF_API_TOKEN;

  // Workers AI: CF_API_TOKEN as Authorization header
  // External providers: strip Authorization so AI Gateway uses stored credentials
  const isExternal = provider !== 'workers-ai';
  // AI Gateway metadata (five filterable keys). code_mode is the turn's mode on every
  // request — main model and subagents — so a filter on it keeps each run together.
  const gatewayMetadata = (codeMode: boolean) => buildGatewayMetadata({ email: analyticsEmail, codeMode, test: experiment?.id });

  // Sanitize SSE stream: some Workers AI models (e.g. llama-3.2-3b) return
  // delta.content as a number instead of string, causing AI_TypeValidationError.
  // This wrapper intercepts the response body and coerces content to string.
  // Auto Router reports the model it picked in response headers; captured here
  // and forwarded to the client as a `routed-model` event.
  let routedInfo: AutoRouting | null = null;
  // History: set once the request is fully parsed (only for a verified user).
  let recorder: TurnRecorder | null = null;
  // Which model call the next gateway request belongs to (for the history record).
  let currentAttempt = 'stream-1';
  // Gateway headers of the main model's latest request (attached to its chat span).
  let lastMainGateway: GatewayInfo | undefined;
  // When the main model's latest request went out: its chat span starts there, so
  // the span covers queueing and time to first token (start-step only arrives with
  // the first chunk).
  let mainRequestAt: number | null = null;

  function sanitizeSseFetch(url: RequestInfo | URL, init?: RequestInit, label?: string): Promise<Response> {
    const headers = new Headers(init?.headers as HeadersInit);
    if (isExternal) headers.delete('Authorization');
    const attempt = label ?? currentAttempt;
    const startedMs = recorder?.elapsed() ?? 0;
    if (!label) mainRequestAt = now();
    return fetch(url, { ...init, headers }).then((res) => {
      const routedModel = res.headers.get('cf-aig-routed-model');
      // Only the main model's routing is shown on the answer (subagents route on their own).
      if (routedModel && !label) routedInfo = parseRoutingHeaders(res.headers, (env as any).AUTO_ROUTER_ALLOWED_PROVIDERS);
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
      const gateway: GatewayInfo = {
        logId: res.headers.get('cf-aig-log-id'),
        cacheStatus: res.headers.get('cf-aig-cache-status'),
        ray: res.headers.get('cf-ray'),
        routedModel,
      };
      if (!label) lastMainGateway = gateway;
      // The active span here is the chat span wrapAISDK opened for this request.
      setActiveSpanAttributes({
        'aig.log_id': gateway.logId ?? '',
        'aig.cache_status': gateway.cacheStatus ?? '',
        'aig.ray': gateway.ray ?? '',
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

  // `label` set = a subagent's provider: its requests are recorded under that
  // label and don't overwrite the main model's gateway info.
  const makeProvider = (metadata: string, label?: string) =>
    createOpenAI({
      apiKey: isExternal ? 'aig-managed' : (cfApiToken || 'dummy'),
      baseURL,
      headers: {
        ...(aigToken ? { 'cf-aig-authorization': `Bearer ${aigToken}` } : {}),
        'cf-aig-metadata': metadata,
        ...autoRouterHeaders,
      },
      fetch: (url, init) => sanitizeSseFetch(url, init, label),
    });
  // Re-created with the turn's code_mode once the tool policy is known (below).
  let openai = makeProvider(gatewayMetadata(false));

  const useTools = modelSupportsTools(provider, modelId);
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

  // Cloudflare Agents tracing (production only; plain `ai` in next dev). Payloads
  // are recorded so the dashboard's session replay shows the whole turn.
  const ai = await getTracedAI({ storeContent: true });
  const traceConversationId = isValidConversationId(conversationId) ? conversationId : undefined;

  // Span events for the chat page (calls, tokens, timing). Events emitted before
  // the response stream starts (MCP connections, uploads) are queued and flushed first.
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const tracker = createChatSpanTracker({ model: compatModelId, traced: isTracingActive() });
  const pendingEvents: TraceEvent[] = [...tracker.start(0)];
  let liveController: ReadableStreamDefaultController | null = null;
  const emit = (e: TraceEvent) => {
    if (liveController) send(liveController, e as unknown as Record<string, unknown>);
    else pendingEvents.push(e);
  };

  // Harness tool policy: the user never toggles tools — the harness picks them,
  // the model decides what to call. Delegated servers run in a subagent.
  const allServers = parseMcpServerUrls((env as any).MCP_SERVER_URLS || '');
  let policy = resolveToolPolicy({ modelSupportsTools: false, bindings: { sandbox: false, loader: false, browser: false }, hasImages: false, servers: [] });
  const runCtx: RunContext = {
    env: env as any,
    ai,
    emit,
    now,
    conversationId: traceConversationId ?? 'none',
    storeContent: true,
    signal: request.signal ?? new AbortController().signal,
    agent: { name: 'main-chat', id: 'main-chat-demo' },
    traced: isTracingActive(),
    // Subagents run on the user's model and carry the turn's code_mode in the gateway metadata.
    languageModel: (functionId) => {
      const provider = makeProvider(gatewayMetadata(turnCodeMode(policy)), `subagent:${functionId}`);
      return { model: provider.chat(compatModelId), label: compatModelId, ...(skipMaxTokens ? {} : { maxOutputTokens: maxTokens }) };
    },
  };

  let tools: Record<string, any> | undefined;
  let sandboxToolsActive = false;
  let browserToolsActive = false;
  let dynamicWorkerActive = false;
  const uploadedFiles: UploadedFileInfo[] = [];
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
    // for every chat would burn instance slots on plain Q&A.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (chatSandboxConfigured(env as any) && (attachments.length > 0 || SANDBOX_HINT.test(lastUser))) {
      // Background work that can outlive the response: a Cloudflare trace span only,
      // never an in-app span (it could end after the stream closed and stay open).
      ctx.waitUntil(
        withToolSpan(
          {
            name: 'sandbox.warmup',
            callId: `warmup-${sandboxSessionId}`,
            input: { sandbox: sandboxSessionId },
            storeContent: false,
            agent: { name: 'main-chat', id: 'main-chat-demo' },
            ...(traceConversationId ? { conversationId: traceConversationId } : {}),
          },
          () => warmSandbox(env as any, sandboxSessionId),
        ),
      );
    }

    // Upload any attached CSV/XLSX into the sandbox before building the
    // tools, so executeCode's description can tell the model exactly where
    // to find them — the model can't discover files on its own inside the sandbox.
    if (chatSandboxConfigured(env as any)) {
      for (const att of attachments) {
        if (!att?.name || !att?.contentBase64) continue;
        const uploaded = await runTracedTool(runCtx, MAIN_ROOT_SPAN, 'sandbox.upload', { name: att.name }, () =>
          sandboxUploadFile(env as any, sandboxSessionId, att.name, att.contentBase64),
        );
        if (uploaded.path) {
          uploadedFiles.push({ name: att.name, path: uploaded.path });
        } else {
          console.error('[Chat API] File upload failed:', att.name, uploaded.error);
        }
      }
    }

    // Connected MCP servers and their tool counts decide direct vs subagent.
    const connected = allServers.filter((s) => mcpServerIds.includes(s.id));
    const listed = await Promise.all(
      connected.map(async (config) => {
        const list = await runTracedTool(runCtx, MAIN_ROOT_SPAN, `mcp.connect:${config.id}`, { server: config.id }, () =>
          listServerTools(env as any, sessionId, config),
        );
        return list ? { config, toolCount: list.length, toolNames: list.map((t) => t.name) } : null;
      }),
    );
    const servers = listed.filter((x): x is NonNullable<typeof x> => x !== null);
    policy = resolveToolPolicy({
      modelSupportsTools: true,
      bindings: { sandbox: chatSandboxConfigured(env as any), loader: Boolean((env as any).LOADER), browser: browserRenderingConfigured(env as any) },
      hasImages: validImages.length > 0,
      servers,
      experiment,
    });

    const toolConfig: ToolSetConfig = { sessionId, sandboxSessionId, edgeColo, uploadedFiles, mcpServerIds: policy.directServers };
    const built = await buildToolSet(env as any, toolConfig, validImages);
    tools = built.tools;
    sandboxToolsActive = built.sandboxToolsActive;
    browserToolsActive = built.browserToolsActive;
    dynamicWorkerActive = built.dynamicWorkerActive;

    for (const d of policy.delegated) {
      const entry = servers.find((x) => x.config.id === d.serverId)!;
      tools[d.toolName] = buildDelegateTool({
        server: entry.config,
        toolNames: entry.toolNames,
        ctx: runCtx,
        parentSpanId: MAIN_ROOT_SPAN,
        codeMode: d.codeMode,
        loadTools: async () => {
          const loaded = await runTracedTool(
            runCtx,
            MAIN_ROOT_SPAN,
            `mcp.tools:${d.serverId}${d.codeMode ? '#codemode' : ''}`,
            { server: d.serverId, codeMode: d.codeMode },
            () => buildServerTools(env as any, sessionId, entry.config, { codeMode: d.codeMode }),
          );
          if (!loaded) throw new Error(`${entry.config.name} 尚未連線或授權`);
          return loaded;
        },
      });
    }

    console.log('[Chat API] Tools registered:', Object.keys(tools).join(', '));
  }

  // The user's own base prompt (edited in the chat page) or the default; the
  // harness appends the safety rule and guidance for the tools it gave the model.
  const basePrompt = (user ? await (env as any).KV.get(systemPromptKey(user.email)).catch(() => null) : null) || DEFAULT_SYSTEM_PROMPT;
  const systemPrompt = composeSystemPrompt(basePrompt, {
    sandbox: sandboxToolsActive,
    browser: browserToolsActive,
    dynamicWorker: dynamicWorkerActive,
    delegate: policy.delegated.length > 0,
  });

  const codeModeUsed = turnCodeMode(policy);
  openai = makeProvider(gatewayMetadata(codeModeUsed));
  const telemetry = {
    isEnabled: true,
    functionId: 'main-chat',
    metadata: {
      agentId: 'main-chat-demo',
      ...(traceConversationId ? { conversationId: traceConversationId } : {}),
      model: compatModelId,
      turnIndex,
      ...(user ? { email: user.email } : {}),
      'app.code_mode': codeModeUsed,
      'app.experiment': experiment?.id ?? 'none',
      'app.tool_policy': JSON.stringify(policy),
    },
  };
  setActiveSpanAttributes({
    'app.code_mode': codeModeUsed,
    'app.experiment': experiment?.id ?? 'none',
    'app.turn_index': turnIndex,
    'app.user_email': analyticsEmail ?? 'unknown',
    'app.model': compatModelId,
    'app.tool_policy': JSON.stringify(policy),
  });

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
        toolPolicy: policy,
        experiment: experiment ?? null,
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
    // Paused while tools execute: a delegate tool's subagent can take minutes
    // without the main stream sending a single part.
    const idle = createIdleGuard(IDLE_MS, () => ac.abort(new Error('idle')));
    // Stop / closed tab: stop the model too (and through the tools' abortSignal, any subagent).
    const onClientAbort = () => ac.abort(new Error('client aborted'));
    request.signal?.addEventListener('abort', onClientAbort, { once: true });
    const bump = (part: { type: string; toolCallId?: unknown }) => idle.onPart(part);
    const done = () => {
      clearTimeout(hardCap);
      idle.stop();
      request.signal?.removeEventListener('abort', onClientAbort);
    };
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

  let sentError = false;
  function send(controller: ReadableStreamDefaultController, data: Record<string, unknown>) {
    // Every event the browser sees also goes into the history record.
    recorder?.onEvent(data as { type: string });
    if (data.type === 'error') sentError = true;
    try {
      controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
    } catch {
      // Controller already closed — ignore
    }
  }

  // Main-model stream parts → span events (step = chat span, tool call = tool span).
  function traceParts(controller: ReadableStreamDefaultController, part: { type: string }) {
    const gateway = part.type === 'finish-step' ? lastMainGateway : undefined;
    let t = now();
    if (part.type === 'start-step' && mainRequestAt !== null) {
      t = mainRequestAt;
      mainRequestAt = null;
    }
    for (const e of tracker.onPart(part as { type: string; [k: string]: unknown }, t, gateway)) {
      send(controller, e as unknown as Record<string, unknown>);
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
      bump(part as { type: string; toolCallId?: unknown });
      traceParts(controller, part);
      if (routedInfo && !routedSent) {
        routedSent = true;
        send(controller, { type: 'routed-model', ...(routedInfo as AutoRouting) });
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
      system: composeSystemPrompt(basePrompt, { sandbox: false, browser: false, dynamicWorker: false, delegate: false }),
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
      traceParts(controller, part);
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
      // After the response closed, so it is a Cloudflare trace span only (no NDJSON event).
      const record = recorder.finish();
      await withToolSpan(
        {
          name: 'history.save',
          callId: `history-${record.conversationId}-${record.turnIndex}`,
          input: { conversationId: record.conversationId, turnIndex: record.turnIndex },
          storeContent: false,
          agent: { name: 'main-chat', id: 'main-chat-demo' },
          conversationId: record.conversationId,
        },
        () => saveTurn(env as any, record, validImages),
      );
    } catch (err) {
      console.error('[Chat API] history save failed:', (err as Error)?.message ?? err);
    } finally {
      historySaved();
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      liveController = controller;
      for (const e of pendingEvents.splice(0)) send(controller, e as unknown as Record<string, unknown>);
      try {
        // Step 1: Normal stream with tools
        insideThink = false;
        thinkBuffer = '';
        const firstResult = await processStream(controller, 1);

        // A client that went away gets no retries (nobody would see them).
        let resolved = firstResult.hasTextContent || firstResult.hasError || Boolean(request.signal?.aborted);

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
        const clientGone = Boolean(request.signal?.aborted || recorder?.clientGone);
        for (const e of tracker.end(now(), clientGone ? 'aborted' : sentError ? 'error' : 'ok')) {
          send(controller, e as unknown as Record<string, unknown>);
        }
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
