/**
 * MCP Client wrapper for connecting to remote MCP servers
 * Uses @modelcontextprotocol/sdk with Streamable HTTP transport
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export interface McpServerConfig {
  id: string;
  url: string;
  name: string;
  description: string;
  authType: 'none' | 'oauth';
  /** `:agent` — always run this server's tools in a subagent (the harness also does it for big servers). */
  delegate: boolean;
  /** `:codemode` — the developer chose the Portal's Code Mode interface (?codemode=search_and_execute). */
  codeMode: boolean;
}

/** A portal URL switched to its Code Mode interface (search + execute tools only). */
export function portalCodeModeUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}codemode=search_and_execute`;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  serverId: string;
  serverName: string;
}

export interface McpConnectionResult {
  success: boolean;
  tools: McpToolInfo[];
  error?: string;
  requiresAuth?: boolean;
}

const URL_FLAGS = [':oauth', ':agent', ':codemode'] as const;

// Parse MCP_SERVER_URLS env var
// Format: id=url[:oauth][:agent][:codemode] (flags in any order)
// Display name and description from optional SERVER_LABELS
export function parseMcpServerUrls(raw: string): McpServerConfig[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq === -1) return null;
      const id = entry.slice(0, eq).trim();
      let url = entry.slice(eq + 1).trim();
      const flags = new Set<string>();
      for (let flag = URL_FLAGS.find((f) => url.endsWith(f)); flag; flag = URL_FLAGS.find((f) => url.endsWith(f))) {
        flags.add(flag);
        url = url.slice(0, -flag.length);
      }
      const name = SERVER_LABELS[id]?.name ?? id;
      const description = SERVER_LABELS[id]?.description ?? '';
      return {
        id,
        url,
        name,
        description,
        authType: flags.has(':oauth') ? 'oauth' : 'none',
        delegate: flags.has(':agent'),
        codeMode: flags.has(':codemode'),
      };
    })
    .filter(Boolean) as McpServerConfig[];
}

// Default labels for known servers
const SERVER_LABELS: Record<string, { name: string; description: string }> = {
  'cf-docs': { name: 'Cloudflare Docs', description: '取得 Cloudflare 最新的技術文件與參考資料' },
  'cf-observability': { name: 'Workers Observability', description: '偵錯並取得應用程式日誌與分析' },
  'cf-radar': { name: 'Radar', description: '取得全球網路流量洞察與趨勢' },
  'saas': { name: 'SAP & Salesforce', description: '透過 MCP Server Portal 連接 SAP 與 Salesforce（由專屬 subagent 執行）' },
};

/**
 * Connect to an MCP server and list available tools.
 * For OAuth servers, pass the access token.
 * Returns tools list or an error indicating auth is needed.
 */
export async function connectAndListTools(
  server: McpServerConfig,
  accessToken?: string,
): Promise<McpConnectionResult> {
  try {
    const headers: Record<string, string> = {};
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const client = new Client(
      { name: 'cf-demo-agent', version: '1.0.0' },
      { capabilities: {} },
    );

    // Try Streamable HTTP first, fall back to SSE
    let connected = false;
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(server.url),
        { requestInit: { headers } },
      );
      await client.connect(transport);
      connected = true;
    } catch (err: unknown) {
      const error = err as { code?: number; message?: string; status?: number };
      // 401 means OAuth required
      const is401 = error.code === 401 || error.status === 401 || (error.message && error.message.includes('401'));
      if (is401) {
        console.error(`[MCP] StreamableHTTP 401 for ${server.id}:`, JSON.stringify(error));
        return { success: false, tools: [], requiresAuth: true };
      }
      console.error(`[MCP] StreamableHTTP non-401 error for ${server.id}:`, JSON.stringify(error));
      // Try SSE transport as fallback
      try {
        const sseTransport = new SSEClientTransport(
          new URL(server.url),
          { requestInit: { headers } },
        );
        await client.connect(sseTransport);
        connected = true;
      } catch (sseErr: unknown) {
        const sseError = sseErr as { code?: number; message?: string; status?: number };
        const sseIs401 = sseError.code === 401 || sseError.status === 401 || (sseError.message && sseError.message.includes('401'));
        if (sseIs401) {
          console.error(`[MCP] SSE 401 for ${server.id}:`, JSON.stringify(sseError));
          return { success: false, tools: [], requiresAuth: true };
        }
        console.error(`[MCP] SSE non-401 error for ${server.id}:`, JSON.stringify(sseError));
        throw sseErr;
      }
    }

    if (!connected) {
      return { success: false, tools: [], error: 'Failed to connect' };
    }

    const toolsResult = await client.listTools();
    const tools: McpToolInfo[] = (toolsResult.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      serverId: server.id,
      serverName: server.name,
    }));

    await client.close();
    return { success: true, tools };
  } catch (err) {
    console.error(`[MCP Client] Error connecting to ${server.id}:`, err);
    return {
      success: false,
      tools: [],
      error: `連線失敗: ${(err as Error).message || String(err)}`,
    };
  }
}

/**
 * Call a tool on a remote MCP server.
 */
export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  accessToken?: string,
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const client = new Client(
    { name: 'cf-demo-agent', version: '1.0.0' },
    { capabilities: {} },
  );

  // Try Streamable HTTP first, fall back to SSE
  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(server.url),
      { requestInit: { headers } },
    );
    await client.connect(transport);
  } catch {
    const sseTransport = new SSEClientTransport(
      new URL(server.url),
      { requestInit: { headers } },
    );
    await client.connect(sseTransport);
  }

  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return {
      content: (result.content || []) as Array<{ type: string; text?: string }>,
      isError: result.isError as boolean | undefined,
      structuredContent: result.structuredContent as Record<string, unknown> | undefined,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
  serverId: string;
  serverName: string;
}

async function connectClient(server: McpServerConfig, accessToken?: string): Promise<Client> {
  const headers: Record<string, string> = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const client = new Client({ name: 'cf-demo-agent', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
  } catch {
    await client.connect(new SSEClientTransport(new URL(server.url), { requestInit: { headers } }));
  }
  return client;
}

/**
 * List the prompts a remote MCP server offers. Servers that do not declare the
 * `prompts` capability return an empty list instead of an error.
 */
export async function listMcpPrompts(server: McpServerConfig, accessToken?: string): Promise<McpPromptInfo[]> {
  const client = await connectClient(server, accessToken);
  try {
    if (!client.getServerCapabilities()?.prompts) return [];
    const result = await client.listPrompts();
    return (result.prompts || []).map((p) => ({
      name: p.name,
      title: p.title,
      description: p.description,
      arguments: p.arguments?.map((a) => ({ name: a.name, description: a.description, required: a.required })),
      serverId: server.id,
      serverName: server.name,
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Expand a prompt into plain text. Only text content is kept; `skipped` counts
 * image/audio/resource blocks that cannot be shown in a text input.
 */
export async function getMcpPrompt(
  server: McpServerConfig,
  name: string,
  args: Record<string, string>,
  accessToken?: string,
): Promise<{ description?: string; text: string; skipped: number }> {
  const client = await connectClient(server, accessToken);
  try {
    const result = await client.getPrompt({ name, arguments: args });
    let skipped = 0;
    const parts: string[] = [];
    for (const m of result.messages || []) {
      if (m.content.type === 'text') parts.push(m.content.text);
      else skipped++;
    }
    return { description: result.description, text: parts.join('\n\n'), skipped };
  } finally {
    await client.close().catch(() => {});
  }
}
