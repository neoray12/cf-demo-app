import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function GET(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { searchParams } = new URL(request.url);
  const bucket = searchParams.get('bucket');
  const prefix = searchParams.get('prefix') || '';
  const cursor = searchParams.get('cursor') || undefined;

  if (!bucket) {
    return Response.json({ error: 'bucket parameter required' }, { status: 400 });
  }

  // Use S3-compatible API to list objects in any bucket
  const s3Url = new URL(`https://${(env as any).CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}`);
  s3Url.searchParams.set('list-type', '2');
  s3Url.searchParams.set('delimiter', '/');
  if (prefix) s3Url.searchParams.set('prefix', prefix);
  if (cursor) s3Url.searchParams.set('continuation-token', cursor);
  s3Url.searchParams.set('max-keys', '100');

  const response = await fetch(s3Url.toString(), {
    headers: { Authorization: `Bearer ${(env as any).CF_API_TOKEN}` },
  });

  if (!response.ok) {
    // Fallback: use Cloudflare API
    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${(env as any).CF_ACCOUNT_ID}/r2/buckets/${bucket}/objects?delimiter=/&prefix=${encodeURIComponent(prefix)}&per_page=100`;
    const apiResponse = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${(env as any).CF_API_TOKEN}` },
    });
    const data = await apiResponse.text();
    return new Response(data, {
      status: apiResponse.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const xmlText = await response.text();
  const folders = [...xmlText.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)].map((m) => m[1]!);
  const files = [...xmlText.matchAll(/<Contents><Key>([^<]+)<\/Key><LastModified>([^<]+)<\/LastModified><Size>([^<]+)<\/Size>[^]*?<\/Contents>/g)].map((m) => ({
    key: m[1]!,
    lastModified: m[2]!,
    size: parseInt(m[3]!, 10),
  }));

  const isTruncated = xmlText.includes('<IsTruncated>true</IsTruncated>');
  const nextToken = xmlText.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] || null;

  return Response.json({ folders, files, truncated: isTruncated, cursor: nextToken });
}
