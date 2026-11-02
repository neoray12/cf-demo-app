import { describe, expect, it } from 'vitest';
import { turnstileSecret, turnstileSiteKey } from './turnstile';

describe('turnstile keys', () => {
  it('uses the test site key only in development', () => {
    expect(turnstileSiteKey(true)).toBe('1x00000000000000000000AA');
    expect(turnstileSiteKey(false)).toBe('0x4AAAAAAC2QlDdiFqByHU1Z');
  });
  it('uses the test secret only in development on a local host', () => {
    expect(turnstileSecret('real', true, 'localhost')).toBe('1x0000000000000000000000000000000AA');
    expect(turnstileSecret('real', true, '127.0.0.1')).toBe('1x0000000000000000000000000000000AA');
    expect(turnstileSecret('real', true, 'demo.neokung.work')).toBe('real');
    expect(turnstileSecret('real', false, 'localhost')).toBe('real');
  });
});
