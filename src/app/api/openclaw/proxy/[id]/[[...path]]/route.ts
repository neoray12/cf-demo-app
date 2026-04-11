import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { OpenClawInstance } from '../../../instances/route';

const KV_PREFIX = 'openclaw:';

/**
 * Proxy requests to the OpenClaw sandbox container via companion worker.
 * Verifies instance ownership before forwarding.
 *
 * Route: /api/openclaw/proxy/[id]/[[...path]]
 * Example: /api/openclaw/proxy/oc_abc123 → companion /api/proxy/oc_abc123/
 * Example: /api/openclaw/proxy/oc_abc123/api/status → companion /api/proxy/oc_abc123/api/status
 */
async function proxyToSandbox(request: Request, id: string, subpath: string) {
  try {
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
    // Remove host header to avoid mismatches
    proxyHeaders.delete('host');
    // Request uncompressed response — Node.js fetch doesn't auto-decompress
    proxyHeaders.set('accept-encoding', 'identity');

    const isWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if (isWebSocket) {
      // For WebSocket, forward as-is to companion worker
      const wsRequest = new Request(targetUrl.toString(), {
        headers: proxyHeaders,
      });
      return fetch(wsRequest);
    }

    // HTTP proxy — use long timeout because container may need cold-start wake-up
    const proxyRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: proxyHeaders,
      body: request.body,
      signal: AbortSignal.timeout(120_000), // 2 min for container wake-up
    } as RequestInit);

    const upstreamRes = await fetch(proxyRequest);

    // Strip headers that block embedding and fix encoding
    const responseHeaders = new Headers(upstreamRes.headers);
    responseHeaders.delete('x-frame-options');
    responseHeaders.delete('content-security-policy');
    responseHeaders.delete('content-security-policy-report-only');
    // fetch() auto-decompresses; remove stale encoding/length headers
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');

    // For HTML responses, inject <base> tag so relative asset paths
    // (e.g. ./assets/index.js) resolve to /api/openclaw/proxy/{id}/assets/...
    const contentType = responseHeaders.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const html = await upstreamRes.text();
      const baseTag = `<base href="/api/openclaw/proxy/${id}/">`;
      const patched = html.replace(/<head([^>]*)>/, `<head$1>${baseTag}`);
      return new Response(patched, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: responseHeaders,
      });
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('[PROXY ERROR]', id, subpath, error);
    return Response.json(
      { error: 'Proxy error', details: (error as Error).message },
      { status: 502 }
    );
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, (path || []).join('/'));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, (path || []).join('/'));
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, (path || []).join('/'));
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, (path || []).join('/'));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; path?: string[] }> }
) {
  const { id, path } = await params;
  return proxyToSandbox(request, id, (path || []).join('/'));
}
