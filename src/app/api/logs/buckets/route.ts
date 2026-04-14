import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function GET() {
  const { env } = await getCloudflareContext();
  const accountId = (env as any).CF_ACCOUNT_ID as string;
  const token = (env as any).CF_API_TOKEN as string;

  // The CF R2 API returns at most 20 buckets per page by default.
  // Paginate with cursor until all buckets are collected.
  const allBuckets: unknown[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`
    );
    url.searchParams.set('per_page', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await response.json()) as any;

    if (!data.success) {
      return Response.json(data);
    }

    const page: unknown[] = data.result?.buckets ?? [];
    allBuckets.push(...page);
    cursor = data.result?.cursor as string | undefined;
  } while (cursor);

  return Response.json({
    success: true,
    result: { buckets: allBuckets },
  });
}
