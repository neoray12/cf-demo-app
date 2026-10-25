// Auto Router candidate models: the catalog shown in the picker, and how a
// user's own selection (KV) or the wrangler default becomes the
// cf-aig-allowed-models header. Client-safe.
//
// Catalog = Cloudflare's documented default + additional Auto Router models
// (docs, 2026-10). Checked on nkcf-gateway-01 on 2026-10-25: every Anthropic and
// Workers AI model routes; OpenAI answers 400 and xAI / Fireworks 402 (no key or
// credits on this gateway). Models whose provider isn't in
// AUTO_ROUTER_ALLOWED_PROVIDERS are shown disabled.

export interface AutoRouterModel {
  id: string;
  provider: string;
  label: string;
}

export function providerOf(id: string): string {
  return id.startsWith('@cf/') ? 'workers-ai' : (id.split('/')[0] ?? id);
}

const m = (id: string, label: string): AutoRouterModel => ({ id, provider: providerOf(id), label });

export const AUTO_ROUTER_CATALOG: AutoRouterModel[] = [
  m('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5'),
  m('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'),
  m('anthropic/claude-opus-5.5', 'Claude Opus 5.5'),
  m('anthropic/claude-fable-5.1', 'Claude Fable 5.1'),
  m('anthropic/claude-fable-5', 'Claude Fable 5'),
  m('anthropic/claude-opus-5', 'Claude Opus 5'),
  m('anthropic/claude-sonnet-5', 'Claude Sonnet 5'),
  m('anthropic/claude-opus-4.8', 'Claude Opus 4.8'),
  m('anthropic/claude-sonnet-4.6', 'Claude Sonnet 4.6'),
  m('@cf/openai/gpt-oss-20b', 'GPT OSS 20B'),
  m('@cf/zai-org/glm-5.2', 'GLM 5.2'),
  m('@cf/qwen/qwen3.8-27b', 'Qwen 3.8 27B'),
  m('@cf/moonshotai/kimi-k2.7-code', 'Kimi K2.7 Code'),
  m('@cf/deepseek-ai/deepseek-v4-flash-0731', 'DeepSeek V4 Flash'),
  m('@cf/deepseek-ai/deepseek-v4-pro-0813', 'DeepSeek V4 Pro'),
  m('@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B'),
  m('openai/gpt-6-luna', 'GPT-6 Luna'),
  m('openai/gpt-6-sol', 'GPT-6 Sol'),
  m('openai/gpt-6-astra', 'GPT-6 Astra'),
  m('openai/gpt-5.6-luna', 'GPT-5.6 Luna'),
  m('openai/gpt-5.6-sol', 'GPT-5.6 Sol'),
  m('openai/gpt-5.6-terra', 'GPT-5.6 Terra'),
  m('openai/gpt-5.5', 'GPT-5.5'),
  m('xai/grok-4.6', 'Grok 4.6'),
  m('xai/grok-4.5', 'Grok 4.5'),
  m('fireworks/glm-5.3', 'GLM 5.3 (Fireworks)'),
  m('fireworks/glm-5.3-flash', 'GLM 5.3 Flash (Fireworks)'),
  m('alibaba/qwen3.8-max', 'Qwen 3.8 Max'),
  m('minimax/m3', 'MiniMax M3'),
];

const CATALOG_IDS = new Set(AUTO_ROUTER_CATALOG.map((x) => x.id));

/** A comma-separated string or an array of model ids → trimmed, unique, in order. */
export function parseModelList(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out: string[] = [];
  for (const item of items) {
    const id = typeof item === 'string' ? item.trim() : '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function validateModelSelection(
  raw: unknown,
  availableProviders: string[],
): { ok: true; value: string[] } | { ok: false; error: 'empty' | 'unknown_model' | 'unavailable_provider'; models?: string[] } {
  const list = parseModelList(raw);
  if (list.length === 0) return { ok: false, error: 'empty' };
  const unknown = list.filter((id) => !CATALOG_IDS.has(id));
  if (unknown.length) return { ok: false, error: 'unknown_model', models: unknown };
  const unavailable = list.filter((id) => !availableProviders.includes(providerOf(id)));
  if (unavailable.length) return { ok: false, error: 'unavailable_provider', models: unavailable };
  return { ok: true, value: list };
}

/** The user's own list, else the wrangler default (AUTO_ROUTER_ALLOWED_MODELS), else null = no model restriction. */
export function resolveAllowedModels(userList: string[] | null, envDefault: string | undefined): string[] | null {
  if (userList && userList.length) return userList;
  const fallback = parseModelList(envDefault);
  return fallback.length ? fallback : null;
}

export function autoRouterModelsKey(email: string): string {
  return `auto-router-models:${email.trim().toLowerCase()}`;
}
