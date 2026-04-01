import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { mcpTokenKey, mcpToolCacheKey } from '@/lib/mcp-auth';

export async function POST(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { serverId } = (await request.json()) as { serverId: string };

  if (!serverId) {
    return Response.json({ error: 'serverId is required' }, { status: 400 });
  }

  const cookieStore = await cookies();
  const sessionId = cookieStore.get('session_id')?.value || 'anonymous';
  const kv = (env as any).KV as KVNamespace;

  // Delete token and cached tools from KV
  await Promise.all([
    kv.delete(mcpTokenKey(sessionId, serverId)),
    kv.delete(mcpToolCacheKey(sessionId, serverId)),
  ]);

  return Response.json({ disconnected: true, serverId });
}
