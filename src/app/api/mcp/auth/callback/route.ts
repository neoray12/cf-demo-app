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
  const glowColor = success ? '34, 197, 94' : '239, 68, 68';
  const accentColor = success ? '#22c55e' : '#ef4444';
  const closeDelay = 0; // not used for auto-close

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8" />
  <title>MCP 認證${success ? '成功' : '失敗'}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
      background: radial-gradient(ellipse at 60% 20%, #1e3a5f 0%, #0f172a 50%, #0a0f1e 100%);
      overflow: hidden;
    }

    /* ambient glow blob */
    body::before {
      content: '';
      position: fixed;
      width: 360px; height: 360px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(${glowColor}, 0.18) 0%, transparent 70%);
      top: 50%; left: 50%;
      transform: translate(-50%, -60%);
      pointer-events: none;
      animation: pulse 3s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.7; transform: translate(-50%, -60%) scale(1); }
      50% { opacity: 1; transform: translate(-50%, -60%) scale(1.08); }
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.6); }
      to   { opacity: 1; transform: scale(1); }
    }

    @keyframes progress {
      from { width: 100%; }
      to   { width: 0%; }
    }

    .card {
      position: relative;
      width: 340px;
      background: rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      padding: 2.5rem 2rem 1.75rem;
      text-align: center;
      box-shadow:
        0 0 0 1px rgba(${glowColor}, 0.15),
        0 8px 40px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.1);
      animation: fadeUp 0.4s ease both;
    }

    .mcp-logo {
      width: 36px; height: 36px;
      margin: 0 auto 1.25rem;
      opacity: 0.5;
      animation: fadeUp 0.4s 0.05s ease both;
    }

    .status-icon {
      width: 64px; height: 64px;
      border-radius: 50%;
      background: rgba(${glowColor}, 0.15);
      border: 1.5px solid rgba(${glowColor}, 0.4);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.25rem;
      box-shadow: 0 0 24px rgba(${glowColor}, 0.3);
      animation: scaleIn 0.35s 0.1s cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }

    .status-icon svg { width: 28px; height: 28px; }

    .title {
      font-size: 1.1rem; font-weight: 700;
      color: #f1f5f9;
      margin-bottom: 0.4rem;
      animation: fadeUp 0.4s 0.15s ease both;
    }

    .subtitle {
      font-size: 0.8rem;
      color: rgba(255,255,255,0.45);
      margin-bottom: ${success ? '0.35rem' : '0'};
      animation: fadeUp 0.4s 0.2s ease both;
    }

    .server-name {
      display: inline-flex; align-items: center; gap: 0.4rem;
      font-size: 0.78rem; font-weight: 600;
      color: ${accentColor};
      background: rgba(${glowColor}, 0.1);
      border: 1px solid rgba(${glowColor}, 0.25);
      border-radius: 6px;
      padding: 0.25rem 0.65rem;
      margin-top: 0.5rem;
      animation: fadeUp 0.4s 0.22s ease both;
    }

    .close-btn {
      display: inline-flex; align-items: center; gap: 0.4rem;
      margin-top: 1.75rem;
      padding: 0.5rem 1.25rem;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(255,255,255,0.07);
      color: rgba(255,255,255,0.6);
      font-size: 0.8rem;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      animation: fadeUp 0.4s 0.3s ease both;
    }

    .close-btn:hover {
      background: rgba(255,255,255,0.13);
      color: rgba(255,255,255,0.9);
    }
  </style>
</head>
<body>
  <div class="card">
    <!-- MCP Logo -->
    <svg class="mcp-logo" viewBox="0 0 180 180" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M67.784 149.926c-2.618 0-5.131-.449-7.539-1.346-2.407-.897-4.574-2.243-6.501-4.039L10.63 103.309c-1.927-1.795-3.369-3.872-4.327-6.23-.958-2.358-1.437-4.814-1.437-7.368 0-2.554.48-5.002 1.437-7.342.958-2.341 2.4-4.409 4.327-6.204l43.114-41.258c1.927-1.796 4.094-3.134 6.501-4.013 2.408-.88 4.921-1.32 7.539-1.32 2.618 0 5.122.44 7.512 1.32 2.39.88 4.548 2.217 6.475 4.013l5.316 5.09-12.95 12.382-5.316-5.09c-.963-.897-2.073-1.346-3.332-1.346-1.258 0-2.377.449-3.358 1.346l-43.114 41.258c-.963.897-1.444 2.02-1.444 3.37 0 1.35.481 2.465 1.444 3.344l43.114 41.232c.98.897 2.1 1.346 3.358 1.346 1.259 0 2.37-.449 3.332-1.346l5.316-5.09 12.95 12.382-5.316 5.09c-1.927 1.796-4.085 3.142-6.475 4.04-2.39.896-4.894 1.345-7.512 1.345Z" fill="white"/>
      <path d="M112.216 149.926c-2.618 0-5.122-.449-7.512-1.346-2.39-.897-4.548-2.243-6.475-4.039l-5.316-5.09 12.95-12.408 5.316 5.116c.962.897 2.073 1.346 3.332 1.346 1.259 0 2.378-.449 3.358-1.346l43.114-41.232c.963-.88 1.444-1.994 1.444-3.344 0-1.35-.481-2.473-1.444-3.37L117.869 43.955c-.98-.897-2.1-1.346-3.358-1.346-1.259 0-2.37.449-3.332 1.346l-5.316 5.09-12.95-12.382 5.316-5.09c1.927-1.796 4.085-3.134 6.475-4.013 2.39-.88 4.894-1.32 7.512-1.32s5.131.44 7.539 1.32c2.408.88 4.574 2.217 6.501 4.013l43.114 41.258c1.927 1.795 3.369 3.863 4.327 6.204.958 2.34 1.437 4.788 1.437 7.342 0 2.554-.479 5.01-1.437 7.368-.958 2.358-2.4 4.435-4.327 6.23l-43.114 41.232c-1.927 1.796-4.093 3.142-6.501 4.04-2.408.896-4.921 1.345-7.539 1.345Z" fill="white"/>
      <path d="M90 126.384c-4.945 0-9.167-1.735-12.666-5.206-3.5-3.47-5.249-7.657-5.249-12.561 0-4.904 1.75-9.091 5.249-12.562 3.499-3.47 7.72-5.205 12.666-5.205 4.945 0 9.167 1.735 12.666 5.205 3.5 3.47 5.249 7.658 5.249 12.562 0 4.904-1.75 9.09-5.249 12.561-3.499 3.47-7.72 5.206-12.666 5.206Z" fill="white"/>
    </svg>

    <!-- Status icon -->
    <div class="status-icon">
      ${success
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
      }
    </div>

    <div class="title">${success ? '認證成功' : '認證失敗'}</div>
    <div class="subtitle">${success ? '已取得存取權限' : detail}</div>
    ${success ? `<div class="server-name">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      ${detail}
    </div>` : ''}

    <button class="close-btn" onclick="window.close()">關閉視窗</button>
  </div>

  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'mcp-auth-callback',
        success: ${success},
        serverId: ${JSON.stringify(success ? detail : null)},
        error: ${JSON.stringify(success ? null : detail)},
      }, '*');
    }
  </script>
</body>
</html>`;
}
