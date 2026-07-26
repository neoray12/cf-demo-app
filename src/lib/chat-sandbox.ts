/**
 * Chat Sandbox client — calls the cf-chat-sandbox companion worker.
 * Powers the executeCode / createWebPreview chat tools.
 */

interface SandboxEnv {
  CHAT_SANDBOX_URL?: string;
  CHAT_SANDBOX_SECRET?: string;
}

const FETCH_TIMEOUT_MS = 45_000;

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

export interface CodeExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  results: string[];
  error: string | null;
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
      };
    }
    return {
      success: Boolean(data.success),
      stdout: data.stdout ?? '',
      stderr: data.stderr ?? '',
      results: data.results ?? [],
      error: data.error ?? null,
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    // Cold starts can exceed the fetch timeout on the very first call
    const friendly = /timeout|timed out|abort/i.test(message)
      ? '沙箱啟動中或執行逾時，請稍後再試一次。'
      : message;
    return { success: false, stdout: '', stderr: '', results: [], error: friendly };
  }
}

export async function createPreview(
  env: SandboxEnv,
  sessionId: string,
  files: Array<{ path: string; content: string }>
): Promise<{ url?: string; error?: string }> {
  try {
    const res = await sandboxFetch(env, '/api/preview', {
      method: 'POST',
      body: JSON.stringify({ sessionId, files }),
    });
    const data = (await res.json()) as { url?: string; error?: string };
    if (!res.ok || !data.url) {
      return { error: data.error || `HTTP ${res.status}` };
    }
    return { url: data.url };
  } catch (err) {
    const message = (err as Error).message || String(err);
    const friendly = /timeout|timed out|abort/i.test(message)
      ? '沙箱啟動中或部署逾時，請稍後再試一次。'
      : message;
    return { error: friendly };
  }
}
