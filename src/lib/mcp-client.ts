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

// Parse MCP_SERVER_URLS env var
// Format: id=url or id=url:oauth
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
      let authType: 'none' | 'oauth' = 'none';
      if (url.endsWith(':oauth')) {
        authType = 'oauth';
        url = url.slice(0, -6);
      }
      const name = SERVER_LABELS[id]?.name ?? id;
      const description = SERVER_LABELS[id]?.description ?? '';
      return { id, url, name, description, authType };
    })
    .filter(Boolean) as McpServerConfig[];
}

// Default labels for known servers
const SERVER_LABELS: Record<string, { name: string; description: string }> = {
  'cf-docs': { name: 'Cloudflare Docs', description: '取得 Cloudflare 最新的技術文件與參考資料' },
  'cf-observability': { name: 'Workers Observability', description: '偵錯並取得應用程式日誌與分析' },
  'cf-radar': { name: 'Radar', description: '取得全球網路流量洞察與趨勢' },
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
      const error = err as { code?: number; message?: string };
      // 401 means OAuth required
      if (error.code === 401 || (error.message && error.message.includes('401'))) {
        return { success: false, tools: [], requiresAuth: true };
      }
      // Try SSE transport as fallback
      try {
        const sseTransport = new SSEClientTransport(
          new URL(server.url),
          { requestInit: { headers } },
        );
        await client.connect(sseTransport);
        connected = true;
      } catch (sseErr: unknown) {
        const sseError = sseErr as { code?: number; message?: string };
        if (sseError.code === 401 || (sseError.message && sseError.message.includes('401'))) {
          return { success: false, tools: [], requiresAuth: true };
        }
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
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
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

  const result = await client.callTool({ name: toolName, arguments: args });
  await client.close();

  return {
    content: (result.content || []) as Array<{ type: string; text?: string }>,
    isError: result.isError as boolean | undefined,
  };
}
