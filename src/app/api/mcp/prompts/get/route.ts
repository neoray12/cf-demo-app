import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { parseMcpServerUrls, getMcpPrompt } from '@/lib/mcp-client';
import { readMcpAccessToken } from '@/lib/mcp-auth';

// POST /api/mcp/prompts/get  { serverId, name, args }
// Expands a prompt into text for the chat input. Unlike prompts/list, prompts/get
// needs the user's token on servers that protect it.
export async function POST(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { serverId, name, args } = (await request.json()) as {
    serverId: string;
    name: string;
    args?: Record<string, unknown>;
  };

  if (!serverId || !name) {
    return Response.json({ error: 'serverId and name are required' }, { status: 400 });
  }

  const server = parseMcpServerUrls((env as any).MCP_SERVER_URLS || '').find((s) => s.id === serverId);
  if (!server) {
    return Response.json({ error: `Server "${serverId}" not found` }, { status: 404 });
  }

  const cookieStore = await cookies();
  const sessionId = cookieStore.get('session_id')?.value || 'anonymous';
  const kv = (env as any).KV as KVNamespace;

  const token = await readMcpAccessToken(kv, sessionId, serverId, server.authType);
  if (token.status === 'missing') {
    return Response.json({ error: '尚未認證，請先完成 OAuth 認證。', requiresAuth: true }, { status: 401 });
  }
  if (token.status === 'expired') {
    return Response.json({ error: 'Token 已過期，請重新認證。', requiresAuth: true }, { status: 401 });
  }

  // Prompt arguments are always strings in MCP; drop empty values.
  const stringArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (v !== undefined && v !== null && String(v).trim() !== '') stringArgs[k] = String(v);
  }

  try {
    const result = await getMcpPrompt(server, name, stringArgs, token.accessToken);
    return Response.json(result);
  } catch (err) {
    console.error(`[MCP Prompts] get "${name}" failed on ${serverId}:`, err);
    return Response.json({ error: `提示詞展開失敗: ${(err as Error).message}` }, { status: 502 });
  }
}
