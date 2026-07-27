import { NextRequest } from 'next/server';
import { streamText, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { AI_MODELS, DEFAULT_MODEL_ID, type ModelProvider } from '@/lib/types';
import { parseMcpServerUrls, connectAndListTools, callMcpTool, type McpToolInfo } from '@/lib/mcp-client';
import { mcpTokenKey, mcpToolCacheKey } from '@/lib/mcp-auth';
import { chatSandboxConfigured, executeCode as sandboxExecuteCode, createPreview as sandboxCreatePreview, uploadFile as sandboxUploadFile } from '@/lib/chat-sandbox';
import { createCodeTool } from '@cloudflare/codemode/ai';
import { DynamicWorkerExecutor } from '@cloudflare/codemode';

const SYSTEM_PROMPT = `你是一個由 Cloudflare AI 驅動的智慧助理。你可以回答一般性問題，並提供有關 Cloudflare 產品與功能的資訊。

回答時請使用繁體中文，除非使用者使用其他語言提問。回答要精確、簡潔、直接，避免冗長的鋪陳和重複說明。優先給出結論，再補充必要細節。`;

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

// Detect Cloudflare Firewall for AI HTML block page and extract metadata
function extractFirewallFromHtml(html: string): { isFirewall: boolean; rayId: string | null; userIp: string | null } {
  if (!html.includes('<!DOCTYPE html') && !html.includes('<html')) return { isFirewall: false, rayId: null, userIp: null };
  const isBlock = /you have been blocked/i.test(html) || /cf-error-details/i.test(html);
  if (!isBlock) return { isFirewall: false, rayId: null, userIp: null };
  const rayMatch = html.match(/Cloudflare Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/);
  const ipMatch = html.match(/id="cf-footer-ip">([^<]+)</);
  return { isFirewall: true, rayId: rayMatch?.[1] || null, userIp: ipMatch?.[1] || null };
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

// Extra system prompt guidance when the sandbox tools are available
const SANDBOX_PROMPT = `

當問題需要精確計算（數學、統計、日期、資料處理）時，使用 executeCode 工具執行 Python 程式碼取得真實結果，不要憑空心算。當使用者要求製作或展示網頁時，使用 createWebPreview 工具產生預覽網址，並在回覆中附上該網址。當使用者上傳 CSV/XLSX 檔案時，使用 executeCode 搭配 pandas 讀取分析，沙箱已安裝 pandas、openpyxl、matplotlib；若適合可用 matplotlib 畫圖，圖表會直接顯示給使用者。`;

// Extra system prompt guidance when the Browser Rendering tools are available
const BROWSER_PROMPT = `

當使用者要求截圖某個網頁時，使用 captureScreenshot 工具，截圖會直接顯示在對話中。當使用者要求閱讀、摘要或分析某個網址的內容時，使用 readWebPage 工具取得網頁的 Markdown 內容再回答。網址必須包含 http:// 或 https:// 開頭。`;

// Extra system prompt guidance when the Dynamic Worker executeJs tool is available
const DYNAMIC_WORKER_PROMPT = `

當需要執行 JavaScript 程式碼（快速計算、字串處理、演算法示範）時，優先使用 executeJs 工具——它在毫秒級啟動的 V8 isolate 中執行。需要 Python、pandas、檔案或畫圖時才用 executeCode。executeJs 的沙箱完全禁止網路存取，fetch 會失敗，這是刻意的安全設計。`;

const EXECUTE_JS_TIMEOUT_MS = 10_000;

// System prompt override when Code Mode collapses everything into one tool
const CODE_MODE_PROMPT = `

目前為 Code Mode：你只有一個 codemode 工具。需要查資料、執行程式、截圖或其他操作時，寫一段 JavaScript async arrow function，在裡面呼叫 codemode 命名空間下的函式（工具描述中列出了可用的函式與型別），一次完成多個步驟後 return 結果。這比多輪工具呼叫更快也更省 token。`;

function buildExecuteJsTool(env: Record<string, unknown>) {
  return {
    description:
      '在 Cloudflare Dynamic Worker（V8 isolate，毫秒級啟動）中執行 JavaScript 程式碼。適用於快速計算、演算法、字串/JSON 處理。用 console.log() 輸出結果；也可以 return 一個值。沙箱無檔案系統且網路被封鎖——若使用者想看網路封鎖的效果，請實際執行含 fetch 的程式碼讓錯誤真實呈現，不要只用文字解釋。需要 Python/pandas/畫圖時請改用 executeCode。',
    inputSchema: z.object({
      code: z.string().describe('要執行的 JavaScript 程式碼，用 console.log() 輸出結果，可使用 await'),
    }),
    execute: safeTool(async ({ code }: { code: string }) => {
      console.log('[Chat API] executeJs:', code.length, 'chars');
      const loader = env.LOADER as {
        load: (opts: Record<string, unknown>) => { getEntrypoint: () => { fetch: (req: Request) => Promise<Response> } };
      };

      // Harness module: shadow console to capture logs, run user code in an
      // async IIFE, report logs/result/error as JSON. User code is embedded
      // verbatim — it runs inside its own isolate, so injection is contained
      // by design (that's the whole point of the sandbox).
      const harness = `
        export default {
          async fetch() {
            const logs = [];
            const console = {
              log: (...a) => logs.push(a.map((x) => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')),
              error: (...a) => logs.push('[error] ' + a.map(String).join(' ')),
              warn: (...a) => logs.push('[warn] ' + a.map(String).join(' ')),
            };
            let result = null, error = null;
            try {
              result = await (async () => {
                ${code}
              })();
            } catch (e) {
              error = String(e && e.stack ? e.message : e);
            }
            return Response.json({ logs, result: result === undefined ? null : result, error });
          },
        };
      `;

      const started = Date.now();
      const worker = loader.load({
        compatibilityDate: '2026-01-01',
        mainModule: 'main.js',
        modules: { 'main.js': harness },
        // No network egress: AI-generated code cannot call out. This is the
        // security demo — fetch() inside the sandbox fails.
        globalOutbound: null,
      });
      const res = await worker
        .getEntrypoint()
        .fetch(new Request('https://dynamic-worker.internal/', { signal: AbortSignal.timeout(EXECUTE_JS_TIMEOUT_MS) }));
      const executionMs = Date.now() - started;

      const data = (await res.json()) as { logs: string[]; result: unknown; error: string | null };
      const stdout = [
        ...data.logs,
        ...(data.result !== null && data.result !== undefined ? [`=> ${typeof data.result === 'object' ? JSON.stringify(data.result) : String(data.result)}`] : []),
      ].join('\n');

      return {
        code,
        language: 'javascript',
        success: !data.error,
        stdout,
        stderr: '',
        results: [],
        error: data.error,
        engine: 'dynamic-worker',
        executionMs,
        sandbox: null,
      };
    }),
  };
}

const BR_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const BR_TIMEOUT_MS = 30_000;
const READ_PAGE_MAX_CHARS = 8000;

function browserRenderingConfigured(env: Record<string, unknown>): boolean {
  return Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CRAWLER_BUCKET);
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildScreenshotTool(env: Record<string, unknown>) {
  return {
    description:
      '使用 Cloudflare Browser Rendering 對指定網址進行截圖，截圖會直接內嵌顯示在對話中。適用於使用者要求「截圖某個網站」或想看某網頁長什麼樣子時。網址必須以 http:// 或 https:// 開頭。',
    inputSchema: z.object({
      url: z.string().describe('要截圖的完整網址，必須含 http:// 或 https://'),
      fullPage: z.boolean().optional().default(false).describe('是否截取整頁（預設只截可視區域）'),
    }),
    execute: safeTool(async ({ url, fullPage }: { url: string; fullPage?: boolean }) => {
      console.log('[Chat API] captureScreenshot:', url, 'fullPage:', fullPage);
      if (!isValidHttpUrl(url)) {
        return { error: '無效的網址，必須以 http:// 或 https:// 開頭' };
      }
      const res = await fetch(
        `${BR_API_BASE}/${env.CF_ACCOUNT_ID}/browser-rendering/screenshot`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.CF_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url, screenshotOptions: { fullPage: Boolean(fullPage) } }),
          signal: AbortSignal.timeout(BR_TIMEOUT_MS),
        }
      );
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        return { error: `截圖失敗 (HTTP ${res.status}): ${detail}` };
      }
      const bytes = await res.arrayBuffer();
      // Store in R2 and hand the model a short URL — inlining the PNG as
      // base64 in the tool result would flood the model's context window.
      const key = `screenshots/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
      await (env.CRAWLER_BUCKET as R2Bucket).put(key, bytes, {
        httpMetadata: { contentType: 'image/png' },
      });
      return {
        imageUrl: `/api/crawler/screenshot?key=${encodeURIComponent(key)}`,
        sourceUrl: url,
        fullPage: Boolean(fullPage),
        sizeBytes: bytes.byteLength,
      };
    }),
  };
}

function buildReadWebPageTool(env: Record<string, unknown>) {
  return {
    description:
      '使用 Cloudflare Browser Rendering 讀取指定網址的內容並轉為 Markdown 文字。適用於使用者要求閱讀、摘要、翻譯或分析某個網頁內容時。網址必須以 http:// 或 https:// 開頭。',
    inputSchema: z.object({
      url: z.string().describe('要讀取的完整網址，必須含 http:// 或 https://'),
    }),
    execute: safeTool(async ({ url }: { url: string }) => {
      console.log('[Chat API] readWebPage:', url);
      if (!isValidHttpUrl(url)) {
        return { error: '無效的網址，必須以 http:// 或 https:// 開頭' };
      }
      const res = await fetch(
        `${BR_API_BASE}/${env.CF_ACCOUNT_ID}/browser-rendering/markdown`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.CF_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(BR_TIMEOUT_MS),
        }
      );
      const data = (await res.json()) as { success?: boolean; result?: string; errors?: unknown[] };
      if (!res.ok || !data.success || typeof data.result !== 'string') {
        return { error: `讀取網頁失敗 (HTTP ${res.status})` };
      }
      const truncated = data.result.length > READ_PAGE_MAX_CHARS;
      return {
        url,
        markdown: truncated ? data.result.slice(0, READ_PAGE_MAX_CHARS) : data.result,
        truncated,
      };
    }),
  };
}

interface UploadedFileInfo {
  name: string;
  path: string;
}

function buildExecuteCodeTool(
  env: Record<string, unknown>,
  sessionId: string,
  edgeColo: string | null,
  uploadedFiles: UploadedFileInfo[]
) {
  const filesNote = uploadedFiles.length
    ? `\n\n使用者已上傳以下檔案，可直接用 pandas 讀取：${uploadedFiles.map((f) => `${f.name} → ${f.path}`).join('；')}`
    : '';
  return {
    description:
      '在安全的沙箱環境中執行 Python 程式碼並回傳真實輸出。適用於數學計算、統計、日期運算、字串與資料處理等需要精確結果的問題。沙箱已安裝 pandas、openpyxl、matplotlib，可用於讀取 CSV/XLSX 並繪圖。程式碼必須用 print() 輸出文字結果；若用 matplotlib 畫圖，呼叫 plt.show() 讓圖表被擷取回傳。' +
      filesNote,
    inputSchema: z.object({
      code: z.string().describe('要執行的 Python 程式碼，必須用 print() 輸出最終結果'),
    }),
    execute: safeTool(async ({ code }: { code: string }) => {
      console.log('[Chat API] executeCode:', code.length, 'chars');
      const result = await sandboxExecuteCode(env as any, sessionId, code);
      // Echo the code back so the frontend result panel is self-contained
      return { code, ...result, edgeColo };
    }),
  };
}

function buildWebPreviewTool(env: Record<string, unknown>, sessionId: string, edgeColo: string | null) {
  return {
    description:
      '建立靜態網頁預覽。提供 HTML/CSS/JS 檔案內容，系統會部署到沙箱並回傳可點擊的預覽網址。適用於使用者要求製作網頁、展示 UI 範例時。入口檔案必須命名為 index.html。預覽網址是公開的，不要在網頁中放入任何機密資訊。',
    inputSchema: z.object({
      files: z
        .array(
          z.object({
            path: z.string().describe('檔案名稱，如 index.html、style.css、app.js'),
            content: z.string().describe('完整檔案內容'),
          })
        )
        .describe('網頁檔案清單，必須包含 index.html'),
      title: z.string().optional().describe('網頁標題'),
    }),
    execute: safeTool(
      async ({ files, title }: { files: Array<{ path: string; content: string }>; title?: string }) => {
        console.log('[Chat API] createWebPreview:', files.length, 'file(s)');
        const result = await sandboxCreatePreview(env as any, sessionId, files);
        if (result.error) return { error: result.error };
        return {
          url: result.url,
          title: title ?? 'Web Preview',
          fileCount: files.length,
          note: '預覽網址約 20 分鐘無流量後失效',
          sandbox: result.sandbox,
          edgeColo,
        };
      }
    ),
  };
}

// Build MCP tools from connected servers for injection into streamText
async function buildMcpTools(
  env: Record<string, unknown>,
  serverIds: string[],
): Promise<Record<string, any>> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('session_id')?.value || 'anonymous';
  const kv = env.KV as KVNamespace;
  const allServers = parseMcpServerUrls((env.MCP_SERVER_URLS as string) || '');

  const mcpTools: Record<string, any> = {};

  for (const serverId of serverIds) {
    const server = allServers.find((s) => s.id === serverId);
    if (!server) continue;

    // Try cached tools first
    let tools: McpToolInfo[] = [];
    const cached = await kv.get(mcpToolCacheKey(sessionId, serverId));
    if (cached) {
      tools = JSON.parse(cached) as McpToolInfo[];
    } else {
      // Get access token for OAuth servers
      let accessToken: string | undefined;
      if (server.authType === 'oauth') {
        const tokenDataRaw = await kv.get(mcpTokenKey(sessionId, serverId));
        if (!tokenDataRaw) continue; // Skip unauthenticated OAuth servers
        const tokenData = JSON.parse(tokenDataRaw) as { accessToken: string };
        accessToken = tokenData.accessToken;
      }
      const result = await connectAndListTools(server, accessToken);
      if (!result.success) continue;
      tools = result.tools;
      // Cache for next request
      await kv.put(mcpToolCacheKey(sessionId, serverId), JSON.stringify(tools), { expirationTtl: 300 });
    }

    // Convert each MCP tool to Vercel AI SDK tool format
    for (const tool of tools) {
      const toolKey = `tool_${serverId}_${tool.name}`;
      // Build zod-compatible schema description from MCP inputSchema
      const inputSchema = tool.inputSchema || {};
      const properties = (inputSchema as any).properties || {};
      const required = (inputSchema as any).required || [];

      // Build a zod object from the JSON Schema properties
      const zodShape: Record<string, any> = {};
      for (const [key, prop] of Object.entries(properties)) {
        const p = prop as { type?: string; description?: string };
        let zodField: any;
        switch (p.type) {
          case 'number':
          case 'integer':
            zodField = z.number();
            break;
          case 'boolean':
            zodField = z.boolean();
            break;
          case 'array':
            zodField = z.array(z.any());
            break;
          case 'object':
            zodField = z.record(z.string(), z.any());
            break;
          default:
            zodField = z.string();
        }
        if (p.description) zodField = zodField.describe(p.description);
        if (!required.includes(key)) zodField = zodField.optional();
        zodShape[key] = zodField;
      }

      mcpTools[toolKey] = {
        description: tool.description || `MCP tool: ${tool.name} (from ${server.name})`,
        inputSchema: z.object(zodShape),
        execute: safeTool(async (args: Record<string, unknown>) => {
          try {
            console.log(`[Chat API] MCP tool call: ${toolKey}`, args);
            let accessToken: string | undefined;
            if (server.authType === 'oauth') {
              const tokenDataRaw = await kv.get(mcpTokenKey(sessionId, serverId));
              if (tokenDataRaw) {
                accessToken = (JSON.parse(tokenDataRaw) as { accessToken: string }).accessToken;
              }
            }
            const result = await callMcpTool(server, tool.name, args, accessToken);
            const textParts = result.content
              .filter((c) => c.type === 'text' && c.text)
              .map((c) => c.text);
            return { source: server.name, result: textParts.join('\n') || JSON.stringify(result.content) };
          } catch (err) {
            console.error(`[Chat API] MCP tool error (${toolKey}):`, err);
            return { error: `MCP tool failed: ${(err as Error).message}` };
          }
        }),
      };
    }
  }

  return mcpTools;
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
  const { env, cf } = await getCloudflareContext();
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
    anthropic: 'claude-sonnet-4-6',
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
  // usertier: vera & kevin(menghsien) are VIP, others are regular
  const VIP_EMAILS = new Set(['vera@cloudflare.com', 'menghsien@cloudflare.com']);
  const usertier = userEmail && VIP_EMAILS.has(userEmail) ? 'VIP' : 'regular';

  // department: neo=技術, others=業務
  const TECH_EMAILS = new Set(['neo@cloudflare.com']);
  const department = userEmail && TECH_EMAILS.has(userEmail) ? '技術' : '業務';

  // Build metadata header for AI Gateway analytics
  // Use \uXXXX escape for non-ASCII chars (e.g. Chinese) to keep header Latin-1/ByteString safe
  // AI Gateway parses unicode escapes correctly — do NOT encodeURIComponent
  const metadataJson = JSON.stringify({
    tools_enabled: toolsEnabled,
    name: userName ?? 'anonymous',
    email: userEmail ?? 'unknown',
    usertier,
    department,
  }).replace(/[^\x20-\x7E]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

  // Sanitize SSE stream: some Workers AI models (e.g. llama-3.2-3b) return
  // delta.content as a number instead of string, causing AI_TypeValidationError.
  // This wrapper intercepts the response body and coerces content to string.
  function sanitizeSseFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers as HeadersInit);
    if (isExternal) headers.delete('Authorization');
    return fetch(url, { ...init, headers }).then((res) => {
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

  const openai = createOpenAI({
    apiKey: isExternal ? 'aig-managed' : (cfApiToken || 'dummy'),
    baseURL,
    headers: {
      ...(aigToken ? { 'cf-aig-authorization': `Bearer ${aigToken}` } : {}),
      'cf-aig-metadata': metadataJson,
    },
    fetch: sanitizeSseFetch,
  });

  const useTools = toolsEnabled && modelSupportsTools(provider, modelId);
  const chatMessages = sanitizeMessages(messages);

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
  if (useTools) {
    tools = { searchKnowledge: buildSearchKnowledgeTool(env as any) };

    // Sandbox tools — only when the companion worker is configured
    if (chatSandboxConfigured(env as any)) {
      const cookieStore = await cookies();
      const rawSessionId = cookieStore.get('session_id')?.value || 'anonymous';
      // Becomes a DNS label in preview URLs — keep it lowercase alphanumeric + hyphens,
      // and strip leading/trailing hyphens left by truncation (a UUID sliced to 24
      // chars always lands on a hyphen at position 23, e.g. "96cdf0dc-8565-4e63-8fbe-"
      // — the Sandbox SDK rejects IDs starting/ending with '-' as invalid DNS labels).
      const sanitizedSessionId = rawSessionId
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .slice(0, 24)
        .replace(/^-+|-+$/g, '');
      const sandboxSessionId = `sbx-${sanitizedSessionId || 'anon'}`;

      // Upload any attached CSV/XLSX into the sandbox before registering the
      // tool, so its description can tell the model exactly where to find
      // them — the model can't discover files on its own inside the sandbox.
      const uploadedFiles: UploadedFileInfo[] = [];
      for (const att of attachments) {
        if (!att?.name || !att?.contentBase64) continue;
        const uploaded = await sandboxUploadFile(env as any, sandboxSessionId, att.name, att.contentBase64);
        if (uploaded.path) {
          uploadedFiles.push({ name: att.name, path: uploaded.path });
        } else {
          console.error('[Chat API] File upload failed:', att.name, uploaded.error);
        }
      }

      tools.executeCode = buildExecuteCodeTool(env as any, sandboxSessionId, edgeColo, uploadedFiles);
      tools.createWebPreview = buildWebPreviewTool(env as any, sandboxSessionId, edgeColo);
      sandboxToolsActive = true;
    }

    // Dynamic Worker executeJs — only when the LOADER binding exists (open
    // beta; also absent in local dev if the dev proxy doesn't support it yet)
    if ((env as any).LOADER) {
      tools.executeJs = buildExecuteJsTool(env as any);
      dynamicWorkerActive = true;
    }

    // Browser Rendering tools — screenshot + page reading via CF REST API
    if (browserRenderingConfigured(env as any)) {
      tools.captureScreenshot = buildScreenshotTool(env as any);
      tools.readWebPage = buildReadWebPageTool(env as any);
      browserToolsActive = true;
    }

    // Inject MCP tools if any servers are specified
    if (mcpServerIds.length > 0) {
      const mcpTools = await buildMcpTools(env as any, mcpServerIds);
      Object.assign(tools, mcpTools);
      console.log(`[Chat API] Injected ${Object.keys(mcpTools).length} MCP tools from ${mcpServerIds.length} server(s)`);
    }

    // Code Mode: collapse the whole tool set into ONE tool — the model writes
    // a JS script that calls the other tools as functions inside a Dynamic
    // Worker, instead of stepping through multiple tool-call rounds. This is
    // the token-saving pattern Cloudflare's codemode SDK implements.
    if (codeMode && (env as any).LOADER) {
      // executeJs is redundant inside Code Mode (the script itself IS the JS)
      const { executeJs: _omitted, ...wrappedTools } = tools;
      const executor = new DynamicWorkerExecutor({ loader: (env as any).LOADER });
      tools = {
        codemode: createCodeTool({ tools: wrappedTools as any, executor }) as any,
      };
      codeModeActive = true;
      console.log(`[Chat API] Code Mode: wrapped ${Object.keys(wrappedTools).length} tool(s) into codemode`);
    }

    console.log('[Chat API] Tools registered:', Object.keys(tools).join(', '));
  }

  const systemPrompt = codeModeActive
    ? SYSTEM_PROMPT + CODE_MODE_PROMPT
    : SYSTEM_PROMPT +
      (sandboxToolsActive ? SANDBOX_PROMPT : '') +
      (browserToolsActive ? BROWSER_PROMPT : '') +
      (dynamicWorkerActive ? DYNAMIC_WORKER_PROMPT : '');

  function createStream(attempt: number) {
    return streamText({
      model: openai.chat(compatModelId),
      system: systemPrompt,
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
