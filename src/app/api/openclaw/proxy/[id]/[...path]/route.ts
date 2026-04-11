import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { OpenClawInstance } from '../../../instances/route';

const KV_PREFIX = 'openclaw:';

/**
 * Proxy requests to the OpenClaw sandbox container via companion worker.
 * Verifies instance ownership before forwarding.
 *
 * Route: /api/openclaw/proxy/[id]/[...path]
 * Example: /api/openclaw/proxy/oc_abc123/api/status → companion /api/proxy/oc_abc123/api/status
 */
async function proxyToSandbox(request: Request, id: string, subpath: string) {
  const { env } = await getCloudflareContext();
  const kv = (env as any).KV as KVNamespace;
  const sandboxUrl = (env as any).OPENCLAW_SANDBOX_URL as string;
  const sandboxSecret = (env as any).OPENCLAW_SANDBOX_SECRET as string;

  if (!sandboxUrl || !sandboxSecret) {
    return Response.json({ error: 'Sandbox not configured' }, { status: 500 });
  }

  // Verify instance exists and is not deleted
  const raw = await kv.get(`${KV_PREFIX}${id}`);
  if (!raw) {
    return Response.json({ error: '實例不存在' }, { status: 404 });
  }

  const instance = JSON.parse(raw) as OpenClawInstance;
  if (instance.status === 'deleted') {
    return Response.json({ error: '實例已刪除' }, { status: 404 });
  }

  // Inject gateway token into the proxied request
  const targetUrl = new URL(`${sandboxUrl}/api/proxy/${id}/${subpath}`);
  const url = new URL(request.url);
  // Preserve original query string
  targetUrl.search = url.search;
  // Add gateway token
  if (!targetUrl.searchParams.has('token')) {
    targetUrl.searchParams.set('token', instance.gatewayToken);
  }

  // Build proxy request
  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set('Authorization', `Bearer ${sandboxSecret}`);

  const isWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  if (isWebSocket) {
    // For WebSocket, forward as-is to companion worker
    const wsRequest = new Request(targetUrl.toString(), {
      headers: proxyHeaders,
    });
    return fetch(wsRequest);
  }

  // HTTP proxy
  const proxyRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: proxyHeaders,
    body: request.body,
  });

  return fetch(proxyRequest);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, path.join('/'));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, path.join('/'));
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, path.join('/'));
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, path.join('/'));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, path.join('/'));
}
