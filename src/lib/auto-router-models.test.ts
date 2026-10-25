import { describe, it, expect } from 'vitest';
import {
  AUTO_ROUTER_CATALOG,
  autoRouterModelsKey,
  parseModelList,
  providerOf,
  resolveAllowedModels,
  validateModelSelection,
} from './auto-router-models';

const providers = ['anthropic', 'workers-ai'];

describe('providerOf', () => {
  it('maps @cf models to workers-ai and others to their prefix', () => {
    expect(providerOf('@cf/openai/gpt-oss-20b')).toBe('workers-ai');
    expect(providerOf('anthropic/claude-haiku-5.5')).toBe('anthropic');
  });
});

describe('AUTO_ROUTER_CATALOG', () => {
  it('lists the models verified on this gateway, with unique ids', () => {
    const ids = AUTO_ROUTER_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['anthropic/claude-haiku-5.5', '@cf/qwen/qwen3.8-27b', 'openai/gpt-6-luna']) expect(ids).toContain(id);
  });
});

describe('parseModelList', () => {
  it('accepts a comma string or an array, trims and de-duplicates', () => {
    expect(parseModelList(' anthropic/claude-haiku-5.5, @cf/openai/gpt-oss-20b ,anthropic/claude-haiku-5.5')).toEqual([
      'anthropic/claude-haiku-5.5',
      '@cf/openai/gpt-oss-20b',
    ]);
    expect(parseModelList(['a/b', ' ', 'a/b'])).toEqual(['a/b']);
    expect(parseModelList(undefined)).toEqual([]);
  });
});

describe('validateModelSelection', () => {
  it('accepts catalog models of providers the gateway can use', () => {
    expect(validateModelSelection(['anthropic/claude-haiku-5.5', '@cf/zai-org/glm-5.2'], providers)).toEqual({
      ok: true,
      value: ['anthropic/claude-haiku-5.5', '@cf/zai-org/glm-5.2'],
    });
  });

  it('rejects an empty list, unknown models and providers without credentials', () => {
    expect(validateModelSelection([], providers)).toEqual({ ok: false, error: 'empty' });
    expect(validateModelSelection(['openai/no-such-model'], providers)).toEqual({ ok: false, error: 'unknown_model', models: ['openai/no-such-model'] });
    expect(validateModelSelection(['openai/gpt-6-luna'], providers)).toEqual({ ok: false, error: 'unavailable_provider', models: ['openai/gpt-6-luna'] });
  });
});

describe('resolveAllowedModels', () => {
  it("prefers the user's own list, then the wrangler default, else no restriction", () => {
    expect(resolveAllowedModels(['anthropic/claude-sonnet-5.5'], 'anthropic/claude-haiku-5.5')).toEqual(['anthropic/claude-sonnet-5.5']);
    expect(resolveAllowedModels(null, 'anthropic/claude-haiku-5.5, @cf/openai/gpt-oss-20b')).toEqual([
      'anthropic/claude-haiku-5.5',
      '@cf/openai/gpt-oss-20b',
    ]);
    expect(resolveAllowedModels(null, '')).toBeNull();
  });
});

describe('autoRouterModelsKey', () => {
  it('is per user', () => {
    expect(autoRouterModelsKey('Neo@Cloudflare.com')).toBe('auto-router-models:neo@cloudflare.com');
  });
});
