import { z } from 'zod';
import { parseMcpServerUrls, connectAndListTools, callMcpTool, type McpToolInfo } from '@/lib/mcp-client';
import { mcpTokenKey, mcpToolCacheKey } from '@/lib/mcp-auth';
import { chatSandboxConfigured, executeCode as sandboxExecuteCode, createPreview as sandboxCreatePreview } from '@/lib/chat-sandbox';
import { normalizeCode } from '@/lib/codemode';

// Wrap tool execute to catch errors gracefully instead of crashing the stream
export function safeTool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (err) {
      console.error('[Chat API] Tool error:', err);
      return { error: `Tool execution failed: ${(err as Error).message || String(err)}` };
    }
  };
}

export function buildSearchKnowledgeTool(env: Record<string, unknown>) {
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

const EXECUTE_JS_TIMEOUT_MS = 10_000;

export function buildExecuteJsTool(env: Record<string, unknown>) {
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
                ${normalizeCode(code)}
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

export function browserRenderingConfigured(env: Record<string, unknown>): boolean {
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

export function buildScreenshotTool(env: Record<string, unknown>) {
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

export function buildReadWebPageTool(env: Record<string, unknown>) {
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

export interface UploadedFileInfo {
  name: string;
  path: string;
}

export function buildExecuteCodeTool(
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

export function buildWebPreviewTool(env: Record<string, unknown>, sessionId: string, edgeColo: string | null) {
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
export async function buildMcpTools(
  env: Record<string, unknown>,
  sessionId: string,
  serverIds: string[],
): Promise<Record<string, any>> {
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

/** Everything needed to rebuild the same tool set from any isolate. */
export interface ToolSetConfig {
  sessionId: string;
  sandboxSessionId: string;
  edgeColo: string | null;
  uploadedFiles: UploadedFileInfo[];
  mcpServerIds: string[];
}

export async function buildToolSet(env: Record<string, unknown>, cfg: ToolSetConfig) {
  const tools: Record<string, any> = { searchKnowledge: buildSearchKnowledgeTool(env) };
  let sandboxToolsActive = false;
  let browserToolsActive = false;
  let dynamicWorkerActive = false;

  // Sandbox tools — only when the companion worker is configured
  if (chatSandboxConfigured(env as any)) {
    tools.executeCode = buildExecuteCodeTool(env, cfg.sandboxSessionId, cfg.edgeColo, cfg.uploadedFiles);
    tools.createWebPreview = buildWebPreviewTool(env, cfg.sandboxSessionId, cfg.edgeColo);
    sandboxToolsActive = true;
  }

  // Dynamic Worker executeJs — only when the LOADER binding exists (open
  // beta; also absent in local dev if the dev proxy doesn't support it yet)
  if (env.LOADER) {
    tools.executeJs = buildExecuteJsTool(env);
    dynamicWorkerActive = true;
  }

  // Browser Rendering tools — screenshot + page reading via CF REST API
  if (browserRenderingConfigured(env)) {
    tools.captureScreenshot = buildScreenshotTool(env);
    tools.readWebPage = buildReadWebPageTool(env);
    browserToolsActive = true;
  }

  if (cfg.mcpServerIds.length > 0) {
    const mcpTools = await buildMcpTools(env, cfg.sessionId, cfg.mcpServerIds);
    Object.assign(tools, mcpTools);
    console.log(`[Chat API] Injected ${Object.keys(mcpTools).length} MCP tools from ${cfg.mcpServerIds.length} server(s)`);
  }

  return { tools, sandboxToolsActive, browserToolsActive, dynamicWorkerActive };
}
