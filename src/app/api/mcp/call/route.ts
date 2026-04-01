import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { parseMcpServerUrls, callMcpTool } from '@/lib/mcp-client';
import { mcpTokenKey } from '@/lib/mcp-auth';

export async function POST(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { serverId, toolName, args } = (await request.json()) as {
    serverId: string;
    toolName: string;
    args: Record<string, unknown>;
  };

  if (!serverId || !toolName) {
    return Response.json({ error: 'serverId and toolName are required' }, { status: 400 });
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
      return Response.json(
        { error: 'Token 已過期，請重新認證。', requiresAuth: true },
        { status: 401 },
      );
    }
    accessToken = tokenData.accessToken;
  }

  try {
    const result = await callMcpTool(server, toolName, args || {}, accessToken);
    return Response.json({ result });
  } catch (err) {
    console.error(`[MCP Call] Error calling ${toolName} on ${serverId}:`, err);
    return Response.json(
      { error: `工具執行失敗: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
