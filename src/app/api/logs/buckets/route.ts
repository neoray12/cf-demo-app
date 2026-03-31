import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function GET() {
  const { env } = await getCloudflareContext();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${(env as any).CF_ACCOUNT_ID}/r2/buckets`,
    { headers: { Authorization: `Bearer ${(env as any).CF_API_TOKEN}` } }
  );
  const data = await response.json();
  return Response.json(data);
}
