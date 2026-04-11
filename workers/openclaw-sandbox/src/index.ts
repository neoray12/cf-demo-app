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
import { getSandbox, type SandboxOptions } from '@cloudflare/sandbox';
export { Sandbox } from '@cloudflare/sandbox';

const GATEWAY_PORT = 18789;

interface Env {
  Sandbox: DurableObjectNamespace;
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
app.use('/api/*', async (c, next) => {
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
  const options: SandboxOptions =
    sleepAfter === 'never' ? { keepAlive: true } : { sleepAfter };

  const sandbox = getSandbox(c.env.Sandbox, instanceId, options);

  try {
    // Start the container
    await sandbox.start();

    // Build environment variables for the OpenClaw gateway
    const envVars: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: body.gatewayToken,
    };

    // AI provider configuration
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

    // Start OpenClaw gateway inside the container
    const envString = Object.entries(envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');

    const result = await sandbox.exec(
      `${envString} /usr/local/bin/start-openclaw.sh`,
      { background: true }
    );

    console.log(`[PROVISION] Gateway started for ${instanceId}:`, result);

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
    const sandbox = getSandbox(c.env.Sandbox, instanceId);

    // Try to check if gateway is responding
    let gatewayReady = false;
    try {
      const statusRes = await Promise.race([
        sandbox.containerFetch(new Request('http://localhost/api/status'), GATEWAY_PORT),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      gatewayReady = statusRes !== null && (statusRes as Response).ok;
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
    const options: SandboxOptions =
      sleepAfter === 'never' ? { keepAlive: true } : { sleepAfter };

    const sandbox = getSandbox(c.env.Sandbox, instanceId, options);
    await sandbox.start();

    // Re-start the gateway process
    const envVars: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: body.gatewayToken,
    };
    if (c.env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
      envVars.CLOUDFLARE_AI_GATEWAY_API_KEY = c.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      envVars.CF_AI_GATEWAY_ACCOUNT_ID = c.env.CF_AI_GATEWAY_ACCOUNT_ID || '';
      envVars.CF_AI_GATEWAY_GATEWAY_ID = c.env.CF_AI_GATEWAY_GATEWAY_ID || '';
    } else if (c.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = c.env.ANTHROPIC_API_KEY;
    }

    const envString = Object.entries(envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');

    await sandbox.exec(`${envString} /usr/local/bin/start-openclaw.sh`, { background: true });

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
    const sandbox = getSandbox(c.env.Sandbox, instanceId);
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
    const sandbox = getSandbox(c.env.Sandbox, instanceId);

    // Kill existing gateway
    await sandbox.exec('pkill -f "openclaw gateway" || true');
    await new Promise((r) => setTimeout(r, 1000));

    // Restart
    const envVars: Record<string, string> = {
      OPENCLAW_GATEWAY_TOKEN: body.gatewayToken,
    };
    if (c.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = c.env.ANTHROPIC_API_KEY;
    }

    const envString = Object.entries(envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');

    await sandbox.exec(`${envString} /usr/local/bin/start-openclaw.sh`, { background: true });

    return c.json({ success: true, instanceId, status: 'restarting' });
  } catch (error) {
    return c.json(
      { error: 'Restart failed', details: (error as Error).message },
      500
    );
  }
});

/**
 * ALL /api/proxy/:instanceId/*
 * Proxy HTTP requests to the OpenClaw gateway inside the sandbox container.
 * Also handles WebSocket upgrade for real-time communication.
 */
app.all('/api/proxy/:instanceId/*', async (c) => {
  const instanceId = c.req.param('instanceId');
  const request = c.req.raw;
  const url = new URL(request.url);

  // Extract the path after /api/proxy/:instanceId
  const proxyPath = url.pathname.replace(`/api/proxy/${instanceId}`, '') || '/';
  const targetUrl = new URL(`http://localhost${proxyPath}${url.search}`);

  console.log(`[PROXY] ${instanceId}: ${request.method} ${proxyPath}`);

  const sandbox = getSandbox(c.env.Sandbox, instanceId);
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

    return await sandbox.containerFetch(proxyRequest, GATEWAY_PORT);
  } catch (error) {
    console.error(`[PROXY HTTP] ${instanceId}:`, error);
    return c.json(
      { error: 'Container not reachable', details: (error as Error).message },
      502
    );
  }
});

export default app;
