import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { mcpOAuthStateKey, mcpTokenKey, exchangeCodeForToken } from '@/lib/mcp-auth';

export async function GET(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const kv = (env as any).KV as KVNamespace;

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  // Handle OAuth error
  if (error) {
    const errorDesc = searchParams.get('error_description') || error;
    return new Response(callbackHtml(false, errorDesc), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (!code || !state) {
    return new Response(callbackHtml(false, '缺少必要的 code 或 state 參數'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Retrieve OAuth state from KV
  const stateKey = mcpOAuthStateKey(state);
  const stateDataRaw = await kv.get(stateKey);
  if (!stateDataRaw) {
    return new Response(callbackHtml(false, 'OAuth state 已過期或無效，請重新認證。'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const stateData = JSON.parse(stateDataRaw) as {
    serverId: string;
    serverUrl: string;
    codeVerifier: string;
    clientId: string;
    callbackUrl: string;
    sessionId: string;
    tokenEndpoint: string;
  };

  // Clean up state
  await kv.delete(stateKey);

  try {
    // Exchange authorization code for tokens
    const tokenResponse = await exchangeCodeForToken(
      stateData.tokenEndpoint,
      code,
      stateData.codeVerifier,
      stateData.clientId,
      stateData.callbackUrl,
    );

    // Store tokens in KV
    const tokenKey = mcpTokenKey(stateData.sessionId, stateData.serverId);
    const ttl = tokenResponse.expires_in ? Math.max(tokenResponse.expires_in - 60, 300) : 3600;
    await kv.put(
      tokenKey,
      JSON.stringify({
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token || null,
        tokenType: tokenResponse.token_type,
        expiresAt: tokenResponse.expires_in
          ? Date.now() + tokenResponse.expires_in * 1000
          : null,
        clientId: stateData.clientId,
        tokenEndpoint: stateData.tokenEndpoint,
        serverId: stateData.serverId,
      }),
      { expirationTtl: ttl },
    );

    return new Response(callbackHtml(true, stateData.serverId), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    console.error('[MCP Auth Callback] Token exchange error:', err);
    return new Response(
      callbackHtml(false, `Token 交換失敗: ${(err as Error).message}`),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

function callbackHtml(success: boolean, detail: string): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8" />
  <title>MCP 認證${success ? '成功' : '失敗'}</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; border-radius: 12px; padding: 2rem; max-width: 400px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    .title { font-size: 1.2rem; font-weight: 600; margin-bottom: 0.5rem; }
    .detail { color: #666; font-size: 0.9rem; }
    .closing { color: #999; font-size: 0.8rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? '✅' : '❌'}</div>
    <div class="title">${success ? 'MCP 認證成功' : 'MCP 認證失敗'}</div>
    <div class="detail">${success ? `已成功連接到 ${detail}` : detail}</div>
    <div class="closing">此視窗將自動關閉…</div>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'mcp-auth-callback',
        success: ${success},
        serverId: ${JSON.stringify(success ? detail : null)},
        error: ${JSON.stringify(success ? null : detail)},
      }, '*');
      setTimeout(() => window.close(), 1500);
    }
  </script>
</body>
</html>`;
}
