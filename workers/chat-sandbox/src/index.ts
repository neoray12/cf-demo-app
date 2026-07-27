/**
 * Chat Sandbox Companion Worker
 *
 * Provides sandboxed Python code execution and static web previews for the
 * cf-demo-app chatbot. Called via HTTP with a shared secret for authentication.
 *
 * One sandbox per chat session — executeCode and createWebPreview share state.
 * The Sandbox SDK handles container lifecycle (start, sleep, wake).
 */

import { Hono } from 'hono';
import { getSandbox, proxyToSandbox, Sandbox } from '@cloudflare/sandbox';
export { Sandbox };

// Keep containers alive between tool calls in the same conversation.
// Preview URLs die when the container sleeps, so this is also the preview TTL.
const DEFAULT_SLEEP_AFTER = '20m';

const EXEC_TIMEOUT_MS = 30_000;
const PREVIEW_PORT = 8000;
const PREVIEW_DIR = '/workspace/preview';
// Fixed token → stable preview URL per sandbox across re-deploys of the page
const PREVIEW_TOKEN = 'preview';

const UPLOAD_DIR = '/workspace/uploads';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB — generous for a demo CSV/XLSX
const ALLOWED_UPLOAD_EXTENSIONS = ['.csv', '.xlsx'];

// Decoded byte length of a base64 string, without actually materializing
// the bytes — just for the size-limit check before writing.
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// Container cold start needs more headroom than SDK defaults (30s/90s)
const CONTAINER_TIMEOUTS = {
  instanceGetTimeoutMS: 60_000,
  portReadyTimeoutMS: 120_000,
};

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  SANDBOX_API_SECRET: string;
  KV: KVNamespace;
  AVOID_COLOS?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Sandbox IDs become DNS labels in preview URLs — enforce a safe charset here
// as defense in depth (the main app sanitizes too).
function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}

function sandboxFor(env: Env, sessionId: string) {
  return getSandbox(env.Sandbox, sessionId, {
    sleepAfter: DEFAULT_SLEEP_AFTER,
    containerTimeouts: CONTAINER_TIMEOUTS,
  });
}

// ── Colo avoidance ──
//
// Containers placement constraints stop at region granularity (APAC etc.) —
// there is no way to exclude a specific city like HKG in wrangler config.
// Placement also fixes a Durable Object's location at first creation, so the
// only lever we have is the sandbox ID itself: probe where a fresh sandbox
// landed, and if it's in an avoided colo, destroy it and re-roll with a new
// generation-suffixed ID (sbx-xxx → sbx-xxx-g2 → sbx-xxx-g3). The winning ID
// is pinned in KV so every later request in the session reuses the same
// container. Costs extra cold starts on unlucky rolls and is best-effort —
// if every attempt lands in an avoided colo, the last roll is kept.

const COLO_PIN_PREFIX = 'chat-sandbox:colo-pin:';
const COLO_PIN_TTL_SECONDS = 60 * 60 * 24; // sandboxes sleep after 20m; 24h is plenty
const MAX_PLACEMENT_ATTEMPTS = 3;

function avoidedColos(env: Env): string[] {
  return (env.AVOID_COLOS || '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

// Boots the container (if needed) and asks where its egress actually is.
// -k because local dev behind WARP/Zero Trust MITMs container egress with a
// CA the image doesn't trust; we only parse the colo= line, so this is fine.
async function probeColo(sandbox: ReturnType<typeof getSandbox>): Promise<string | null> {
  const trace = await sandbox
    .exec('curl -sk --max-time 2 https://cloudflare.com/cdn-cgi/trace', { timeout: TRACE_TIMEOUT_MS })
    .catch(() => null);
  if (!trace?.success) return null;
  return trace.stdout.match(/colo=([A-Z]{3})/)?.[1] ?? null;
}

async function resolveSandboxId(env: Env, sessionId: string): Promise<string> {
  const avoid = avoidedColos(env);
  if (avoid.length === 0) return sessionId;

  const pinKey = `${COLO_PIN_PREFIX}${sessionId}`;
  const pinned = await env.KV.get(pinKey);
  if (pinned) return pinned;

  let chosen = sessionId;
  for (let gen = 1; gen <= MAX_PLACEMENT_ATTEMPTS; gen++) {
    const candidateId = gen === 1 ? sessionId : `${sessionId}-g${gen}`;
    chosen = candidateId;
    const colo = await probeColo(sandboxFor(env, candidateId));
    // Unknown colo → accept rather than churn containers on a flaky probe
    if (!colo || !avoid.includes(colo)) {
      if (colo && gen > 1) console.log(`[PLACEMENT] ${sessionId}: re-rolled to ${candidateId} (${colo})`);
      break;
    }
    console.log(`[PLACEMENT] ${sessionId}: attempt ${gen} (${candidateId}) landed in avoided colo ${colo}`);
    if (gen < MAX_PLACEMENT_ATTEMPTS) {
      await sandboxFor(env, candidateId).destroy().catch(() => {});
    }
  }

  // Two concurrent first-requests can race here; last write wins, and both
  // containers exist briefly — harmless for a demo, sleepAfter reaps the loser.
  const existing = await env.KV.get(pinKey);
  if (existing) return existing;
  await env.KV.put(pinKey, chosen, { expirationTtl: COLO_PIN_TTL_SECONDS });
  return chosen;
}

// Demo-facing telemetry: which physical container/POP actually ran the code,
// and whether this was a fresh container boot or a reused (warm) one.
interface SandboxTelemetry {
  sandboxId: string;
  containerId: string | null;
  colo: string | null;
  uptimeSeconds: number | null;
  coldStart: boolean | null;
}

const TRACE_TIMEOUT_MS = 4000;
const MARKER_PATH = '/tmp/.cf-chat-sandbox-init';

// /proc/uptime is unreliable for cold-start detection: on some container
// runtimes (confirmed on local Docker dev) it reflects the shared host
// kernel's boot time, not the individual container's — two brand-new
// sandboxes reported near-identical uptime. A filesystem sentinel is
// runtime-agnostic: it's guaranteed absent on a fresh container (sleepAfter
// destroys the container and wipes its filesystem) and guaranteed present
// once any prior call in this container's lifetime has run.
const MARKER_CMD =
  `NOW=$(date +%s); if [ -f ${MARKER_PATH} ]; then FIRST=$(cat ${MARKER_PATH}); STATUS=warm; ` +
  `else echo $NOW > ${MARKER_PATH}; FIRST=$NOW; STATUS=cold; fi; echo "$STATUS $FIRST $NOW"`;

async function getSandboxTelemetry(sandbox: ReturnType<typeof getSandbox>, sandboxId: string): Promise<SandboxTelemetry> {
  const [hostnameResult, markerResult, traceResult] = await Promise.all([
    sandbox.exec('hostname').catch(() => null),
    sandbox.exec(`sh -c '${MARKER_CMD}'`).catch(() => null),
    // Container's own outbound trace — reveals the colo its network egress
    // is routed through, which is not necessarily the same colo that served
    // the original chat request (that's request.cf.colo on the main app).
    sandbox
      .exec('curl -sk --max-time 2 https://cloudflare.com/cdn-cgi/trace', { timeout: TRACE_TIMEOUT_MS })
      .catch(() => null),
  ]);

  const containerId = hostnameResult?.success ? hostnameResult.stdout.trim() : null;

  let uptimeSeconds: number | null = null;
  let coldStart: boolean | null = null;
  if (markerResult?.success) {
    const [status, first, now] = markerResult.stdout.trim().split(/\s+/);
    const firstNum = parseInt(first ?? '', 10);
    const nowNum = parseInt(now ?? '', 10);
    if (!Number.isNaN(firstNum) && !Number.isNaN(nowNum)) {
      uptimeSeconds = Math.max(0, nowNum - firstNum);
      coldStart = status === 'cold';
    }
  }

  let colo: string | null = null;
  if (traceResult?.success) {
    const match = traceResult.stdout.match(/colo=([A-Z]{3})/);
    colo = match?.[1] ?? null;
  }

  return { sandboxId, containerId, colo, uptimeSeconds, coldStart };
}

// Auth middleware — validate shared secret for all API routes
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
app.get('/health', (c) => c.json({ ok: true, service: 'chat-sandbox' }));

/**
 * POST /api/execute
 * Run code in the session's sandbox via the code interpreter.
 * Body: { sessionId, code, language? }
 */
app.post('/api/execute', async (c) => {
  const body = await c.req.json<{ sessionId?: string; code?: string; language?: string }>();
  const { sessionId, code } = body;
  const language = (body.language || 'python') as 'python' | 'javascript' | 'typescript';

  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid sessionId (lowercase alphanumeric + hyphens, max 32 chars)' }, 400);
  }
  if (!code || typeof code !== 'string') {
    return c.json({ error: 'Missing code' }, 400);
  }
  if (!['python', 'javascript', 'typescript'].includes(language)) {
    return c.json({ error: `Unsupported language: ${language}` }, 400);
  }

  console.log(`[EXECUTE] ${sessionId}: ${language}, ${code.length} chars`);
  const resolvedId = await resolveSandboxId(c.env, sessionId);
  const sandbox = sandboxFor(c.env, resolvedId);

  try {
    const [execution, sandboxInfo] = await Promise.all([
      sandbox.runCode(code, { language, timeout: EXEC_TIMEOUT_MS }),
      getSandboxTelemetry(sandbox, resolvedId),
    ]);
    // runCode() can return rich output (e.g. matplotlib charts) alongside
    // text — png/jpeg used to be silently dropped here, keeping only .text.
    const results = (execution.results ?? [])
      .map((r) => ({
        text: r.text ?? null,
        image: r.png ? `data:image/png;base64,${r.png}` : r.jpeg ? `data:image/jpeg;base64,${r.jpeg}` : null,
      }))
      .filter((r) => r.text || r.image);

    return c.json({
      success: !execution.error,
      stdout: execution.logs?.stdout?.join('\n') ?? '',
      stderr: execution.logs?.stderr?.join('\n') ?? '',
      results,
      error: execution.error ? `${execution.error.name}: ${execution.error.message}` : null,
      sandbox: sandboxInfo,
    });
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.error(`[EXECUTE] ${sessionId} failed:`, message);
    return c.json(
      { success: false, stdout: '', stderr: '', results: [], error: message },
      502
    );
  }
});

/**
 * POST /api/preview
 * Write static files into the sandbox, serve them, and return a public preview URL.
 * Body: { sessionId, files: [{ path, content }] }
 */
app.post('/api/preview', async (c) => {
  const body = await c.req.json<{
    sessionId?: string;
    files?: Array<{ path?: string; content?: string }>;
  }>();
  const { sessionId, files } = body;

  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid sessionId (lowercase alphanumeric + hyphens, max 32 chars)' }, 400);
  }
  if (!Array.isArray(files) || files.length === 0) {
    return c.json({ error: 'Missing files' }, 400);
  }
  for (const f of files) {
    if (!f.path || typeof f.content !== 'string') {
      return c.json({ error: 'Each file needs a path and content' }, 400);
    }
    // Flat, relative paths only — these live under PREVIEW_DIR
    if (f.path.startsWith('/') || f.path.includes('..') || f.path.includes('\\')) {
      return c.json({ error: `Invalid file path: ${f.path}` }, 400);
    }
  }
  if (!files.some((f) => f.path === 'index.html')) {
    return c.json({ error: 'files must include index.html' }, 400);
  }

  console.log(`[PREVIEW] ${sessionId}: ${files.length} file(s)`);
  const resolvedId = await resolveSandboxId(c.env, sessionId);
  const sandbox = sandboxFor(c.env, resolvedId);

  try {
    // Fresh preview dir so stale files from a previous preview don't linger
    await sandbox.exec(`rm -rf ${PREVIEW_DIR} && mkdir -p ${PREVIEW_DIR}`);
    for (const f of files) {
      const filePath = `${PREVIEW_DIR}/${f.path}`;
      const dir = filePath.slice(0, filePath.lastIndexOf('/'));
      if (dir !== PREVIEW_DIR) {
        await sandbox.mkdir(dir, { recursive: true });
      }
      await sandbox.writeFile(filePath, f.content as string);
    }

    // Idempotent server start: kill any previous static server, start fresh
    await sandbox.exec('pkill -f "http.server" || true');
    const proc = await sandbox.startProcess(
      `python3 -m http.server ${PREVIEW_PORT} --directory ${PREVIEW_DIR}`
    );
    // startProcess() resolves once the process is spawned, not once it's
    // actually accepting connections — exposing/returning the URL before the
    // server is listening is what produced the "refused to connect" preview
    // pages. Block until it's really answering HTTP requests.
    await proc.waitForPort(PREVIEW_PORT, { timeout: 10_000 });

    const hostname = c.req.header('host') || new URL(c.req.url).host;
    let url: string;
    try {
      const exposed = await sandbox.exposePort(PREVIEW_PORT, {
        hostname,
        token: PREVIEW_TOKEN,
      });
      url = exposed.url;
    } catch {
      // Port already exposed from an earlier preview in this session — re-derive
      const ports = await sandbox.getExposedPorts(hostname);
      const existing = ports.find((p) => p.port === PREVIEW_PORT);
      if (!existing) throw new Error('Failed to expose preview port');
      url = existing.url;
    }

    // waitForPort() only confirms the server is listening *inside* the
    // container — the public preview URL (edge → DO → container) can still
    // take a beat to become reachable on a fresh cold-started container,
    // which is what produced "refused to connect" even after that fix.
    // Poll the actual public URL the browser will hit before declaring ready.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const probe = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (probe.ok || probe.status < 500) break;
      } catch {
        // Not reachable yet — retry
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    const sandboxInfo = await getSandboxTelemetry(sandbox, resolvedId);
    return c.json({ url, fileCount: files.length, sandbox: sandboxInfo });
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.error(`[PREVIEW] ${sessionId} failed:`, message);
    return c.json({ error: message }, 502);
  }
});

/**
 * POST /api/upload
 * Write an uploaded CSV/XLSX into the session's sandbox so executeCode can
 * read it with pandas. Body: { sessionId, fileName, contentBase64 }
 */
app.post('/api/upload', async (c) => {
  const body = await c.req.json<{ sessionId?: string; fileName?: string; contentBase64?: string }>();
  const { sessionId, fileName, contentBase64 } = body;

  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid sessionId (lowercase alphanumeric + hyphens, max 32 chars)' }, 400);
  }
  if (!fileName || typeof fileName !== 'string' || /[/\\]/.test(fileName) || fileName.includes('..')) {
    return c.json({ error: 'Invalid fileName' }, 400);
  }
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
    return c.json({ error: `Unsupported file type: ${ext}. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}` }, 400);
  }
  if (!contentBase64 || typeof contentBase64 !== 'string') {
    return c.json({ error: 'Missing contentBase64' }, 400);
  }

  const size = base64ByteLength(contentBase64);
  if (size > MAX_UPLOAD_BYTES) {
    return c.json({ error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)` }, 400);
  }

  console.log(`[UPLOAD] ${sessionId}: ${fileName} (${size} bytes)`);
  const resolvedId = await resolveSandboxId(c.env, sessionId);
  const sandbox = sandboxFor(c.env, resolvedId);
  const path = `${UPLOAD_DIR}/${fileName}`;

  try {
    await sandbox.mkdir(UPLOAD_DIR, { recursive: true });
    // XLSX is a binary zip container — write via base64 so it round-trips
    // intact instead of being mangled as UTF-8 text.
    await sandbox.writeFile(path, contentBase64, { encoding: 'base64' });
    return c.json({ path, size });
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.error(`[UPLOAD] ${sessionId} failed:`, message);
    return c.json({ error: message }, 502);
  }
});

/**
 * DELETE /api/session/:sessionId
 * Explicit cleanup — destroys the container. Normally sleepAfter handles this.
 */
app.delete('/api/session/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid sessionId' }, 400);
  }
  try {
    const resolvedId = await resolveSandboxId(c.env, sessionId);
    await sandboxFor(c.env, resolvedId).destroy();
    await c.env.KV.delete(`${COLO_PIN_PREFIX}${sessionId}`).catch(() => {});
    return c.json({ success: true });
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 502);
  }
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // MUST run before Hono: routes preview-subdomain requests
    // (8000-sbx-xxx-token.chat-sandbox.neokung.work) into the container.
    // Skipping this would send them into the bearer-auth middleware → 401.
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    return app.fetch(request, env, ctx);
  },
};
