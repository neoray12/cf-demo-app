import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

// Streams AI-captured screenshots from R2 back to the chat UI.
// Keys are written by the captureScreenshot chat tool under screenshots/.

export async function GET(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const key = new URL(request.url).searchParams.get('key');

  // Restrict to the screenshots/ prefix so this can't read arbitrary
  // crawler bucket objects (logs, saved crawls, etc.).
  if (!key || !key.startsWith('screenshots/') || key.includes('..')) {
    return Response.json({ error: 'Invalid key' }, { status: 400 });
  }

  const object = await (env as any).CRAWLER_BUCKET.get(key);
  if (!object) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/png',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
