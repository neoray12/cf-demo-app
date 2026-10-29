import { describe, it, expect } from 'vitest';
import { demoDecision, demoModel, FEATURED_PRESETS } from './clef-demo';
import { PRESETS } from '../app/pages/clef-presets';

describe('demoModel', () => {
  it('uses Clef-omni for audio or video, Clef otherwise', () => {
    expect(demoModel(['audio'])).toBe('clef-omni');
    expect(demoModel(['image', 'video'])).toBe('clef-omni');
    expect(demoModel(['image'])).toBe('clef');
    expect(demoModel([])).toBe('clef');
  });
});

describe('demoDecision', () => {
  it('passes at or above the threshold and fails below it', () => {
    expect(demoDecision(0.94, 0.85)).toEqual({ p: 0.94, pass: true });
    expect(demoDecision(0.85, 0.85)).toEqual({ p: 0.85, pass: true });
    expect(demoDecision(0.6, 0.85)).toEqual({ p: 0.6, pass: false });
  });
});

describe('featured presets', () => {
  it('each has demo copy whose question is a yes/no question of that preset', () => {
    expect(FEATURED_PRESETS).toHaveLength(6);
    for (const key of FEATURED_PRESETS) {
      const p = PRESETS.find((x) => x.key === key);
      expect(p?.demo, key).toBeDefined();
      const q = p!.questions.find((x) => x.id === p!.demo!.question);
      expect(q?.type, key).toBe('noul');
      expect(p!.demo!.threshold).toBeGreaterThanOrEqual(0.5);
      expect(p!.demo!.threshold).toBeLessThan(1);
      for (const s of [p!.demo!.tagline, p!.demo!.pass, p!.demo!.fail]) {
        expect(s.zh.length).toBeGreaterThan(0);
        expect(s.en.length).toBeGreaterThan(0);
      }
    }
  });
});
