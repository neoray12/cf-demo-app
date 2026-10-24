import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { parseMcpServerUrls, listMcpPrompts, type McpPromptInfo } from '@/lib/mcp-client';
import { mcpPromptCacheKey, readMcpAccessToken } from '@/lib/mcp-auth';

// GET /api/mcp/prompts?servers=saas,cf-docs
// Lists prompts for the given (already connected) servers. Cached 5 minutes per
// session + server, like the tool list.
export async function GET(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('session_id')?.value || 'anonymous';
  const kv = (env as any).KV as KVNamespace;

  const wanted = new Set(
    (request.nextUrl.searchParams.get('servers') || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const servers = parseMcpServerUrls((env as any).MCP_SERVER_URLS || '').filter((s) => wanted.has(s.id));

  const results = await Promise.all(
    servers.map(async (server) => {
      const cached = await kv.get(mcpPromptCacheKey(sessionId, server.id));
      if (cached) return { id: server.id, prompts: JSON.parse(cached) as McpPromptInfo[] };

      const token = await readMcpAccessToken(kv, sessionId, server.id, server.authType);
      if (token.status !== 'ok') return { id: server.id, prompts: [] as McpPromptInfo[], error: '需要認證' };

      try {
        const prompts = await listMcpPrompts(server, token.accessToken);
        await kv.put(mcpPromptCacheKey(sessionId, server.id), JSON.stringify(prompts), { expirationTtl: 300 });
        return { id: server.id, prompts };
      } catch (err) {
        console.error(`[MCP Prompts] list failed for ${server.id}:`, err);
        return { id: server.id, prompts: [] as McpPromptInfo[], error: (err as Error).message };
      }
    }),
  );

  return Response.json({
    prompts: results.flatMap((r) => r.prompts),
    errors: results.filter((r) => r.error).map((r) => ({ serverId: r.id, error: r.error })),
  });
}
