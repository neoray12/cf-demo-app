import { describe, it, expect } from 'vitest';
import { CODE_MODE_EXAMPLES, compareRuns, comparisonModel } from './experiment-compare';
import { DEFAULT_MODEL_ID } from './types';
import zhTW from '../i18n/zh-TW.json';
import en from '../i18n/en.json';
import type { TraceSummary } from './trace-summary';

const off: TraceSummary = { totalMs: 20000, ttftMs: 4000, modelCalls: 8, toolCalls: 6, subagents: 1, inputTokens: 10000, outputTokens: 800 };
const on: TraceSummary = { totalMs: 9000, ttftMs: 3000, modelCalls: 4, toolCalls: 2, subagents: 1, inputTokens: 2500, outputTokens: 900 };

describe('compareRuns', () => {
  it('lists the six metrics in order with the on-vs-off change', () => {
    const rows = compareRuns(off, on);
    expect(rows.map((r) => r.key)).toEqual(['inputTokens', 'outputTokens', 'modelCalls', 'toolCalls', 'totalMs', 'ttftMs']);
    expect(rows.find((r) => r.key === 'inputTokens')).toEqual({ key: 'inputTokens', off: 10000, on: 2500, deltaPct: -75 });
    expect(rows.find((r) => r.key === 'outputTokens')!.deltaPct).toBe(13);
  });

  it('leaves the change empty when the first run failed', () => {
    for (const row of compareRuns(null, on)) {
      expect(row.off).toBeNull();
      expect(row.deltaPct).toBeNull();
    }
  });

  it('leaves the change empty when the baseline is zero or missing', () => {
    const rows = compareRuns({ ...off, ttftMs: null, toolCalls: 0 }, on);
    expect(rows.find((r) => r.key === 'ttftMs')).toEqual({ key: 'ttftMs', off: null, on: 3000, deltaPct: null });
    expect(rows.find((r) => r.key === 'toolCalls')!.deltaPct).toBeNull();
  });
});

describe('comparisonModel', () => {
  it('pins Auto Router to the default model so both runs use the same one', () => {
    expect(comparisonModel('cf-auto')).toBe('claude-haiku-5-5');
  });

  it('keeps a concrete model as chosen', () => {
    expect(comparisonModel('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });
});

describe('CODE_MODE_EXAMPLES', () => {
  it('has at least six comparison questions with unique ids the chat API accepts', () => {
    expect(CODE_MODE_EXAMPLES.length).toBeGreaterThanOrEqual(6);
    const ids = CODE_MODE_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[\w-]{1,40}$/);
  });

  it('has a title and a question in both languages for every example', () => {
    for (const lang of [zhTW, en]) {
      const examples = (lang as { chat: { codeModeSuggestions: { examples: Record<string, { title?: string; prompt?: string }> } } })
        .chat.codeModeSuggestions.examples;
      for (const { key } of CODE_MODE_EXAMPLES) {
        expect(examples[key]?.title, key).toBeTruthy();
        expect(examples[key]?.prompt, key).toBeTruthy();
      }
    }
  });
});

describe('default model', () => {
  it('is Auto Router, while comparisons still pin a concrete model', () => {
    expect(DEFAULT_MODEL_ID).toBe('cf-auto');
    expect(comparisonModel(DEFAULT_MODEL_ID)).toBe('claude-haiku-5-5');
  });
});
