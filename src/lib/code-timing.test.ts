import { describe, it, expect } from 'vitest';
import { codeTimingRows, compareTimings } from './code-timing';
import type { ToolCallInfo } from './chat-turn';

const dw = (id: string, code: string, clientMs?: number): ToolCallInfo => ({
  id,
  name: 'executeJs',
  status: 'done',
  args: { code },
  result: { code, engine: 'dynamic-worker' },
  ...(clientMs !== undefined ? { clientMs } : {}),
});
const sbx = (id: string, code: string, timing: unknown, language = 'javascript'): ToolCallInfo => ({
  id,
  name: 'executeCode',
  status: 'done',
  args: { code, language },
  result: { code, language, timing },
});
const COMPUTE = 'function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }\nconsole.log(fib(35))';

describe('codeTimingRows', () => {
  it('takes Sandbox timing from the tool result and Dynamic Worker time from the browser', () => {
    const rows = codeTimingRows([dw('a', COMPUTE, 230), sbx('b', COMPUTE, { totalMs: 996, execMs: 284, overheadMs: 712 })]);
    expect(rows.map((r) => [r.env, r.totalMs, r.execMs, r.overheadMs, r.estimated])).toEqual([
      ['dynamic-worker', 230, undefined, undefined, false],
      ['sandbox-js', 996, 284, 712, false],
    ]);
  });

  it('estimates Dynamic Worker run time by subtracting the empty-program baseline', () => {
    const rows = codeTimingRows([dw('a', "console.log('ok')", 6), dw('b', COMPUTE, 230)]);
    expect(rows[0]).toMatchObject({ baseline: true, totalMs: 6 });
    expect(rows[1]).toMatchObject({ baseline: false, totalMs: 230, execMs: 224, overheadMs: 6, estimated: true });
  });

  it('ignores other tools and calls still running', () => {
    const running: ToolCallInfo = { ...dw('c', COMPUTE, 10), status: 'calling' };
    expect(codeTimingRows([{ id: 'x', name: 'searchKnowledge', status: 'done' }, running])).toEqual([]);
  });

  it('labels a Python sandbox run', () => {
    expect(codeTimingRows([sbx('p', 'print(1)', { totalMs: 400 }, 'python')])[0]).toMatchObject({ env: 'sandbox-python', totalMs: 400 });
  });
});

describe('compareTimings', () => {
  it('compares the Dynamic Worker run with the Sandbox run', () => {
    const rows = codeTimingRows([
      dw('a', "console.log('ok')", 6),
      dw('b', COMPUTE, 230),
      sbx('c', COMPUTE, { totalMs: 996, execMs: 284, overheadMs: 712 }),
    ]);
    expect(compareTimings(rows)).toEqual({ dwMs: 230, sandboxMs: 996, diffMs: 766, ratio: 4.3, execDiffMs: 60, overheadDiffMs: 706 });
  });

  it('needs both a Dynamic Worker and a Sandbox run', () => {
    expect(compareTimings(codeTimingRows([dw('a', COMPUTE, 230)]))).toBeNull();
  });
});
