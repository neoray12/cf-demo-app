// Code Mode comparison example: the same question without and with Code Mode,
// side by side.
import type { TraceSummary } from './trace-summary';

export interface CompareRow {
  key: 'inputTokens' | 'outputTokens' | 'modelCalls' | 'toolCalls' | 'totalMs' | 'ttftMs';
  off: number | null;
  on: number | null;
  /** (on − off) / off in whole percent; null when either side is missing or off is 0. */
  deltaPct: number | null;
}

const KEYS: CompareRow['key'][] = ['inputTokens', 'outputTokens', 'modelCalls', 'toolCalls', 'totalMs', 'ttftMs'];

export function compareRuns(off: TraceSummary | null, on: TraceSummary | null): CompareRow[] {
  return KEYS.map((key) => {
    const a = off ? off[key] : null;
    const b = on ? on[key] : null;
    const deltaPct = a === null || b === null || a === 0 ? null : Math.round(((b - a) / a) * 100);
    return { key, off: a, on: b, deltaPct };
  });
}
