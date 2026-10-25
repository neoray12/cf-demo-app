// Token usage as the model actually consumed it. Through AI Gateway's compat
// endpoint, Anthropic responses served via Auto Router (which turns on prompt
// caching) report prompt_tokens WITHOUT the cached part — reads in
// prompt_tokens_details.cached_tokens, writes in cache_write_tokens — so a 4,011
// token prompt shows as 4. OpenAI-style providers already count cached tokens
// inside prompt_tokens. Verified against the AI Gateway logs on 2026-10-25.
import { providerOf } from './auto-router-models';

interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_write_1h_tokens?: number } | null;
  [k: string]: unknown;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The provider whose usage semantics apply: the routed model for Auto Router, else the requested compat model. */
export function usageProvider(compatModelId: string, routedModel: string | null): string {
  if (routedModel) return providerOf(routedModel);
  if (compatModelId.startsWith('workers-ai/')) return 'workers-ai';
  return compatModelId.split('/')[0] ?? compatModelId;
}

export function normalizeStreamUsage<T extends StreamUsage>(usage: T, provider: string): T {
  const d = usage.prompt_tokens_details;
  if (provider !== 'anthropic' || !d) return usage;
  const cached = n(d.cached_tokens) + n(d.cache_write_tokens) + n(d.cache_write_1h_tokens);
  if (cached === 0) return usage;
  const prompt = n(usage.prompt_tokens) + cached;
  return { ...usage, prompt_tokens: prompt, total_tokens: prompt + n(usage.completion_tokens) };
}

/**
 * Line-buffered rewrite of an OpenAI-compatible SSE stream: complete `data:`
 * lines get their usage normalized and a numeric delta.content coerced to a
 * string (some Workers AI models send numbers); a line split across network
 * chunks waits for its end. `provider()` is asked when a line is processed.
 */
export function createSseFixer(provider: () => string): { push(chunk: string): string; flush(): string } {
  let pending = '';
  const fixLine = (raw: string): string => {
    const cr = raw.endsWith('\r') ? '\r' : '';
    const line = cr ? raw.slice(0, -1) : raw;
    const m = /^data: (\{.*\})$/.exec(line);
    if (!m) return raw;
    try {
      const obj = JSON.parse(m[1]!);
      if (Array.isArray(obj?.choices)) {
        for (const choice of obj.choices) {
          if (choice?.delta && typeof choice.delta.content !== 'string' && choice.delta.content != null) {
            choice.delta.content = String(choice.delta.content);
          }
        }
      }
      if (obj?.usage && typeof obj.usage === 'object') obj.usage = normalizeStreamUsage(obj.usage, provider());
      return `data: ${JSON.stringify(obj)}${cr}`;
    } catch {
      return raw;
    }
  };
  return {
    push(chunk) {
      const text = pending + chunk;
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) {
        pending = text;
        return '';
      }
      pending = text.slice(lastNewline + 1);
      return text
        .slice(0, lastNewline + 1)
        .split('\n')
        .map((l, i, all) => (i === all.length - 1 ? l : fixLine(l)))
        .join('\n');
    },
    flush() {
      const rest = pending;
      pending = '';
      return rest ? fixLine(rest) : '';
    },
  };
}
