import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function GET() {
  const { env } = await getCloudflareContext();
  const raw = (env as any).MCP_SERVER_URLS || '';
  const servers = raw
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean)
    .map((entry: string) => {
      const eq = entry.indexOf('=');
      if (eq === -1) return null;
      const id = entry.slice(0, eq).trim();
      const url = entry.slice(eq + 1).trim();
      return { id, url };
    })
    .filter(Boolean);

  return Response.json({ servers });
}
