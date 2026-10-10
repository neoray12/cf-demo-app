import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

// Clef decision models on Workers AI — no text generation, they return a
// probability for every allowed option of every typed question.
const CLEF_MODELS = ['clef', 'clef-flash', 'clef-omni'] as const;
type ClefModel = (typeof CLEF_MODELS)[number];

const QUESTION_ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,/i;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES_TOTAL = 8 * 1024 * 1024;
// Clef-omni only: audio (wav/mp3…) and video (mp4/webm) clips
const MAX_AUDIO = 4;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_VIDEOS = 2;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_MEDIA_BYTES_TOTAL = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

type Question =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

const decodedBytes = (dataUrl: string) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

function validateMedia(list: unknown, kind: 'audio' | 'video', max: number, maxEach: number): { error?: string; bytes: number } {
  if (list === undefined) return { bytes: 0 };
  if (!Array.isArray(list) || list.length > max) return { error: `${kind === 'audio' ? 'audio' : 'videos'} must be an array of at most ${max}`, bytes: 0 };
  let bytes = 0;
  for (const item of list) {
    if (typeof item !== 'string' || !item.toLowerCase().startsWith(`data:${kind}/`) || !item.includes(';base64,')) {
      return { error: `${kind} clips must be base64 data:${kind}/* URLs`, bytes: 0 };
    }
    const size = decodedBytes(item);
    if (size > maxEach) return { error: `each ${kind} clip must be at most ${maxEach / 1024 / 1024} MiB`, bytes: 0 };
    bytes += size;
  }
  return { bytes };
}

function validate(body: Record<string, unknown>): string | null {
  const { state, questions, images, audio, videos, models } = body as {
    state?: unknown;
    questions?: Record<string, Question>;
    images?: unknown;
    audio?: unknown;
    videos?: unknown;
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
      total += decodedBytes(img);
    }
    if (total > MAX_IMAGE_BYTES_TOTAL) return 'images exceed 8 MiB total';
  }
  const a = validateMedia(audio, 'audio', MAX_AUDIO, MAX_AUDIO_BYTES);
  if (a.error) return a.error;
  const v = validateMedia(videos, 'video', MAX_VIDEOS, MAX_VIDEO_BYTES);
  if (v.error) return v.error;
  if (a.bytes + v.bytes > MAX_MEDIA_BYTES_TOTAL) return 'audio and video clips exceed 16 MiB total';
  if (!Array.isArray(models) || models.length === 0 || !models.every((m) => (CLEF_MODELS as readonly string[]).includes(m))) {
    return 'models must be a non-empty subset of ["clef", "clef-flash", "clef-omni"]';
  }
  return null;
}

async function runClef(env: Record<string, unknown>, model: ClefModel, payload: Record<string, unknown>, skipGateway = false) {
  const accountId = (env.CF_ACCOUNT_ID as string) || '5efa272dc28e4e3933324c44165b6dbe';
  const gatewayId = (env.AI_GATEWAY_ID as string) || 'nkcf-gateway-01';
  const body = JSON.stringify({ ...payload, model });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const started = Date.now();

  // Prefer AI Gateway so the call shows up in gateway logs/analytics — except
  // for media requests: the gateway adds 20-35 s to large base64 bodies while
  // Workers AI answers in well under a second, which would make the latency
  // comparison meaningless.
  let via: 'ai-gateway' | 'rest' = 'ai-gateway';
  let res = skipGateway ? null : await fetch(`https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/@cf/cloudflare/${model}`, {
    method: 'POST',
    headers: {
      ...headers,
      ...(env.CF_AIG_TOKEN ? { 'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}` } : {}),
      'cf-aig-metadata': JSON.stringify({ feature: 'clef-playground' }),
      // The playground compares model latency — a cached response would skew it
      'cf-aig-skip-cache': 'true',
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

  const { state, questions, images, audio, videos, models } = body as {
    state: unknown;
    questions: Record<string, Question>;
    images?: string[];
    audio?: string[];
    videos?: string[];
    models: ClefModel[];
  };
  const payload = { state, questions, ...(images?.length ? { images } : {}) };
  // Audio/video are Clef-omni extensions — Clef and Clef-flash would reject them
  const omniMedia = { ...(audio?.length ? { audio } : {}), ...(videos?.length ? { videos } : {}) };
  const ignoredMedia = Object.keys(omniMedia);
  const hasMedia = Boolean(images?.length || audio?.length || videos?.length);

  const entries = await Promise.all(
    [...new Set(models)].map(async (m) => {
      if (m === 'clef-omni') return [m, await runClef(env as any, m, { ...payload, ...omniMedia }, hasMedia)] as const;
      const result = await runClef(env as any, m, payload, hasMedia);
      return [m, ignoredMedia.length ? { ...result, ignoredMedia } : result] as const;
    })
  );
  return Response.json({ results: Object.fromEntries(entries) });
}
