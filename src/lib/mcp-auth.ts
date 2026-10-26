/**
 * MCP OAuth 2.1 PKCE utilities
 * Used for authenticating with OAuth-protected MCP servers
 */

// Generate a random code verifier (43-128 chars, unreserved URI chars)
export function generateCodeVerifier(length = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join('');
}

// Generate code challenge from verifier (S256)
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

// Generate a random state parameter
export function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// KV key helpers
export function mcpTokenKey(sessionId: string, serverId: string): string {
  return `mcp-token:${sessionId}:${serverId}`;
}

/** Long-lived refresh token (outlives the access token's KV entry), for approvals executed hours later. */
export function mcpRefreshKey(sessionId: string, serverId: string): string {
  return `mcp-refresh:${sessionId}:${serverId}`;
}

export const MCP_REFRESH_TTL_SECONDS = 14 * 24 * 3600;

export function mcpOAuthStateKey(state: string): string {
  return `mcp-oauth-state:${state}`;
}

export function mcpToolCacheKey(sessionId: string, serverId: string): string {
  return `mcp-tools:${sessionId}:${serverId}`;
}

export function mcpPromptCacheKey(sessionId: string, serverId: string): string {
  return `mcp-prompts:${sessionId}:${serverId}`;
}

export type McpTokenLookup =
  | { status: 'ok'; accessToken?: string }
  | { status: 'missing' }
  | { status: 'expired' };

/** Read the stored OAuth access token for a server (no-op for public servers). */
export async function readMcpAccessToken(
  kv: KVNamespace,
  sessionId: string,
  serverId: string,
  authType: 'none' | 'oauth',
): Promise<McpTokenLookup> {
  if (authType !== 'oauth') return { status: 'ok' };
  const raw = await kv.get(mcpTokenKey(sessionId, serverId));
  if (!raw) return { status: 'missing' };
  const data = JSON.parse(raw) as { accessToken: string; expiresAt: number | null };
  if (data.expiresAt && Date.now() > data.expiresAt) return { status: 'expired' };
  return { status: 'ok', accessToken: data.accessToken };
}

// OAuth metadata discovery
export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  resource?: string;
}

export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata | null> {
  const base = new URL(serverUrl);
  // RFC 9728: path-specific protected resource metadata URL
  // e.g. for /mcp → /.well-known/oauth-protected-resource/mcp
  const pathSuffix = base.pathname === '/' ? '' : base.pathname;

  // 1. Fetch path-specific protected resource metadata (preferred, from workers-oauth-provider)
  let resourceIdentifier: string | undefined;
  let externalAuthServerUrl: string | undefined;
  const pathSpecificUrl = `${base.origin}/.well-known/oauth-protected-resource${pathSuffix}`;
  try {
    const res = await fetch(pathSpecificUrl, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json() as { resource?: string; authorization_servers?: string[] };
      resourceIdentifier = data.resource;
      if (data.authorization_servers?.[0]) {
        externalAuthServerUrl = `${data.authorization_servers[0]}/.well-known/oauth-authorization-server`;
      }
    }
  } catch {
    // ignore
  }

  // 2. Fallback: root-level protected resource metadata
  if (!resourceIdentifier) {
    const rootUrl = `${base.origin}/.well-known/oauth-protected-resource`;
    try {
      const res = await fetch(rootUrl, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json() as { resource?: string; authorization_servers?: string[] };
        resourceIdentifier = data.resource || `${base.origin}${pathSuffix}`;
        if (!externalAuthServerUrl && data.authorization_servers?.[0]) {
          externalAuthServerUrl = `${data.authorization_servers[0]}/.well-known/oauth-authorization-server`;
        }
      }
    } catch {
      // ignore
    }
  }

  // Default resource to server URL (origin + path)
  if (!resourceIdentifier) {
    resourceIdentifier = `${base.origin}${pathSuffix}`;
  }

  // 3. Try the server's own /.well-known/oauth-authorization-server
  const wellKnownUrl = `${base.origin}/.well-known/oauth-authorization-server`;
  try {
    const res = await fetch(wellKnownUrl, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const meta = await res.json() as OAuthMetadata;
      return { ...meta, resource: resourceIdentifier };
    }
  } catch {
    // ignore
  }

  // 4. Try external authorization server (e.g. CF Access as IdP)
  if (externalAuthServerUrl) {
    try {
      const asRes = await fetch(externalAuthServerUrl, { headers: { Accept: 'application/json' } });
      if (asRes.ok) {
        const asMeta = await asRes.json() as OAuthMetadata;
        return { ...asMeta, resource: resourceIdentifier };
      }
    } catch {
      // ignore
    }
  }

  return null;
}

// Dynamic Client Registration (MCP spec requirement)
export interface ClientRegistration {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
}

export async function registerClient(
  registrationEndpoint: string,
  callbackUrl: string,
  clientName: string,
): Promise<ClientRegistration | null> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [callbackUrl],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (res.ok) {
      return await res.json() as ClientRegistration;
    }
  } catch {
    // Registration failed
  }
  return null;
}

// Token exchange
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export async function exchangeCodeForToken(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string,
  resource?: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  if (resource) {
    body.set('resource', resource);
  }

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${errorText}`);
  }

  return await res.json() as TokenResponse;
}

// Refresh token
export async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${errorText}`);
  }

  return await res.json() as TokenResponse;
}

/** Stores a token response the way the OAuth callback does, plus the long-lived refresh entry. */
export async function storeMcpTokens(
  kv: KVNamespace,
  sessionId: string,
  serverId: string,
  token: TokenResponse,
  client: { clientId: string; tokenEndpoint: string },
): Promise<void> {
  const ttl = token.expires_in ? Math.max(token.expires_in - 60, 300) : 3600;
  await kv.put(
    mcpTokenKey(sessionId, serverId),
    JSON.stringify({
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      tokenType: token.token_type,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
      clientId: client.clientId,
      tokenEndpoint: client.tokenEndpoint,
      serverId,
    }),
    { expirationTtl: ttl },
  );
  if (token.refresh_token) {
    await kv.put(
      mcpRefreshKey(sessionId, serverId),
      JSON.stringify({ refreshToken: token.refresh_token, clientId: client.clientId, tokenEndpoint: client.tokenEndpoint }),
      { expirationTtl: MCP_REFRESH_TTL_SECONDS },
    );
  }
}

/**
 * A usable access token for this session + server: the stored one while it is
 * valid, otherwise a new one from the refresh token. null = re-authorize.
 */
export async function getFreshAccessToken(kv: KVNamespace, sessionId: string, serverId: string): Promise<string | null> {
  const raw = await kv.get(mcpTokenKey(sessionId, serverId));
  if (raw) {
    const t = JSON.parse(raw) as { accessToken: string; expiresAt: number | null };
    if (!t.expiresAt || t.expiresAt > Date.now() + 30_000) return t.accessToken;
  }
  const refreshRaw = await kv.get(mcpRefreshKey(sessionId, serverId));
  if (!refreshRaw) return null;
  const r = JSON.parse(refreshRaw) as { refreshToken: string; clientId: string; tokenEndpoint: string };
  const token = await refreshAccessToken(r.tokenEndpoint, r.refreshToken, r.clientId);
  await storeMcpTokens(kv, sessionId, serverId, { ...token, refresh_token: token.refresh_token || r.refreshToken }, r);
  return token.access_token;
}
