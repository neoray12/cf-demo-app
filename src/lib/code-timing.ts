// One table for a turn's code runs (executeJs / executeCode), built from the
// timings on their tool cards: the model never sees a Dynamic Worker's time
// (the browser measures it), so the app compares them itself.
import type { ToolCallInfo } from './chat-turn';

export type CodeEnv = 'dynamic-worker' | 'sandbox-js' | 'sandbox-python';

export interface CodeTimingRow {
  id: string;
  env: CodeEnv;
  /** First line of the code, for telling runs apart. */
  code: string;
  /** A Dynamic Worker run of a near-empty program: its time is the fixed cost. */
  baseline: boolean;
  /** How long the agent waited for the tool. */
  totalMs?: number;
  execMs?: number;
  overheadMs?: number;
  /** execMs / overheadMs derived from the baseline run, not measured. */
  estimated: boolean;
}

/** Short enough to be the `console.log('ok')` baseline, not a computation. */
const BASELINE_MAX_CHARS = 60;

type Timing = { totalMs?: number; execMs?: number; overheadMs?: number };

export function codeTimingRows(toolCalls: ToolCallInfo[]): CodeTimingRow[] {
  const rows: CodeTimingRow[] = [];
  for (const tc of toolCalls) {
    if (tc.status !== 'done' || (tc.name !== 'executeJs' && tc.name !== 'executeCode')) continue;
    const result = (tc.result ?? {}) as { code?: string; language?: string; timing?: unknown };
    const code = String(result.code ?? (tc.args as { code?: string } | undefined)?.code ?? '').trim();
    const first = code.split('\n')[0] ?? '';
    if (tc.name === 'executeJs') {
      rows.push({
        id: tc.id,
        env: 'dynamic-worker',
        code: first,
        baseline: code.length <= BASELINE_MAX_CHARS,
        totalMs: tc.clientMs,
        estimated: false,
      });
      continue;
    }
    const timing: Timing = typeof result.timing === 'object' && result.timing ? (result.timing as Timing) : {};
    rows.push({
      id: tc.id,
      env: result.language === 'javascript' ? 'sandbox-js' : 'sandbox-python',
      code: first,
      baseline: false,
      totalMs: timing.totalMs ?? tc.clientMs,
      execMs: timing.execMs,
      overheadMs: timing.overheadMs,
      estimated: false,
    });
  }
  // A baseline only means something next to a real Dynamic Worker run.
  const runs = rows.filter((r) => r.env === 'dynamic-worker' && !r.baseline);
  const base = rows.find((r) => r.env === 'dynamic-worker' && r.baseline && r.totalMs !== undefined);
  if (!runs.length) for (const r of rows) r.baseline = false;
  else if (base) {
    for (const r of runs) {
      if (r.totalMs === undefined) continue;
      r.execMs = Math.max(0, r.totalMs - base.totalMs!);
      r.overheadMs = base.totalMs;
      r.estimated = true;
    }
  }
  return rows;
}

export interface TimingComparison {
  dwMs: number;
  sandboxMs: number;
  /** Sandbox minus Dynamic Worker (positive: the Sandbox was slower). */
  diffMs: number;
  /** Sandbox ÷ Dynamic Worker, one decimal. */
  ratio: number;
  execDiffMs?: number;
  overheadDiffMs?: number;
}

/** The last Dynamic Worker computation against the last Sandbox run, or null without both. */
export function compareTimings(rows: CodeTimingRow[]): TimingComparison | null {
  const dw = rows.filter((r) => r.env === 'dynamic-worker' && !r.baseline && r.totalMs !== undefined).at(-1);
  const sbx = rows.filter((r) => r.env !== 'dynamic-worker' && r.totalMs !== undefined).at(-1);
  if (!dw || !sbx || !dw.totalMs) return null;
  return {
    dwMs: dw.totalMs,
    sandboxMs: sbx.totalMs!,
    diffMs: sbx.totalMs! - dw.totalMs,
    ratio: Math.round((sbx.totalMs! / dw.totalMs) * 10) / 10,
    ...(dw.execMs !== undefined && sbx.execMs !== undefined ? { execDiffMs: sbx.execMs - dw.execMs } : {}),
    ...(dw.overheadMs !== undefined && sbx.overheadMs !== undefined ? { overheadDiffMs: sbx.overheadMs - dw.overheadMs } : {}),
  };
}
