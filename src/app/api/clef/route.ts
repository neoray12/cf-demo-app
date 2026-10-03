import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

// Clef decision models on Workers AI — no text generation, they return a
// probability for every allowed option of every typed question.
const CLEF_MODELS = ['clef', 'clef-flash'] as const;
type ClefModel = (typeof CLEF_MODELS)[number];

const QUESTION_ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,/i;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES_TOTAL = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

type Question =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

function validate(body: Record<string, unknown>): string | null {
  const { state, questions, images, models } = body as {
    state?: unknown;
    questions?: Record<string, Question>;
    images?: unknown;
    models?: unknown;
  };
  if (state === undefined || state === null || (typeof state === 'string' && !state.trim())) return 'state is required';
  if (!questions || typeof questions !== 'object') return 'questions is required';
  const entries = Object.entries(questions);
  if (entries.length < 1 || entries.length > 64) return 'questions must contain 1-64 entries';
  for (const [id, q] of entries) {
    if (!QUESTION_ID_RE.test(id)) return `invalid question id "${id}" (letters, digits, _ . - ; max 100)`;
    if (!q?.instructions || (typeof q.instructions === 'string' && !q.instructions.trim())) return `question "${id}": instructions is required`;
    if (q.type === 'choice') {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2 || n > 255) return `question "${id}": choice needs 2-255 options`;
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) return `question "${id}": score needs 2-10 levels`;
    } else if (q.type !== 'noul') {
      return `question "${id}": unknown type`;
    }
  }
  if (images !== undefined) {
    if (!Array.isArray(images) || images.length > MAX_IMAGES) return `images must be an array of at most ${MAX_IMAGES}`;
    let total = 0;
    for (const img of images) {
      if (typeof img !== 'string' || !IMAGE_DATA_URL_RE.test(img)) return 'images must be PNG/JPEG/WebP data URLs';
      total += Math.floor(((img.length - img.indexOf(',') - 1) * 3) / 4);
    }
    if (total > MAX_IMAGE_BYTES_TOTAL) return 'images exceed 8 MiB total';
  }
  if (!Array.isArray(models) || models.length === 0 || !models.every((m) => (CLEF_MODELS as readonly string[]).includes(m))) {
    return 'models must be a non-empty subset of ["clef", "clef-flash"]';
  }
  return null;
}

async function runClef(env: Record<string, unknown>, model: ClefModel, payload: Record<string, unknown>) {
  const accountId = (env.CF_ACCOUNT_ID as string) || '5efa272dc28e4e3933324c44165b6dbe';
  const gatewayId = (env.AI_GATEWAY_ID as string) || 'nkcf-gateway-01';
  const body = JSON.stringify({ ...payload, model });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const started = Date.now();

  // Prefer AI Gateway so the call shows up in gateway logs/analytics
  let via: 'ai-gateway' | 'rest' = 'ai-gateway';
  let res = await fetch(`https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/@cf/cloudflare/${model}`, {
    method: 'POST',
    headers: {
      ...headers,
      ...(env.CF_AIG_TOKEN ? { 'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}` } : {}),
      'cf-aig-metadata': JSON.stringify({ feature: 'clef-playground' }),
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);

  if (!res || res.status >= 500 || res.status === 404) {
    via = 'rest';
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  const latencyMs = Date.now() - started;
  const data = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: { model: string; answers: Record<string, unknown>; usage: { input_tokens: number; output_tokens: number } };
    errors?: Array<{ message: string }>;
  };
  if (!res.ok || !data.result) {
    return { error: data.errors?.[0]?.message ?? `HTTP ${res.status}`, latencyMs, via };
  }
  return { ...data.result, latencyMs, via, logId: res.headers.get('cf-aig-log-id') };
}

export async function POST(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: 'invalid JSON body' }, { status: 400 });

  const invalid = validate(body);
  if (invalid) return Response.json({ error: invalid }, { status: 400 });
  if (!(env as any).CF_API_TOKEN) return Response.json({ error: 'CF_API_TOKEN not configured' }, { status: 500 });

  const { state, questions, images, models } = body as {
    state: unknown;
    questions: Record<string, Question>;
    images?: string[];
    models: ClefModel[];
  };
  const payload = { state, questions, ...(images?.length ? { images } : {}) };

  const entries = await Promise.all(
    [...new Set(models)].map(async (m) => [m, await runClef(env as any, m, payload)] as const)
  );
  return Response.json({ results: Object.fromEntries(entries) });
}
