import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { mcpOAuthStateKey, mcpTokenKey, mcpToolCacheKey, mcpPromptCacheKey, exchangeCodeForToken } from '@/lib/mcp-auth';

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
    resource?: string;
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
      stateData.resource,
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
    // A new grant can expose a different set of servers (e.g. the user picked
    // other servers on the portal's consent page), so drop the old lists.
    await Promise.all([
      kv.delete(mcpToolCacheKey(stateData.sessionId, stateData.serverId)),
      kv.delete(mcpPromptCacheKey(stateData.sessionId, stateData.serverId)),
    ]);

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

// `detail` can come straight from the query string (error_description), so it
// must be escaped before it goes into the page.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// JSON for an inline <script>: also neutralise "</script>" and HTML comments.
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

function callbackHtml(success: boolean, detail: string): string {
  const safe = escapeHtml(detail);
  const icon = success
    ? '<polyline points="20 6 9 17 4 12"/>'
    : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="light dark" />
  <title>MCP 認證${success ? '成功' : '失敗'}</title>
  <style>
    :root {
      --bg: #fafafa; --card: #ffffff; --fg: #0a0a0a; --muted: #737373;
      --border: #e5e5e5; --chip: #f5f5f5; --btn: #0a0a0a; --btn-fg: #ffffff;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0a0a0a; --card: #171717; --fg: #fafafa; --muted: #a3a3a3;
        --border: #262626; --chip: #262626; --btn: #fafafa; --btn-fg: #0a0a0a;
      }
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'PingFang TC', 'Noto Sans TC', sans-serif;
      background: var(--bg); color: var(--fg);
      display: flex; align-items: center; justify-content: center;
      min-height: 100dvh;
      padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
               max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      -webkit-text-size-adjust: 100%;
    }
    .card {
      width: 100%; max-width: 360px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px 24px 24px;
      text-align: center;
    }
    .status {
      width: 48px; height: 48px; margin: 0 auto 16px;
      border-radius: 50%;
      border: 1.5px solid var(--fg);
      display: flex; align-items: center; justify-content: center;
    }
    .status svg { width: 22px; height: 22px; }
    h1 { font-size: 18px; font-weight: 600; line-height: 1.4; }
    p { font-size: 14px; line-height: 1.5; color: var(--muted); margin-top: 6px; overflow-wrap: anywhere; }
    .server {
      display: inline-block; margin-top: 12px;
      font: 500 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--fg); background: var(--chip);
      border: 1px solid var(--border); border-radius: 6px;
      padding: 6px 10px;
    }
    button {
      display: block; width: 100%; margin-top: 24px;
      min-height: 44px; padding: 0 16px;
      border: 0; border-radius: 8px;
      background: var(--btn); color: var(--btn-fg);
      font: 500 15px/1 inherit; font-family: inherit;
      cursor: pointer;
    }
    button:active { opacity: 0.85; }
    .hint { display: none; font-size: 13px; margin-top: 12px; }
  </style>
</head>
<body>
  <main class="card">
    <div class="status" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
    </div>
    <h1>${success ? '認證成功' : '認證失敗'}</h1>
    <p>${success ? '已取得存取權限，請回到原本的頁面。' : safe}</p>
    ${success ? `<span class="server">${safe}</span>` : ''}
    <button type="button" id="close">關閉視窗</button>
    <p class="hint" id="hint">瀏覽器不允許自動關閉，請手動關閉此分頁，回到原本的頁面。</p>
  </main>

  <script>
    if (window.opener) {
      window.opener.postMessage({
        type: 'mcp-auth-callback',
        success: ${success},
        serverId: ${scriptJson(success ? detail : null)},
        error: ${scriptJson(success ? null : detail)},
      }, '*');
    }
    document.getElementById('close').addEventListener('click', function () {
      window.close();
      // Mobile browsers often refuse to close a tab; tell the user instead.
      setTimeout(function () { document.getElementById('hint').style.display = 'block'; }, 300);
    });
  </script>
</body>
</html>`;
}
