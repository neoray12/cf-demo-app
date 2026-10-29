// The simple "Demo" view of the Clef page: a few curated scenarios, one model
// picked for the scenario, and one yes/no question whose probability is
// compared with a threshold to choose an action (see `Preset.demo`).

export type ClefModelId = 'clef' | 'clef-flash' | 'clef-omni';

/** Scenarios shown in the Demo view, in order (keys of PRESETS). */
export const FEATURED_PRESETS = ['scamCall', 'scamSms', 'invoice', 'customerCall', 'moderation', 'judge'] as const;

/** Audio and video are Clef-omni only; everything else runs on Clef. */
export function demoModel(kinds: ReadonlyArray<'image' | 'audio' | 'video'>): ClefModelId {
  return kinds.some((k) => k === 'audio' || k === 'video') ? 'clef-omni' : 'clef';
}

/** `p` = P(yes) of the scenario's decision question; it passes at or above the threshold. */
export function demoDecision(p: number, threshold: number): { p: number; pass: boolean } {
  return { p, pass: p >= threshold };
}
