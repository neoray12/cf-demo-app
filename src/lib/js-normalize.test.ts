import { describe, it, expect } from 'vitest';
import { normalizeCode, splitExecMarker, wrapSandboxJs } from './js-normalize';
import vm from 'node:vm';

describe('normalizeCode', () => {
  it('returns the value of an IIFE', () => {
    expect(normalizeCode('(async () => { return 1 })();')).toBe('return await (async () => { return 1 })();');
  });

  it('invokes a bare arrow function, dropping a trailing empty call', () => {
    expect(normalizeCode('async () => { return 2 }()')).toBe('return await (async () => { return 2 })();');
  });

  it('leaves a declaration followed by statements alone', () => {
    const code = 'function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2) }\nconsole.log(fib(10))';
    expect(normalizeCode(code)).toBe(code);
  });

  it('ignores braces inside strings when matching', () => {
    expect(normalizeCode('(() => { return "}" })()')).toBe('return await (() => { return "}" })();');
  });
});

describe('wrapSandboxJs', () => {
  // Like the Sandbox's Node executor: one vm context per session, no performance global.
  async function runTwice(code: string) {
    const logs: string[] = [];
    const ctx = vm.createContext({ console: { log: (...a: unknown[]) => logs.push(a.join(' ')) }, require, setTimeout });
    await vm.runInContext(wrapSandboxJs(code), ctx);
    await vm.runInContext(wrapSandboxJs(code), ctx);
    return logs.filter((l) => !l.startsWith('__CF_EXEC_MS__='));
  }

  it('runs the same top-level declarations twice in one context', async () => {
    expect(await runTwice('const t0 = 1;\nfunction f() { return 2 }\nconsole.log(t0 + f());')).toEqual(['3', '3']);
  });

  it('provides performance.now()', async () => {
    expect(await runTwice('console.log(typeof performance.now());')).toEqual(['number', 'number']);
  });

  it('prints a returned value', async () => {
    expect(await runTwice('(async () => { return { a: 1 } })();')).toEqual(['{"a":1}', '{"a":1}']);
  });
});

describe('script timing marker', () => {
  async function run(code: string) {
    const logs: string[] = [];
    const ctx = vm.createContext({ console: { log: (...a: unknown[]) => logs.push(a.join(' ')) }, require, setTimeout });
    await vm.runInContext(wrapSandboxJs(code), ctx).catch(() => {});
    return logs.join('\n');
  }

  it('prints how long the script ran, even when it throws', async () => {
    const ok = splitExecMarker(await run('await new Promise((r) => setTimeout(r, 30)); console.log("done");'));
    expect(ok.stdout).toBe('done');
    expect(ok.execMs).toBeGreaterThanOrEqual(25);
    expect(splitExecMarker(await run('throw new Error("x")')).execMs).toBeTypeOf('number');
  });

  it('leaves output without a marker alone', () => {
    expect(splitExecMarker('a\nb')).toEqual({ stdout: 'a\nb' });
  });
});
