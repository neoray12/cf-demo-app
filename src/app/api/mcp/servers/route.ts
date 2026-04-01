import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { parseMcpServerUrls } from '@/lib/mcp-client';
import { mcpTokenKey } from '@/lib/mcp-auth';

export async function GET() {
  const { env } = await getCloudflareContext();
  const raw = (env as any).MCP_SERVER_URLS || '';
  const servers = parseMcpServerUrls(raw);

  // Check auth status for each server from KV
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('session_id')?.value || 'anonymous';
  const kv = (env as any).KV as KVNamespace | undefined;

  const serversWithStatus = await Promise.all(
    servers.map(async (server) => {
      let connected = false;
      if (server.authType === 'oauth' && kv) {
        const tokenData = await kv.get(mcpTokenKey(sessionId, server.id));
        connected = !!tokenData;
      } else if (server.authType === 'none') {
        connected = true; // Public servers are always "connected"
      }
      return {
        id: server.id,
        url: server.url,
        name: server.name,
        description: server.description,
        authType: server.authType,
        connected,
      };
    }),
  );

  return Response.json({ servers: serversWithStatus });
}
