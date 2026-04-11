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

    // Pre-write openclaw.json so the start script's Node.js patch preserves
    // dangerouslyDisableDeviceAuth (the patch keeps other controlUi keys intact).
    // Using the correct filename that start-openclaw.sh checks for.
    const gatewayConfig = JSON.stringify({
      gateway: {
        controlUi: {
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    try {
      await sandbox.exec(`mkdir -p /root/.openclaw && printf '%s' '${gatewayConfig.replace(/'/g, "'\\''")}' > /root/.openclaw/openclaw.json`);
      console.log(`[PROVISION] Gateway config pre-written for ${instanceId}`);
    } catch (cfgErr) {
      console.warn(`[PROVISION] Config pre-write failed for ${instanceId}:`, cfgErr);
    }

    // Write auth-profiles.json for the OpenClaw agent so it can call the AI provider.
    // OpenClaw agent reads credentials from this file (not from gateway env vars).
    // Path: /home/openclaw/.openclaw/agents/main/agent/auth-profiles.json
    try {
      const agentApiKey = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY || c.env.ANTHROPIC_API_KEY || '';
      const accountId = c.env.CF_AI_GATEWAY_ACCOUNT_ID || '5efa272dc28e4e3933324c44165b6dbe';
      const gatewayId = c.env.CF_AI_GATEWAY_GATEWAY_ID || 'nkcf-gateway-01';
      const anthropicBaseUrl = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY
        ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`
        : 'https://api.anthropic.com';
      if (agentApiKey) {
        const authProfiles = JSON.stringify({ anthropic: { apiKey: agentApiKey, baseUrl: anthropicBaseUrl } });
        const safeAuth = authProfiles.replace(/'/g, "'\\''")
        const agentDir = '/home/openclaw/.openclaw/agents/main/agent';
        await sandbox.exec(`mkdir -p '${agentDir}' && printf '%s' '${safeAuth}' > '${agentDir}/auth-profiles.json'`);
        console.log(`[PROVISION] auth-profiles.json written for ${instanceId}`);
      }
    } catch (authErr) {
      console.warn(`[PROVISION] auth-profiles.json write failed for ${instanceId}:`, authErr);
    }

    // Build environment variables for the OpenClaw gateway
    const envVars: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: body.gatewayToken,
      OPENCLAW_INSTANCE_ID: instanceId,
    };

    // AI provider configuration — pass both CF AI Gateway vars AND standard SDK vars
    if (c.env.CLOUDFLARE_AI_GATEWAY_API_KEY && c.env.CF_AI_GATEWAY_ACCOUNT_ID && c.env.CF_AI_GATEWAY_GATEWAY_ID) {
      const accountId = c.env.CF_AI_GATEWAY_ACCOUNT_ID;
      const gatewayId = c.env.CF_AI_GATEWAY_GATEWAY_ID;
      envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      envVars.CF_AI_GATEWAY_ACCOUNT_ID = accountId;
      envVars.CF_AI_GATEWAY_GATEWAY_ID = gatewayId;
      // Standard Anthropic SDK env vars so the agent picks them up without auth-profiles.json
      envVars.ANTHROPIC_API_KEY = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      envVars.ANTHROPIC_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
      if (body.aiModel) {
        envVars.CF_AI_GATEWAY_MODEL = `${body.aiProvider || 'anthropic'}/${body.aiModel}`;
      }
    } else if (c.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = c.env.ANTHROPIC_API_KEY;
    } else if (c.env.OPENAI_API_KEY) {
      envVars.OPENAI_API_KEY = c.env.OPENAI_API_KEY;
    }

    // Start OpenClaw gateway as a background process (SDK 0.8+ API)
    const process = await sandbox.startProcess(
      '/usr/local/bin/start-openclaw.sh',
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
  const body = await c.req.json<{ gatewayToken: string; sleepAfter?: string }>();

  try {
    const sleepAfter = body.sleepAfter || '10m';
    const options: SandboxOptions = {
      ...(sleepAfter === 'never' ? { keepAlive: true } : { sleepAfter }),
      containerTimeouts: CONTAINER_TIMEOUTS,
    };

    const sandbox = getSandbox(c.env.Sandbox, instanceId, options);
    await sandbox.start();

    // Patch dangerouslyDisableDeviceAuth into existing config on wake-up.
    try {
      await sandbox.exec(`node -e "const fs=require('fs'),p='/root/.openclaw/openclaw.json';try{let c=JSON.parse(fs.readFileSync(p,'utf8'));c.gateway=c.gateway||{};c.gateway.controlUi=c.gateway.controlUi||{};c.gateway.controlUi.dangerouslyDisableDeviceAuth=true;fs.writeFileSync(p,JSON.stringify(c,null,2));}catch(e){fs.mkdirSync('/root/.openclaw',{recursive:true});fs.writeFileSync(p,JSON.stringify({gateway:{controlUi:{dangerouslyDisableDeviceAuth:true}}},null,2));}"`)
    } catch {}

    // Re-write auth-profiles.json on wake-up (container may be fresh after sleep/destroy)
    try {
      const agentApiKey = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY || c.env.ANTHROPIC_API_KEY || '';
      const accountId = c.env.CF_AI_GATEWAY_ACCOUNT_ID || '5efa272dc28e4e3933324c44165b6dbe';
      const gatewayId = c.env.CF_AI_GATEWAY_GATEWAY_ID || 'nkcf-gateway-01';
      const anthropicBaseUrl = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY
        ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`
        : 'https://api.anthropic.com';
      if (agentApiKey) {
        const authProfiles = JSON.stringify({ anthropic: { apiKey: agentApiKey, baseUrl: anthropicBaseUrl } });
        const safeAuth = authProfiles.replace(/'/g, "'\\''")
        const agentDir = '/home/openclaw/.openclaw/agents/main/agent';
        await sandbox.exec(`mkdir -p '${agentDir}' && printf '%s' '${safeAuth}' > '${agentDir}/auth-profiles.json'`);
        console.log(`[START] auth-profiles.json written for ${instanceId}`);
      }
    } catch (authErr) {
      console.warn(`[START] auth-profiles.json write failed for ${instanceId}:`, authErr);
    }

    // Re-start the gateway process
    const envVars: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: body.gatewayToken,
    };
    if (c.env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
      const accountId = c.env.CF_AI_GATEWAY_ACCOUNT_ID || '';
      const gatewayId = c.env.CF_AI_GATEWAY_GATEWAY_ID || '';
      envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      envVars.CF_AI_GATEWAY_ACCOUNT_ID = accountId;
      envVars.CF_AI_GATEWAY_GATEWAY_ID = gatewayId;
      // Standard Anthropic SDK vars
      envVars.ANTHROPIC_API_KEY = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      envVars.ANTHROPIC_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
    } else if (c.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = c.env.ANTHROPIC_API_KEY;
    }

    await sandbox.startProcess('/usr/local/bin/start-openclaw.sh', { env: envVars });

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
  const body = await c.req.json<{ gatewayToken: string }>();

  try {
    const sandbox = getSandbox(c.env.Sandbox, instanceId, {
      containerTimeouts: CONTAINER_TIMEOUTS,
      sleepAfter: DEFAULT_SLEEP_AFTER,
    });

    // Kill existing gateway processes
    await sandbox.exec('pkill -f "openclaw gateway" || true');
    await new Promise((r) => setTimeout(r, 1000));

    // Patch dangerouslyDisableDeviceAuth into config before restarting
    try {
      await sandbox.exec(`node -e "const fs=require('fs'),p='/root/.openclaw/openclaw.json';try{let c=JSON.parse(fs.readFileSync(p,'utf8'));c.gateway=c.gateway||{};c.gateway.controlUi=c.gateway.controlUi||{};c.gateway.controlUi.dangerouslyDisableDeviceAuth=true;fs.writeFileSync(p,JSON.stringify(c,null,2));}catch(e){fs.mkdirSync('/root/.openclaw',{recursive:true});fs.writeFileSync(p,JSON.stringify({gateway:{controlUi:{dangerouslyDisableDeviceAuth:true}}},null,2));}"`);
    } catch {}

    // Restart
    const envVars: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: body.gatewayToken,
    };
    if (c.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = c.env.ANTHROPIC_API_KEY;
    }
    if (c.env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
      envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      envVars.CF_AI_GATEWAY_ACCOUNT_ID = c.env.CF_AI_GATEWAY_ACCOUNT_ID || '';
      envVars.CF_AI_GATEWAY_GATEWAY_ID = c.env.CF_AI_GATEWAY_GATEWAY_ID || '';
    }

    await sandbox.startProcess('/usr/local/bin/start-openclaw.sh', { env: envVars });

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

    // For HTML responses at the root, inject a script to clear stale localStorage
    // so the OpenClaw UI always uses the correct WebSocket URL for this instance.
    const contentType = containerRes.headers.get('content-type') || '';
    if (contentType.includes('text/html') && (proxyPath === '/' || proxyPath === '')) {
      const html = await containerRes.text();
      const proxyHost = request.headers.get('host') || 'cf-openclaw-sandbox.neo-cloudflare.workers.dev';
      const wsUrl = `wss://${proxyHost}/api/proxy/${instanceId}`;
      const inject = `<script>
(function(){
  try {
    // Clear all keys that might contain a stale WebSocket URL
    for(var i=localStorage.length-1;i>=0;i--){
      var k=localStorage.key(i);
      if(k&&(k.toLowerCase().includes('ws')||k.toLowerCase().includes('url')||k.toLowerCase().includes('gateway')||k.toLowerCase().includes('connect'))){
        localStorage.removeItem(k);
      }
    }
    // Store the correct URL for this instance
    window.__OC_WS_URL__='${wsUrl}';
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
