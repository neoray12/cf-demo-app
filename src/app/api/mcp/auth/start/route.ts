import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { cookies } from 'next/headers';
import { parseMcpServerUrls } from '@/lib/mcp-client';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  mcpOAuthStateKey,
  discoverOAuthMetadata,
  registerClient,
} from '@/lib/mcp-auth';

export async function POST(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { serverId } = (await request.json()) as { serverId: string };

  if (!serverId) {
    return Response.json({ error: 'serverId is required' }, { status: 400 });
  }

  // Find server config
  const servers = parseMcpServerUrls((env as any).MCP_SERVER_URLS || '');
  const server = servers.find((s) => s.id === serverId);
  if (!server) {
    return Response.json({ error: `Server "${serverId}" not found` }, { status: 404 });
  }

  if (server.authType !== 'oauth') {
    return Response.json({ error: 'Server does not require authentication' }, { status: 400 });
  }

  // Discover OAuth metadata from MCP server
  const metadata = await discoverOAuthMetadata(server.url);
  if (!metadata) {
    return Response.json(
      { error: '無法取得 MCP server 的 OAuth 設定。請確認 server URL 正確且支援 OAuth。' },
      { status: 502 },
    );
  }

  // Generate PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Determine callback URL
  const origin = request.headers.get('origin') || request.headers.get('referer')?.replace(/\/[^/]*$/, '') || '';
  const callbackUrl = `${origin}/api/mcp/auth/callback`;

  // Dynamic Client Registration (if supported)
  let clientId = `cf-demo-agent-${serverId}`;
  if (metadata.registration_endpoint) {
    const registration = await registerClient(
      metadata.registration_endpoint,
      callbackUrl,
      'CF Demo Agent',
    );
    if (registration) {
      clientId = registration.client_id;
    }
  }

  // Store OAuth state in KV (TTL: 10 minutes)
  const cookieStore = await cookies();
  const sessionId = cookieStore.get('session_id')?.value || 'anonymous';
  const kv = (env as any).KV as KVNamespace;

  await kv.put(
    mcpOAuthStateKey(state),
    JSON.stringify({
      serverId,
      serverUrl: server.url,
      codeVerifier,
      clientId,
      callbackUrl,
      sessionId,
      tokenEndpoint: metadata.token_endpoint,
      resource: server.url,
      createdAt: Date.now(),
    }),
    { expirationTtl: 600 },
  );

  // Build authorization URL
  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', server.url);
  if (metadata.scopes_supported?.length) {
    authUrl.searchParams.set('scope', metadata.scopes_supported.join(' '));
  }

  return Response.json({ authUrl: authUrl.toString() });
}
