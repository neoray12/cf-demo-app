import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { parseMcpServerUrls, connectAndListTools } from '@/lib/mcp-client';
import { mcpTokenKey, mcpToolCacheKey } from '@/lib/mcp-auth';

export async function POST(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { serverId } = (await request.json()) as { serverId: string };

  if (!serverId) {
    return Response.json({ error: 'serverId is required' }, { status: 400 });
  }

  const servers = parseMcpServerUrls((env as any).MCP_SERVER_URLS || '');
  const server = servers.find((s) => s.id === serverId);
  if (!server) {
    return Response.json({ error: `Server "${serverId}" not found` }, { status: 404 });
  }

  const cookieStore = await cookies();
  const sessionId = cookieStore.get('session_id')?.value || 'anonymous';
  const kv = (env as any).KV as KVNamespace;

  // Get access token for OAuth servers
  let accessToken: string | undefined;
  if (server.authType === 'oauth') {
    const tokenDataRaw = await kv.get(mcpTokenKey(sessionId, serverId));
    if (!tokenDataRaw) {
      return Response.json(
        { error: '尚未認證，請先完成 OAuth 認證。', requiresAuth: true },
        { status: 401 },
      );
    }
    const tokenData = JSON.parse(tokenDataRaw) as { accessToken: string; expiresAt: number | null };
    if (tokenData.expiresAt && Date.now() > tokenData.expiresAt) {
      await kv.delete(mcpTokenKey(sessionId, serverId));
      return Response.json(
        { error: 'Token 已過期，請重新認證。', requiresAuth: true, tokenCleared: true },
        { status: 401 },
      );
    }
    accessToken = tokenData.accessToken;
  }

  // Connect and list tools
  const result = await connectAndListTools(server, accessToken);

  if (result.requiresAuth) {
    // Token was stored but rejected by MCP server — clear it
    if (accessToken) {
      await kv.delete(mcpTokenKey(sessionId, serverId));
    }
    return Response.json(
      { error: 'Token 無效或已過期，請重新認證。', requiresAuth: true, tokenCleared: !!accessToken },
      { status: 401 },
    );
  }

  if (!result.success) {
    return Response.json(
      { error: result.error || '連線失敗' },
      { status: 502 },
    );
  }

  // Cache tools in KV (TTL: 5 minutes)
  await kv.put(
    mcpToolCacheKey(sessionId, serverId),
    JSON.stringify(result.tools),
    { expirationTtl: 300 },
  );

  return Response.json({
    connected: true,
    serverId,
    serverName: server.name,
    tools: result.tools,
  });
}
