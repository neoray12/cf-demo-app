import { describe, it, expect } from 'vitest';
import { createSseFixer, normalizeStreamUsage, usageProvider } from './usage-normalize';

describe('normalizeStreamUsage', () => {
  it('adds Anthropic cache writes back into prompt_tokens (Auto Router reports them separately)', () => {
    const u = { prompt_tokens: 4, completion_tokens: 10, total_tokens: 14, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4007, cache_write_1h_tokens: 0 } };
    expect(normalizeStreamUsage(u, 'anthropic')).toEqual({ ...u, prompt_tokens: 4011, total_tokens: 4021 });
  });

  it('adds Anthropic cache reads back too', () => {
    const u = { prompt_tokens: 2, completion_tokens: 440, total_tokens: 442, prompt_tokens_details: { cached_tokens: 5285, cache_write_tokens: 509 } };
    expect(normalizeStreamUsage(u, 'anthropic')).toMatchObject({ prompt_tokens: 5796, total_tokens: 6236 });
  });

  it('leaves OpenAI-style usage alone (cached_tokens is already part of prompt_tokens)', () => {
    const u = { prompt_tokens: 5000, completion_tokens: 10, total_tokens: 5010, prompt_tokens_details: { cached_tokens: 3000 } };
    expect(normalizeStreamUsage(u, 'openai')).toBe(u);
    expect(normalizeStreamUsage(u, 'workers-ai')).toBe(u);
  });

  it('leaves Anthropic usage without cache details alone (direct calls already include everything)', () => {
    const u = { prompt_tokens: 4011, completion_tokens: 10, total_tokens: 4021 };
    expect(normalizeStreamUsage(u, 'anthropic')).toBe(u);
  });
});

describe('usageProvider', () => {
  it('uses the routed model for Auto Router, else the requested model', () => {
    expect(usageProvider('cloudflare/auto', 'anthropic/claude-sonnet-5.5')).toBe('anthropic');
    expect(usageProvider('cloudflare/auto', '@cf/zai-org/glm-5.2')).toBe('workers-ai');
    expect(usageProvider('anthropic/claude-haiku-5-5', null)).toBe('anthropic');
    expect(usageProvider('workers-ai/@cf/openai/gpt-oss-120b', null)).toBe('workers-ai');
  });
});

describe('createSseFixer', () => {
  const usageLine =
    'data: {"choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":4,"completion_tokens":10,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":4007}}}\n\n';

  it('fixes an Anthropic usage line even when it is split across network chunks', () => {
    const fixer = createSseFixer(() => 'anthropic');
    const mid = 60;
    const out = fixer.push(usageLine.slice(0, mid)) + fixer.push(usageLine.slice(mid)) + fixer.flush();
    expect(out).toContain('"prompt_tokens":4011');
    expect(out).toContain('"total_tokens":4021');
    expect(out.endsWith('\n\n')).toBe(true);
  });

  it('coerces a numeric delta.content to a string and passes other lines through', () => {
    const fixer = createSseFixer(() => 'workers-ai');
    const out = fixer.push('data: {"choices":[{"delta":{"content":42}}]}\n') + fixer.push('data: [DONE]\n') + fixer.flush();
    expect(out).toBe('data: {"choices":[{"delta":{"content":"42"}}]}\ndata: [DONE]\n');
  });

  it('keeps CRLF line endings while fixing the line', () => {
    const fixer = createSseFixer(() => 'anthropic');
    const out = fixer.push(usageLine.replace(/\n/g, '\r\n')) + fixer.flush();
    expect(out).toContain('"prompt_tokens":4011');
    expect(out.endsWith('}\r\n\r\n')).toBe(true);
  });

  it('decides the provider when the usage line arrives (Auto Router headers come first)', () => {
    let provider = 'unknown';
    const fixer = createSseFixer(() => provider);
    provider = 'anthropic';
    expect(fixer.push(usageLine)).toContain('"prompt_tokens":4011');
  });
});
