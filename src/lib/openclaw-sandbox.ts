/**
 * OpenClaw Sandbox client — calls the companion worker API.
 */

interface SandboxEnv {
  OPENCLAW_SANDBOX_URL?: string;
  OPENCLAW_SANDBOX_SECRET?: string;
}

async function sandboxFetch(
  env: SandboxEnv,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const baseUrl = env.OPENCLAW_SANDBOX_URL;
  const secret = env.OPENCLAW_SANDBOX_SECRET;

  if (!baseUrl || !secret) {
    throw new Error('OPENCLAW_SANDBOX_URL or OPENCLAW_SANDBOX_SECRET not configured');
  }

  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
      ...(options.headers || {}),
    },
  });
}

export async function provisionSandbox(
  env: SandboxEnv,
  instanceId: string,
  config: {
    gatewayToken: string;
    aiProvider?: string;
    aiModel?: string;
    sleepAfter?: string;
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await sandboxFetch(env, `/api/provision/${instanceId}`, {
      method: 'POST',
      body: JSON.stringify(config),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return { success: false, error: (data.error as string) || `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function getSandboxStatus(
  env: SandboxEnv,
  instanceId: string
): Promise<{ containerStatus: string; gatewayReady: boolean }> {
  try {
    const res = await sandboxFetch(env, `/api/status/${instanceId}`);
    const data = await res.json() as Record<string, unknown>;
    return {
      containerStatus: (data.containerStatus as string) || 'unknown',
      gatewayReady: (data.gatewayReady as boolean) || false,
    };
  } catch {
    return { containerStatus: 'unknown', gatewayReady: false };
  }
}

export async function startSandbox(
  env: SandboxEnv,
  instanceId: string,
  gatewayToken: string,
  sleepAfter?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await sandboxFetch(env, `/api/start/${instanceId}`, {
      method: 'POST',
      body: JSON.stringify({ gatewayToken, sleepAfter }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return { success: false, error: (data.error as string) || `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function stopSandbox(
  env: SandboxEnv,
  instanceId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await sandboxFetch(env, `/api/stop/${instanceId}`, {
      method: 'POST',
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return { success: false, error: (data.error as string) || `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function restartSandbox(
  env: SandboxEnv,
  instanceId: string,
  gatewayToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await sandboxFetch(env, `/api/restart/${instanceId}`, {
      method: 'POST',
      body: JSON.stringify({ gatewayToken }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      return { success: false, error: (data.error as string) || `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
