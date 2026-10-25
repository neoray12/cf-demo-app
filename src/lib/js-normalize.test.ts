import { describe, it, expect } from 'vitest';
import { normalizeCode } from './js-normalize';

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
