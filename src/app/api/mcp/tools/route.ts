import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { parseMcpServerUrls, connectAndListTools, type McpToolInfo } from '@/lib/mcp-client';
import { mcpTokenKey, mcpToolCacheKey } from '@/lib/mcp-auth';

export async function GET() {
  const { env } = await getCloudflareContext();
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('session_id')?.value || 'anonymous';
  const kv = (env as any).KV as KVNamespace;

  const servers = parseMcpServerUrls((env as any).MCP_SERVER_URLS || '');
  const allTools: McpToolInfo[] = [];
  const serverStatuses: Array<{ id: string; name: string; connected: boolean; toolCount: number; error?: string }> = [];

  for (const server of servers) {
    // Try cached tools first
    const cached = await kv.get(mcpToolCacheKey(sessionId, server.id));
    if (cached) {
      const tools = JSON.parse(cached) as McpToolInfo[];
      allTools.push(...tools);
      serverStatuses.push({ id: server.id, name: server.name, connected: true, toolCount: tools.length });
      continue;
    }

    // Get access token for OAuth servers
    let accessToken: string | undefined;
    if (server.authType === 'oauth') {
      const tokenDataRaw = await kv.get(mcpTokenKey(sessionId, server.id));
      if (!tokenDataRaw) {
        serverStatuses.push({ id: server.id, name: server.name, connected: false, toolCount: 0, error: '需要認證' });
        continue;
      }
      const tokenData = JSON.parse(tokenDataRaw) as { accessToken: string };
      accessToken = tokenData.accessToken;
    }

    // Connect and discover tools
    const result = await connectAndListTools(server, accessToken);
    if (result.success) {
      allTools.push(...result.tools);
      // Cache tools
      await kv.put(mcpToolCacheKey(sessionId, server.id), JSON.stringify(result.tools), { expirationTtl: 300 });
      serverStatuses.push({ id: server.id, name: server.name, connected: true, toolCount: result.tools.length });
    } else {
      serverStatuses.push({ id: server.id, name: server.name, connected: false, toolCount: 0, error: result.error });
    }
  }

  return Response.json({ tools: allTools, servers: serverStatuses });
}
