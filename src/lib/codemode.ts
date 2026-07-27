/**
 * Code Mode — collapse the whole tool set into a single tool.
 *
 * Instead of the model stepping through N tool-call rounds, it writes ONE
 * JavaScript script that calls the tools as functions. The script runs in a
 * Dynamic Worker (V8 isolate); its `globalOutbound` is pointed at this same
 * Worker, so `codemode.<tool>()` proxy calls come back to /api/codemode-exec
 * while any *other* fetch the script attempts never reaches the internet.
 *
 * This is a hand-rolled equivalent of @cloudflare/codemode — that package
 * imports `cloudflare:workers` at module scope, which OpenNext's webpack pass
 * can't resolve, so it cannot be used from a Next.js route.
 */

// Per-request token: the sandbox must present it to call tools back, so a
// stray fetch from generated code can't invoke tools on its own.
export interface CodeModeSession {
  token: string;
  toolNames: string[];
}

const sessions = new Map<string, { toolNames: string[]; expiresAt: number }>();
const SESSION_TTL_MS = 120_000;

export function createCodeModeSession(toolNames: string[]): CodeModeSession {
  const token = crypto.randomUUID();
  sessions.set(token, { toolNames, expiresAt: Date.now() + SESSION_TTL_MS });
  // Opportunistic cleanup — this map lives only for the isolate's lifetime
  for (const [k, v] of sessions) if (v.expiresAt < Date.now()) sessions.delete(k);
  return { token, toolNames };
}

export function isValidCodeModeToken(token: string, toolName: string): boolean {
  const s = sessions.get(token);
  if (!s || s.expiresAt < Date.now()) return false;
  return s.toolNames.includes(toolName);
}

/**
 * Human-readable signature list injected into the tool description.
 *
 * Keep this format EXACTLY as-is. Two attempts to enrich it with return-type
 * information (object literals, then plain field lists) both broke tool-call
 * argument generation on gpt-oss-120b — the stream emitted tool-call-start
 * with no matching tool-call, 3 runs out of 3, and the chat fell through to
 * the "no reply" fallback. Return-shape guidance lives in the system prompt
 * instead, where it doesn't perturb argument generation.
 */
export function describeTools(tools: Record<string, { description?: string }>): string {
  return Object.entries(tools)
    .map(([name, t]) => `  codemode.${name}(args) — ${t.description?.split('\n')[0] ?? ''}`)
    .join('\n');
}

/** Return-shape hints — carried in the system prompt, not the tool schema. */
export const RETURN_SHAPE_HINT =
  '工具回傳的都是物件而非字串，主要欄位：readWebPage 回 url/markdown/truncated；' +
  'executeCode 回 success/stdout/stderr/error；captureScreenshot 回 imageUrl/sourceUrl；' +
  'createWebPreview 回 url/title；searchKnowledge 回 found/count/results。';

/**
 * Models write the script in one of three shapes; normalize them all into
 * statements that end in a `return`, so the harness's wrapper actually
 * captures the value. Without this an IIFE body evaluates and is discarded,
 * the tool returns null, and the model happily invents an answer.
 */
export function normalizeCode(raw: string): string {
  const code = raw.trim().replace(/;\s*$/, '');
  // IIFE: (async () => { ... })()  /  (function(){...})()
  if (/^\(/.test(code) && /\)\s*\(\s*\)$/.test(code)) {
    return `return await ${code};`;
  }
  // Bare function expression: async () => { ... }  /  async function () {...}
  if (/^async\s*\(/.test(code) || /^\(\s*\)\s*=>/.test(code) || /^async\s+function\b/.test(code) || /^function\b/.test(code)) {
    return `return await (${code})();`;
  }
  // Plain statement list — assumed to contain its own return / console.log
  return code;
}

/** The module that wraps the model's script inside the Dynamic Worker. */
export function buildCodeModeModule(userCode: string, token: string): string {
  return `
    const codemode = new Proxy({}, {
      get: (_t, name) => async (args) => {
        const res = await fetch('https://codemode.internal/api/codemode-exec', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(token)}, name: String(name), args: args ?? {} }),
        });
        if (!res.ok) throw new Error('tool ' + String(name) + ' failed: HTTP ' + res.status);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data.result;
      },
    });

    export default {
      async fetch() {
        const logs = [];
        const console = {
          log: (...a) => logs.push(a.map((x) => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')),
          error: (...a) => logs.push('[error] ' + a.map(String).join(' ')),
          warn: (...a) => logs.push('[warn] ' + a.map(String).join(' ')),
        };
        let result = null, error = null;
        try {
          result = await (async () => {
            ${normalizeCode(userCode)}
          })();
        } catch (e) {
          error = String(e && e.message ? e.message : e);
        }
        return Response.json({ logs, result: result === undefined ? null : result, error });
      },
    };
  `;
}
