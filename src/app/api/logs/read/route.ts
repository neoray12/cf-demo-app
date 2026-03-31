import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function GET(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { searchParams } = new URL(request.url);
  const bucket = searchParams.get('bucket');
  const key = searchParams.get('key');

  if (!bucket || !key) {
    return Response.json({ error: 'bucket and key parameters required' }, { status: 400 });
  }

  const s3Url = `https://${(env as any).CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
  const response = await fetch(s3Url, {
    headers: { Authorization: `Bearer ${(env as any).CF_API_TOKEN}` },
  });

  if (!response.ok) {
    return Response.json({ error: `Failed to fetch: ${response.status}` }, { status: response.status });
  }

  const isGzip = key.endsWith('.gz') || response.headers.get('Content-Encoding') === 'gzip';

  if (isGzip && response.body) {
    try {
      const ds = new DecompressionStream('gzip');
      const decompressed = response.body.pipeThrough(ds);
      const text = await new Response(decompressed).text();
      return Response.json({ content: text, compressed: true });
    } catch {
      const text = await response.text();
      return Response.json({ content: text, compressed: false });
    }
  }

  const text = await response.text();
  return Response.json({ content: text, compressed: false });
}
