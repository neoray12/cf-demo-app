import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

const BR_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

const VALID_ENDPOINTS = [
  'content', 'screenshot', 'pdf', 'markdown',
  'snapshot', 'scrape', 'json', 'links', 'crawl',
];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ endpoint: string }> }
) {
  const { endpoint } = await params;
  const { env } = await getCloudflareContext();

  if (!VALID_ENDPOINTS.includes(endpoint)) {
    return new Response(
      JSON.stringify({ error: `Invalid endpoint: ${endpoint}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const body = await request.text();
  const brUrl = `${BR_API_BASE}/${(env as any).CF_ACCOUNT_ID}/browser-rendering/${endpoint}`;

  const brResponse = await fetch(brUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${(env as any).CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  // For binary responses (screenshot, pdf), pass through directly
  if (endpoint === 'screenshot' || endpoint === 'pdf') {
    return new Response(brResponse.body, {
      status: brResponse.status,
      headers: {
        'Content-Type': brResponse.headers.get('Content-Type') || 'application/octet-stream',
      },
    });
  }

  // For JSON responses, pass through
  const responseData = await brResponse.text();
  return new Response(responseData, {
    status: brResponse.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
