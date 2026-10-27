import { describe, it, expect } from 'vitest';
import {
  appendEgress,
  decideEgress,
  EGRESS_ALLOWLIST,
  matchesHost,
  toEgressEvent,
  type EgressEvent,
} from './sandbox-egress';

describe('decideEgress', () => {
  it('injects the GitHub token only for HTTPS api.github.com', () => {
    expect(decideEgress('https://api.github.com/repos/x')).toEqual({ action: 'injected', host: 'api.github.com' });
    // Plain HTTP would leak the token on the wire — allowed, never injected
    expect(decideEgress('http://api.github.com/x')).toEqual({ action: 'allowed', host: 'api.github.com' });
  });

  it('allows the GitHub content hosts and PyPI without injecting', () => {
    for (const url of [
      'https://github.com/cloudflare/workers-sdk',
      'https://raw.githubusercontent.com/a/b/main/README.md',
      'https://objects.githubusercontent.com/x',
      'https://pypi.org/simple/',
      'https://files.pythonhosted.org/packages/aa/bb/x.whl',
    ]) {
      expect(decideEgress(url).action, url).toBe('allowed');
    }
  });

  it('blocks everything else, including look-alike hosts', () => {
    expect(decideEgress('https://exfil.example.net/collect')).toEqual({ action: 'blocked', host: 'exfil.example.net' });
    expect(decideEgress('https://evil.com.github.com.attacker.io/').action).toBe('blocked');
    expect(decideEgress('https://notgithub.com/').action).toBe('blocked');
    expect(decideEgress('https://api.github.com.evil.io/').action).toBe('blocked');
    expect(decideEgress('not a url')).toEqual({ action: 'blocked', host: '' });
  });

  it('compares hosts case-insensitively and ignores a trailing dot', () => {
    expect(decideEgress('https://API.GitHub.com/rate_limit').action).toBe('injected');
    expect(decideEgress('https://pypi.org./simple/').action).toBe('allowed');
  });

  it('lets only the exact colo trace URL through as an unlogged probe', () => {
    expect(decideEgress('https://cloudflare.com/cdn-cgi/trace')).toEqual({ action: 'allowed', host: 'cloudflare.com', probe: true });
    expect(decideEgress('https://cloudflare.com/other').action).toBe('blocked');
    expect(decideEgress('https://cloudflare.com/cdn-cgi/trace?x=1').action).toBe('blocked');
  });

  it('exposes the policy as a constant list', () => {
    expect(EGRESS_ALLOWLIST.map((r) => r.host)).toContain('api.github.com');
    expect(EGRESS_ALLOWLIST.find((r) => r.host === 'api.github.com')?.inject).toBe('github');
  });
});

describe('matchesHost', () => {
  it('anchors wildcard patterns to the end of the host', () => {
    expect(matchesHost('*.example.com', 'a.example.com')).toBe(true);
    expect(matchesHost('*.example.com', 'a.b.example.com')).toBe(true);
    expect(matchesHost('*.example.com', 'example.com')).toBe(false);
    expect(matchesHost('*.example.com', 'a.example.com.evil.io')).toBe(false);
    expect(matchesHost('*.example.com', 'evilexample.com')).toBe(false);
    expect(matchesHost('pypi.org', 'pypi.org')).toBe(true);
    expect(matchesHost('pypi.org', 'x.pypi.org')).toBe(false);
  });
});

describe('toEgressEvent', () => {
  it('drops the query string and truncates the path to 120 chars', () => {
    const e = toEgressEvent({ method: 'get', url: 'https://api.github.com/rate_limit?token=secret' }, 'injected', 200, 42);
    expect(e).toEqual({ at: 42, method: 'GET', host: 'api.github.com', path: '/rate_limit', action: 'injected', status: 200 });

    const long = toEgressEvent({ method: 'POST', url: `https://x.io/${'a'.repeat(300)}#frag` }, 'blocked', 403, 1);
    expect(long.path).toHaveLength(120);
    expect(JSON.stringify(long)).not.toContain('#frag');
  });

  it('omits status when there is none', () => {
    const e = toEgressEvent({ method: 'GET', url: 'https://pypi.org/' }, 'allowed', undefined, 1);
    expect('status' in e).toBe(false);
  });
});

describe('appendEgress', () => {
  const ev = (at: number): EgressEvent => ({ at, method: 'GET', host: 'h', path: '/', action: 'allowed' });

  it('starts a list from null', () => {
    expect(appendEgress(null, ev(1))).toEqual([ev(1)]);
  });

  it('keeps only the newest 50 events', () => {
    let list: EgressEvent[] | null = null;
    for (let i = 0; i < 60; i++) list = appendEgress(list, ev(i));
    expect(list).toHaveLength(50);
    expect(list![0].at).toBe(10);
    expect(list![49].at).toBe(59);
  });
});
