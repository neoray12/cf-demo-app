/**
 * OpenClaw Sandbox Companion Worker
 *
 * Manages multi-tenant Sandbox containers for the OpenClaw SaaS platform.
 * Called by cf-demo-app via HTTP with a shared secret for authentication.
 *
 * Each tenant gets a unique sandbox identified by their instance ID.
 * The Sandbox SDK handles container lifecycle (start, sleep, wake).
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';
export { Sandbox };

const GATEWAY_PORT = 18789;

// Default sleepAfter for ALL getSandbox() calls.
// Without this, the SDK uses ~30s default which destroys the container (wipes filesystem)
// after just 30s of no requests. Always pass this to preserve the container state.
const DEFAULT_SLEEP_AFTER = '30m';

// Atomic start command: write pre-config from env var then exec into start-openclaw.sh.
// Combining config-write + gateway-start into ONE process avoids the race condition
// where a separate sandbox.exec() can fail silently, leaving no config file.
// Uses Node.js (available in the container) to write JSON from process.env safely.
const ATOMIC_START_CMD = [
  'node -e "',
  "const fs=require('fs');",
  "fs.mkdirSync('/root/.openclaw',{recursive:true});",
  "fs.writeFileSync('/root/.openclaw/openclaw.json',process.env.__OPENCLAW_PRE_CONFIG);",
  "console.log('Config written:',process.env.__OPENCLAW_PRE_CONFIG.length,'bytes');",
  '" && exec /usr/local/bin/start-openclaw.sh',
].join('');

// Atomic merge-and-start: patch gateway.auth.token + dangerouslyDisableDeviceAuth into
// an existing openclaw.json (preserving models/providers), then exec start script.
// Used for restart (container still running, config on disk) and start (wake from sleep).
const ATOMIC_MERGE_START_CMD = [
  'node -e "',
  "const fs=require('fs'),p='/root/.openclaw/openclaw.json';",
  "let c={};try{c=JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){fs.mkdirSync('/root/.openclaw',{recursive:true});}",
  "c.gateway=c.gateway||{};c.gateway.auth=c.gateway.auth||{};",
  "c.gateway.auth.token=process.env.__OPENCLAW_TOKEN;",
  "c.gateway.controlUi=c.gateway.controlUi||{};",
  "c.gateway.controlUi.dangerouslyDisableDeviceAuth=true;",
  "fs.writeFileSync(p,JSON.stringify(c,null,2));",
  "console.log('Config merged, token set');",
  '" && exec /usr/local/bin/start-openclaw.sh',
].join('');

// Container cold start with Node.js 22 + OpenClaw needs more time than SDK defaults
const CONTAINER_TIMEOUTS = {
  instanceGetTimeoutMS: 120_000, // 2 min for provisioning (default 30s)
  portReadyTimeoutMS: 180_000,   // 3 min for SDK API ready (default 90s)
};

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  BACKUP_BUCKET: R2Bucket;
  BROWSER: Fetcher;
  SANDBOX_API_SECRET: string;
  // AI provider secrets (passed to containers)
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CLOUDFLARE_AI_GATEWAY_API_KEY?: string;
  CF_AI_GATEWAY_ACCOUNT_ID?: string;
  CF_AI_GATEWAY_GATEWAY_ID?: string;
  CF_ACCOUNT_ID?: string;
}

type AppEnv = { Bindings: Env; Variables: { sandbox: ReturnType<typeof getSandbox> } };

const app = new Hono<AppEnv>();

// Auth middleware — validate shared secret
// Skip for /api/proxy/* routes: those are accessed directly from the browser
// (including WebSocket), and the container's OpenClaw gateway validates the
// gateway token itself.
app.use('/api/*', async (c, next) => {
  // Proxy routes are public — gateway token auth handled by the container
  if (c.req.path.startsWith('/api/proxy/')) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  const secret = c.env.SANDBOX_API_SECRET;

  if (!secret) {
    return c.json({ error: 'SANDBOX_API_SECRET not configured' }, 500);
  }

  if (!authHeader || authHeader !== `Bearer ${secret}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

// Health check (no auth)
app.get('/health', (c) => c.json({ ok: true, service: 'openclaw-sandbox' }));

/**
 * POST /api/provision/:instanceId
 * Create and start a sandbox container for a tenant.
 */
app.post('/api/provision/:instanceId', async (c) => {
  const instanceId = c.req.param('instanceId');
  const body = await c.req.json<{
    gatewayToken: string;
    aiProvider?: string;
    aiModel?: string;
    sleepAfter?: string;
  }>();

  console.log(`[PROVISION] Starting sandbox for instance: ${instanceId}`);

  const sleepAfter = body.sleepAfter || '10m';
  const options: SandboxOptions = {
    ...(sleepAfter === 'never' ? { keepAlive: true } : { sleepAfter }),
    containerTimeouts: CONTAINER_TIMEOUTS,
  };

  const sandbox = getSandbox(c.env.Sandbox, instanceId, options);

  try {
    // Start the container
    await sandbox.start();

    // Build environment variables for the OpenClaw gateway
    const envVars: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: body.gatewayToken,
      OPENCLAW_INSTANCE_ID: instanceId,
    };

    // AI provider configuration: pass CF AI Gateway vars so OpenClaw's native
    // Gateway integration can use CLOUDFLARE_AI_GATEWAY_API_KEY as cf-aig-authorization.
    if (c.env.CLOUDFLARE_AI_GATEWAY_API_KEY && c.env.CF_AI_GATEWAY_ACCOUNT_ID && c.env.CF_AI_GATEWAY_GATEWAY_ID) {
      envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      envVars.CF_AI_GATEWAY_ACCOUNT_ID = c.env.CF_AI_GATEWAY_ACCOUNT_ID;
      envVars.CF_AI_GATEWAY_GATEWAY_ID = c.env.CF_AI_GATEWAY_GATEWAY_ID;
      if (body.aiModel) {
        envVars.CF_AI_GATEWAY_MODEL = `${body.aiProvider || 'anthropic'}/${body.aiModel}`;
      }
    } else if (c.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = c.env.ANTHROPIC_API_KEY;
    } else if (c.env.OPENAI_API_KEY) {
      envVars.OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    }

    // Pre-write openclaw.json with gateway.auth.token + dangerouslyDisableDeviceAuth,
    // then start the gateway — all in ONE startProcess call to avoid the race condition
    // where a separate sandbox.exec() pre-write can fail silently.
    // The config is passed via env var to avoid shell quoting issues with JSON.
    envVars.__OPENCLAW_PRE_CONFIG = JSON.stringify({
      gateway: {
        auth: { token: body.gatewayToken },
        controlUi: { dangerouslyDisableDeviceAuth: true },
      },
    });

    const process = await sandbox.startProcess(
      ATOMIC_START_CMD,
      { env: envVars, processId: `gateway-${instanceId}` }
    );

    console.log(`[PROVISION] Gateway started for ${instanceId}: pid=${process.id}`);

    return c.json({
      success: true,
      instanceId,
      status: 'provisioning',
      message: 'Sandbox container started, gateway initializing (may take 1-2 minutes)',
    });
  } catch (error) {
    console.error(`[PROVISION] Failed for ${instanceId}:`, error);
    return c.json(
      { error: 'Provision failed', details: (error as Error).message },
      500
    );
  }
});

/**
 * GET /api/status/:instanceId
 * Check if the sandbox container and gateway are running.
 */
app.get('/api/status/:instanceId', async (c) => {
  const instanceId = c.req.param('instanceId');

  try {
    const sandbox = getSandbox(c.env.Sandbox, instanceId, {
      containerTimeouts: CONTAINER_TIMEOUTS,
      sleepAfter: DEFAULT_SLEEP_AFTER,
    });

    // Try to check if gateway is responding (OpenClaw serves UI at /)
    let gatewayReady = false;
    try {
      const statusRes = await Promise.race([
        sandbox.containerFetch(new Request('http://localhost/'), GATEWAY_PORT),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000)),
      ]);
      gatewayReady = statusRes !== null && (statusRes as Response).status < 500;
    } catch {
      // Container may be sleeping or not started
    }

    return c.json({
      instanceId,
      containerStatus: gatewayReady ? 'active' : 'sleeping',
      gatewayReady,
    });
  } catch (error) {
    return c.json({
      instanceId,
      containerStatus: 'unknown',
      gatewayReady: false,
      error: (error as Error).message,
    });
  }
});

/**
 * POST /api/start/:instanceId
 * Wake up a sleeping sandbox.
 */
app.post('/api/start/:instanceId', async (c) => {
  const instanceId = c.req.param('instanceId');
  const body = await c.req.json<{ gatewayToken: string; sleepAfter?: string; aiProvider?: string; aiModel?: string }>();

  try {
    const sleepAfter = body.sleepAfter || '10m';
    const options: SandboxOptions = {
      ...(sleepAfter === 'never' ? { keepAlive: true } : { sleepAfter }),
      containerTimeouts: CONTAINER_TIMEOUTS,
    };

    const sandbox = getSandbox(c.env.Sandbox, instanceId, options);
    await sandbox.start();

    // Build env vars — same as provision (wake from sleep = fresh container)
    const envVars: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: body.gatewayToken,
    };
    if (c.env.CLOUDFLARE_AI_GATEWAY_API_KEY && c.env.CF_AI_GATEWAY_ACCOUNT_ID && c.env.CF_AI_GATEWAY_GATEWAY_ID) {
      envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      envVars.CF_AI_GATEWAY_ACCOUNT_ID = c.env.CF_AI_GATEWAY_ACCOUNT_ID;
      envVars.CF_AI_GATEWAY_GATEWAY_ID = c.env.CF_AI_GATEWAY_GATEWAY_ID;
      if (body.aiModel) {
        envVars.CF_AI_GATEWAY_MODEL = `${body.aiProvider || 'anthropic'}/${body.aiModel}`;
      }
    } else if (c.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = c.env.ANTHROPIC_API_KEY;
    } else if (c.env.OPENAI_API_KEY) {
      envVars.OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    }

    // Atomic: write config + start gateway in ONE process (same as provision)
    envVars.__OPENCLAW_PRE_CONFIG = JSON.stringify({
      gateway: {
        auth: { token: body.gatewayToken },
        controlUi: { dangerouslyDisableDeviceAuth: true },
      },
    });

    await sandbox.startProcess(ATOMIC_START_CMD, { env: envVars });

    return c.json({ success: true, instanceId, status: 'starting' });
  } catch (error) {
    return c.json(
      { error: 'Start failed', details: (error as Error).message },
      500
    );
  }
});

/**
 * POST /api/stop/:instanceId
 * Destroy a sandbox container.
 */
app.post('/api/stop/:instanceId', async (c) => {
  const instanceId = c.req.param('instanceId');

  try {
    const sandbox = getSandbox(c.env.Sandbox, instanceId, {
      containerTimeouts: CONTAINER_TIMEOUTS,
    });
    await sandbox.destroy();

    return c.json({ success: true, instanceId, status: 'stopped' });
  } catch (error) {
    return c.json(
      { error: 'Stop failed', details: (error as Error).message },
      500
    );
  }
});

/**
 * POST /api/restart/:instanceId
 * Kill the gateway process and restart it.
 */
app.post('/api/restart/:instanceId', async (c) => {
  const instanceId = c.req.param('instanceId');
  const body = await c.req.json<{ gatewayToken: string; aiProvider?: string; aiModel?: string }>();

  try {
    const sandbox = getSandbox(c.env.Sandbox, instanceId, {
      containerTimeouts: CONTAINER_TIMEOUTS,
      sleepAfter: DEFAULT_SLEEP_AFTER,
    });

    // Kill existing gateway processes
    await sandbox.exec('pkill -f "openclaw gateway" || true');
    await new Promise((r) => setTimeout(r, 1000));

    // Restart with atomic merge: patch token into existing config, then start
    const envVars: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: body.gatewayToken,
      __OPENCLAW_TOKEN: body.gatewayToken,
    };
    if (c.env.CLOUDFLARE_AI_GATEWAY_API_KEY && c.env.CF_AI_GATEWAY_ACCOUNT_ID && c.env.CF_AI_GATEWAY_GATEWAY_ID) {
      envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      envVars.CF_AI_GATEWAY_ACCOUNT_ID = c.env.CF_AI_GATEWAY_ACCOUNT_ID;
      envVars.CF_AI_GATEWAY_GATEWAY_ID = c.env.CF_AI_GATEWAY_GATEWAY_ID;
      if (body.aiModel) {
        envVars.CF_AI_GATEWAY_MODEL = `${body.aiProvider || 'anthropic'}/${body.aiModel}`;
      }
    } else if (c.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = c.env.ANTHROPIC_API_KEY;
    } else if (c.env.OPENAI_API_KEY) {
      envVars.OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    }

    await sandbox.startProcess(ATOMIC_MERGE_START_CMD, { env: envVars });

    return c.json({ success: true, instanceId, status: 'restarting' });
  } catch (error) {
    return c.json(
      { error: 'Restart failed', details: (error as Error).message },
      500
    );
  }
});

/**
 * POST /api/exec/:instanceId
 * Run a shell command inside the sandbox container (admin only).
 */
app.post('/api/exec/:instanceId', async (c) => {
  const instanceId = c.req.param('instanceId');
  const body = await c.req.json<{ command: string }>();
  if (!body.command) return c.json({ error: 'command required' }, 400);

  const sandbox = getSandbox(c.env.Sandbox, instanceId, { containerTimeouts: CONTAINER_TIMEOUTS, sleepAfter: DEFAULT_SLEEP_AFTER });
  try {
    const result = await sandbox.exec(body.command);
    return c.json({ output: result });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

/**
 * ALL /api/proxy/:instanceId{/*}?
 * Proxy HTTP requests to the OpenClaw gateway inside the sandbox container.
 * Also handles WebSocket upgrade for real-time communication.
 */
app.all('/api/proxy/:instanceId', async (c) => {
  // Handle root path (no trailing path) — redirect to handler below
  return proxyHandler(c);
});
app.all('/api/proxy/:instanceId/*', async (c) => {
  return proxyHandler(c);
});

async function proxyHandler(c: any) {
  const instanceId = c.req.param('instanceId');
  const request = c.req.raw;
  const url = new URL(request.url);

  // Extract the path after /api/proxy/:instanceId
  const proxyPath = url.pathname.replace(`/api/proxy/${instanceId}`, '') || '/';
  const targetUrl = new URL(`http://localhost${proxyPath}${url.search}`);

  console.log(`[PROXY] ${instanceId}: ${request.method} ${proxyPath}`);

  const sandbox = getSandbox(c.env.Sandbox, instanceId, {
    containerTimeouts: CONTAINER_TIMEOUTS,
    sleepAfter: DEFAULT_SLEEP_AFTER,
  });
  const isWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

  if (isWebSocket) {
    // WebSocket proxy
    try {
      const containerResponse = await sandbox.wsConnect(request, GATEWAY_PORT);
      const containerWs = containerResponse.webSocket;

      if (!containerWs) {
        return containerResponse;
      }

      const [clientWs, serverWs] = Object.values(new WebSocketPair());
      serverWs.accept();
      containerWs.accept();

      // Relay messages bidirectionally
      serverWs.addEventListener('message', (event) => {
        if (containerWs.readyState === WebSocket.OPEN) containerWs.send(event.data);
      });
      containerWs.addEventListener('message', (event) => {
        if (serverWs.readyState === WebSocket.OPEN) serverWs.send(event.data);
      });
      serverWs.addEventListener('close', (event) => containerWs.close(event.code, event.reason));
      containerWs.addEventListener('close', (event) => {
        const reason = event.reason.length > 123 ? event.reason.slice(0, 120) + '...' : event.reason;
        serverWs.close(event.code, reason);
      });
      serverWs.addEventListener('error', () => containerWs.close(1011, 'Client error'));
      containerWs.addEventListener('error', () => serverWs.close(1011, 'Container error'));

      return new Response(null, { status: 101, webSocket: clientWs });
    } catch (error) {
      console.error(`[PROXY WS] ${instanceId}:`, error);
      return new Response('WebSocket proxy error', { status: 502 });
    }
  }

  // HTTP proxy
  try {
    const proxyRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    const containerRes = await sandbox.containerFetch(proxyRequest, GATEWAY_PORT);

    // For HTML responses, inject scripts to:
    // 1. Clear stale localStorage (multiple instances share same origin)
    // 2. Monkey-patch WebSocket to include /api/proxy/:instanceId prefix
    //    (OpenClaw UI derives WS URL from window.location, which misses the prefix)
    const contentType = containerRes.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const html = await containerRes.text();
      const proxyPrefix = `/api/proxy/${instanceId}`;
      const inject = `<script>
(function(){
  try {
    // --- Namespaced localStorage ---
    // All instances share the same origin, so we prefix every key with
    // the instance ID to prevent cross-tab interference.
    var ns = '__oc_${instanceId}:';
    var _ls = window.localStorage;
    var _proto = Storage.prototype;
    var nsObj = {
      getItem:    function(k){ return _proto.getItem.call(_ls, ns+k); },
      setItem:    function(k,v){ _proto.setItem.call(_ls, ns+k, v); },
      removeItem: function(k){ _proto.removeItem.call(_ls, ns+k); },
      clear: function(){
        var rm=[];
        for(var i=0;i<_ls.length;i++){var k=_proto.key.call(_ls,i);if(k&&k.indexOf(ns)===0)rm.push(k);}
        rm.forEach(function(k){_proto.removeItem.call(_ls,k);});
      },
      key: function(idx){
        var c=0;
        for(var i=0;i<_ls.length;i++){var k=_proto.key.call(_ls,i);if(k&&k.indexOf(ns)===0){if(c===idx)return k.slice(ns.length);c++;}}
        return null;
      },
      get length(){
        var c=0;
        for(var i=0;i<_ls.length;i++){var k=_proto.key.call(_ls,i);if(k&&k.indexOf(ns)===0)c++;}
        return c;
      }
    };
    var lsProxy = new Proxy(nsObj, {
      get: function(t,p){ if(p in t) return typeof t[p]==='function'?t[p].bind(t):t[p]; if(typeof p==='string') return t.getItem(p); },
      set: function(t,p,v){ t.setItem(p,String(v)); return true; },
      deleteProperty: function(t,p){ t.removeItem(p); return true; }
    });
    Object.defineProperty(window,'localStorage',{get:function(){return lsProxy;},configurable:true});
    // Clear stale keys for THIS instance only (fresh start on page load)
    nsObj.clear();

    // --- Monkey-patch WebSocket ---
    // The UI constructs ws://host/... but needs ws://host/api/proxy/:id/...
    var _WS = window.WebSocket;
    var pfx = '${proxyPrefix}';
    window.WebSocket = function(url, protocols) {
      try {
        var u = new URL(url, window.location.href);
        if (u.host === window.location.host && u.pathname.indexOf(pfx) !== 0) {
          var cleanPath = u.pathname.replace(/^\\/api\\/proxy\\/?/, '/');
          u.pathname = pfx + cleanPath;
        }
        url = u.toString();
      } catch(e){}
      return protocols !== undefined ? new _WS(url, protocols) : new _WS(url);
    };
    window.WebSocket.prototype = _WS.prototype;
    window.WebSocket.CONNECTING = _WS.CONNECTING;
    window.WebSocket.OPEN = _WS.OPEN;
    window.WebSocket.CLOSING = _WS.CLOSING;
    window.WebSocket.CLOSED = _WS.CLOSED;
  } catch(e){}
})();
</script>`;
      const patched = html.replace(/<head([^>]*)>/, `<head$1>${inject}`);
      const headers = new Headers(containerRes.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      return new Response(patched, { status: containerRes.status, headers });
    }

    return containerRes;
  } catch (error) {
    console.error(`[PROXY HTTP] ${instanceId}:`, error);
    return c.json(
      { error: 'Container not reachable', details: (error as Error).message },
      502
    );
  }
}

export default app;
