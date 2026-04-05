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

export function mcpOAuthStateKey(state: string): string {
  return `mcp-oauth-state:${state}`;
}

export function mcpToolCacheKey(sessionId: string, serverId: string): string {
  return `mcp-tools:${sessionId}:${serverId}`;
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

  // Always fetch RFC 9728 Protected Resource Metadata first to get the canonical resource URL
  let resourceIdentifier: string | undefined;
  let externalAuthServerUrl: string | undefined;
  const protectedUrl = `${base.origin}/.well-known/oauth-protected-resource`;
  try {
    const res = await fetch(protectedUrl, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json() as { resource?: string; authorization_servers?: string[] };
      resourceIdentifier = data.resource || base.origin;
      if (data.authorization_servers?.[0]) {
        externalAuthServerUrl = `${data.authorization_servers[0]}/.well-known/oauth-authorization-server`;
      }
    }
  } catch {
    // ignore
  }

  // Try the server's own /.well-known/oauth-authorization-server
  const wellKnownUrl = `${base.origin}/.well-known/oauth-authorization-server`;
  try {
    const res = await fetch(wellKnownUrl, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const meta = await res.json() as OAuthMetadata;
      return { ...meta, resource: resourceIdentifier || base.origin };
    }
  } catch {
    // ignore
  }

  // Try an external authorization server (e.g. CF Access as IdP)
  if (externalAuthServerUrl) {
    try {
      const asRes = await fetch(externalAuthServerUrl, { headers: { Accept: 'application/json' } });
      if (asRes.ok) {
        const asMeta = await asRes.json() as OAuthMetadata;
        return { ...asMeta, resource: resourceIdentifier || base.origin };
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
