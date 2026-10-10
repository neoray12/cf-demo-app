/**
 * Chat Sandbox client — calls the cf-chat-sandbox companion worker.
 * Powers the executeCode / createWebPreview chat tools.
 */

interface SandboxEnv {
  CHAT_SANDBOX_URL?: string;
  CHAT_SANDBOX_SECRET?: string;
}

// Must stay below the chat stream's idle-abort window (IDLE_MS in
// /api/chat): a tool call emits no stream events while it runs.
const FETCH_TIMEOUT_MS = 55_000;
const WARMUP_TIMEOUT_MS = 90_000;

export function chatSandboxConfigured(env: SandboxEnv): boolean {
  return Boolean(env.CHAT_SANDBOX_URL && env.CHAT_SANDBOX_SECRET);
}

async function sandboxFetch(
  env: SandboxEnv,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const baseUrl = env.CHAT_SANDBOX_URL;
  const secret = env.CHAT_SANDBOX_SECRET;

  if (!baseUrl || !secret) {
    throw new Error('CHAT_SANDBOX_URL or CHAT_SANDBOX_SECRET not configured');
  }

  return fetch(`${baseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
      ...(options.headers || {}),
    },
  });
}

/**
 * Boot the session's container in the background. Called when a chat request
 * starts, so the cold start (container boot + colo placement) overlaps with the
 * model's own thinking time instead of stacking on top of the first tool call.
 * Never throws — it is purely an optimisation.
 */
export async function warmSandbox(env: SandboxEnv, sessionId: string): Promise<void> {
  if (!chatSandboxConfigured(env)) return;
  try {
    await fetch(`${env.CHAT_SANDBOX_URL}/api/warmup`, {
      method: 'POST',
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CHAT_SANDBOX_SECRET}` },
      body: JSON.stringify({ sessionId }),
    });
  } catch (err) {
    console.warn('[Chat API] sandbox warmup failed:', (err as Error).message);
  }
}

// Demo telemetry: which physical container/POP ran the code, and whether it
// was a fresh boot (cold) or a reused container (warm).
export interface SandboxTelemetry {
  sandboxId: string;
  containerId: string | null;
  colo: string | null;
  uptimeSeconds: number | null;
  coldStart: boolean | null;
}

export interface CodeExecutionOutput {
  text: string | null;
  image: string | null;
}

export interface CodeExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  results: CodeExecutionOutput[];
  error: string | null;
  sandbox: SandboxTelemetry | null;
}

export async function executeCode(
  env: SandboxEnv,
  sessionId: string,
  code: string,
  language: string = 'python'
): Promise<CodeExecutionResult> {
  try {
    const res = await sandboxFetch(env, '/api/execute', {
      method: 'POST',
      body: JSON.stringify({ sessionId, code, language }),
    });
    const data = (await res.json()) as Partial<CodeExecutionResult> & { error?: string };
    if (!res.ok) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        results: [],
        error: data.error || `HTTP ${res.status}`,
        sandbox: null,
      };
    }
    return {
      success: Boolean(data.success),
      stdout: data.stdout ?? '',
      stderr: data.stderr ?? '',
      results: data.results ?? [],
      error: data.error ?? null,
      sandbox: data.sandbox ?? null,
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    // Cold starts can exceed the fetch timeout on the very first call
    const friendly = /timeout|timed out|abort/i.test(message)
      ? '沙箱正在冷啟動（容器剛開機），這次逾時了。請用相同的工具與程式碼立即重試一次，通常第二次就會成功。'
      : message;
    return { success: false, stdout: '', stderr: '', results: [], error: friendly, sandbox: null };
  }
}

export async function createPreview(
  env: SandboxEnv,
  sessionId: string,
  files: Array<{ path: string; content: string }>
): Promise<{ url?: string; error?: string; sandbox: SandboxTelemetry | null }> {
  try {
    const res = await sandboxFetch(env, '/api/preview', {
      method: 'POST',
      body: JSON.stringify({ sessionId, files }),
    });
    const data = (await res.json()) as { url?: string; error?: string; sandbox?: SandboxTelemetry };
    if (!res.ok || !data.url) {
      return { error: data.error || `HTTP ${res.status}`, sandbox: null };
    }
    return { url: data.url, sandbox: data.sandbox ?? null };
  } catch (err) {
    const message = (err as Error).message || String(err);
    const friendly = /timeout|timed out|abort/i.test(message)
      ? '沙箱正在冷啟動（容器剛開機），這次逾時了。請用相同的檔案立即重試一次，通常第二次就會成功。'
      : message;
    return { error: friendly, sandbox: null };
  }
}

export async function uploadFile(
  env: SandboxEnv,
  sessionId: string,
  fileName: string,
  contentBase64: string
): Promise<{ path?: string; size?: number; error?: string }> {
  try {
    const res = await sandboxFetch(env, '/api/upload', {
      method: 'POST',
      body: JSON.stringify({ sessionId, fileName, contentBase64 }),
    });
    const data = (await res.json()) as { path?: string; size?: number; error?: string };
    if (!res.ok || !data.path) {
      return { error: data.error || `HTTP ${res.status}` };
    }
    return { path: data.path, size: data.size };
  } catch (err) {
    const message = (err as Error).message || String(err);
    const friendly = /timeout|timed out|abort/i.test(message)
      ? '沙箱啟動中或上傳逾時，請稍後再試一次。'
      : message;
    return { error: friendly };
  }
}
