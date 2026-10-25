// Code Mode comparison example: the same question without and with Code Mode,
// side by side.
import type { TraceSummary } from './trace-summary';
import { DEFAULT_MODEL_ID } from './types';

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

/**
 * The model both runs of a comparison use. Auto Router picks a model per
 * request, so the two runs could land on different models (one on Sonnet, the
 * other on Haiku) and the token and cost numbers would compare models, not
 * Code Mode; it is pinned to the default model instead.
 */
export function comparisonModel(selected: string): string {
  return selected === 'cf-auto' ? DEFAULT_MODEL_ID : selected;
}

/**
 * Code Mode comparison questions (home page "Code Mode demos"). Each one needs
 * several SAP / Salesforce calls plus some arithmetic, where Code Mode helps;
 * all are read-only. The id is the AI Gateway `test` metadata value, and the
 * strings live under chat.codeModeSuggestions.examples.{key}.
 */
export const CODE_MODE_EXAMPLES = [
  { id: 'sf-agg', key: 'agg' },
  { id: 'sf-pipeline', key: 'pipeline' },
  { id: 'sf-cases', key: 'cases' },
  { id: 'sf-leads', key: 'leads' },
  { id: 'sap-orders', key: 'sapOrders' },
  { id: 'sap-production', key: 'sapProduction' },
  { id: 'sap-sf-match', key: 'crossMatch' },
] as const;
