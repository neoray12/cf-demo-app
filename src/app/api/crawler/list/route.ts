import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function GET(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { searchParams } = new URL(request.url);
  const prefix = searchParams.get('prefix') || 'crawled/';
  const cursor = searchParams.get('cursor') || undefined;

  const listed = await (env as any).CRAWLER_BUCKET.list({ prefix, limit: 50, cursor });
  const files = listed.objects.map((obj: any) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
    customMetadata: obj.customMetadata,
  }));

  return Response.json({
    files,
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : null,
  });
}
