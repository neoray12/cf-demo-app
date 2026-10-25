import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SYSTEM_PROMPT,
  HARNESS_SECTIONS,
  SYSTEM_PROMPT_MAX,
  composeSystemPrompt,
  systemPromptKey,
  validateSystemPrompt,
} from './system-prompt';

describe('DEFAULT_SYSTEM_PROMPT', () => {
  it('guides tool choice for the demo scenarios', () => {
    for (const s of ['Cloudflare', 'ask_saas', 'readWebPage', 'executeJs', 'searchKnowledge']) expect(DEFAULT_SYSTEM_PROMPT).toContain(s);
    expect(DEFAULT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(SYSTEM_PROMPT_MAX);
  });
});

describe('validateSystemPrompt', () => {
  it('trims and accepts a normal prompt', () => {
    expect(validateSystemPrompt('  你是助理。 \n')).toEqual({ ok: true, value: '你是助理。' });
  });

  it('rejects an empty or too long prompt', () => {
    expect(validateSystemPrompt('   ')).toEqual({ ok: false, error: 'empty' });
    expect(validateSystemPrompt('x'.repeat(SYSTEM_PROMPT_MAX + 1))).toEqual({ ok: false, error: 'too_long' });
    expect(validateSystemPrompt(42)).toEqual({ ok: false, error: 'empty' });
  });
});

describe('composeSystemPrompt', () => {
  it('always appends the safety section, so an edited prompt cannot drop the block rule', () => {
    const out = composeSystemPrompt('BASE', { sandbox: false, browser: false, dynamicWorker: false, delegate: false });
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toContain('"blocked": true');
  });

  it('adds a section only for the tools the harness gave the model', () => {
    const some = composeSystemPrompt('BASE', { sandbox: false, browser: true, dynamicWorker: false, delegate: true });
    expect(some).toContain(HARNESS_SECTIONS.find((s) => s.id === 'browser')!.text);
    expect(some).toContain(HARNESS_SECTIONS.find((s) => s.id === 'delegate')!.text);
    expect(some).not.toContain(HARNESS_SECTIONS.find((s) => s.id === 'sandbox')!.text);
  });
});

describe('systemPromptKey', () => {
  it('is per user', () => {
    expect(systemPromptKey('Neo@Cloudflare.com')).toBe('system-prompt:neo@cloudflare.com');
  });
});
