import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

const BR_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

const VALID_ENDPOINTS = [
  'content', 'screenshot', 'pdf', 'markdown',
  'snapshot', 'scrape', 'json', 'links', 'crawl',
];

// ── GET: poll crawl job status / fetch results ──

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ endpoint: string }> }
) {
  const { endpoint } = await params;
  if (endpoint !== 'crawl') {
    return Response.json({ error: 'GET only supported for /crawl' }, { status: 400 });
  }

  const { env } = await getCloudflareContext();
  const accountId = (env as any).CF_ACCOUNT_ID as string;
  const apiToken = (env as any).CF_API_TOKEN as string;

  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get('jobId');
  if (!jobId) {
    return Response.json({ error: 'jobId is required' }, { status: 400 });
  }

  // Build query string for CF API
  const cfParams = new URLSearchParams();
  const status = searchParams.get('status');
  const cursor = searchParams.get('cursor');
  const limit = searchParams.get('limit');
  if (status) cfParams.set('status', status);
  if (cursor) cfParams.set('cursor', cursor);
  if (limit) cfParams.set('limit', limit);

  const qs = cfParams.toString() ? `?${cfParams.toString()}` : '';
  const res = await fetch(
    `${BR_API_BASE}/${accountId}/browser-rendering/crawl/${jobId}${qs}`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  );

  const data = await res.json();
  return Response.json(data, { status: res.status });
}

// ── POST: initiate browser rendering tasks ──

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

  const accountId = (env as any).CF_ACCOUNT_ID as string;
  const apiToken = (env as any).CF_API_TOKEN as string;
  const body = await request.text();
  const brUrl = `${BR_API_BASE}/${accountId}/browser-rendering/${endpoint}`;

  const brResponse = await fetch(brUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
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

  // /crawl: POST just returns the job ID — frontend polls via GET
  if (endpoint === 'crawl') {
    const crawlData = await brResponse.json() as { success?: boolean; result?: string; errors?: any[] };
    if (!crawlData.success || !crawlData.result) {
      return Response.json(
        { error: 'Failed to start crawl job', details: crawlData },
        { status: brResponse.status }
      );
    }
    return Response.json({ jobId: crawlData.result });
  }

  // For JSON responses, pass through
  const responseData = await brResponse.text();
  return new Response(responseData, {
    status: brResponse.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
