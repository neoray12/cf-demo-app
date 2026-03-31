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

  const accountId = (env as any).CF_ACCOUNT_ID as string;
  const apiToken = (env as any).CF_API_TOKEN as string;

  // Fetch all objects with this prefix from CF REST API
  const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects`);
  url.searchParams.set('per_page', '1000');
  if (prefix) url.searchParams.set('prefix', prefix);
  if (cursor) url.searchParams.set('cursor', cursor);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    return Response.json({ error: `CF API error ${response.status}: ${text}` }, { status: response.status });
  }

  const data = await response.json() as any;
  const objects: Array<{ key: string; last_modified: string; size: number }> = data.result ?? [];

  // Simulate S3 delimiter='/' behaviour: extract folders and direct files
  const folderSet = new Set<string>();
  const files: Array<{ key: string; lastModified: string; size: number }> = [];

  for (const obj of objects) {
    const suffix = obj.key.slice(prefix.length); // part after the current prefix
    if (!suffix) continue;
    const slashIdx = suffix.indexOf('/');
    if (slashIdx === -1) {
      // Direct file at this level
      files.push({ key: obj.key, lastModified: obj.last_modified, size: obj.size });
    } else {
      // Belongs to a subfolder — record the folder prefix
      folderSet.add(prefix + suffix.slice(0, slashIdx + 1));
    }
  }

  const folders = Array.from(folderSet);
  const truncated = !!(data.result_info?.cursor);
  const nextCursor = data.result_info?.cursor ?? null;

  return Response.json({ folders, files, truncated, cursor: nextCursor });
}
