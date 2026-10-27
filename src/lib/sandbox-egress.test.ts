import { describe, it, expect } from 'vitest';
import {
  appendEgress,
  decideEgress,
  EGRESS_ALLOWLIST,
  egressSince,
  handleEgress,
  matchesHost,
  summarizeEgress,
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

describe('decideEgress methods (no uploads through allowlisted hosts)', () => {
  it('allows only reads on allowlisted hosts', () => {
    expect(decideEgress('https://api.github.com/rate_limit', 'HEAD').action).toBe('injected');
    expect(decideEgress('https://api.github.com/gists', 'POST')).toEqual({ action: 'blocked', host: 'api.github.com' });
    expect(decideEgress('https://github.com/attacker/r.git/git-receive-pack', 'POST').action).toBe('blocked');
    expect(decideEgress('https://pypi.org/simple/', 'PUT').action).toBe('blocked');
    expect(decideEgress('https://raw.githubusercontent.com/a/b/main/x', 'DELETE').action).toBe('blocked');
  });

  it('still lets git clone negotiate packs', () => {
    expect(decideEgress('https://github.com/cloudflare/workers-sdk.git/git-upload-pack', 'POST').action).toBe('allowed');
    expect(decideEgress('https://api.github.com/x/git-upload-pack', 'POST').action).toBe('blocked');
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
    expect(list?.[0]?.at).toBe(10);
    expect(list?.[49]?.at).toBe(59);
  });
});

describe('handleEgress', () => {
  function harness(opts: { token?: string; fetchImpl?: (r: Request) => Promise<Response>; recordFails?: boolean } = {}) {
    const sent: Request[] = [];
    const recorded: EgressEvent[] = [];
    const deps = {
      fetch: async (r: Request) => {
        sent.push(r);
        return opts.fetchImpl ? opts.fetchImpl(r) : new Response('ok', { status: 200 });
      },
      githubToken: opts.token,
      record: async (e: EgressEvent) => {
        if (opts.recordFails) throw new Error('storage down');
        recorded.push(e);
      },
      now: () => 1000,
    };
    return { sent, recorded, deps };
  }

  it('adds the GitHub token at the egress and records an injected event', async () => {
    const h = harness({ token: 'ghp_secret' });
    const res = await handleEgress(new Request('https://api.github.com/rate_limit?x=1'), h.deps);
    expect(res.status).toBe(200);
    expect(h.sent[0]?.headers.get('authorization')).toBe('Bearer ghp_secret');
    expect(h.recorded).toEqual([{ at: 1000, method: 'GET', host: 'api.github.com', path: '/rate_limit', action: 'injected', status: 200 }]);
    expect(JSON.stringify(h.recorded)).not.toContain('ghp_secret');
  });

  it('replaces an Authorization header the code set itself', async () => {
    const h = harness({ token: 'ghp_secret' });
    await handleEgress(new Request('https://api.github.com/user', { headers: { Authorization: 'Bearer fake' } }), h.deps);
    expect(h.sent[0]?.headers.get('authorization')).toBe('Bearer ghp_secret');
  });

  it('forwards GitHub calls without a token as allowed when no secret is configured', async () => {
    const h = harness();
    await handleEgress(new Request('https://api.github.com/rate_limit'), h.deps);
    expect(h.sent[0]?.headers.get('authorization')).toBeNull();
    expect(h.recorded[0]?.action).toBe('allowed');
  });

  it("strips the code's own credentials so it cannot act as someone else", async () => {
    const h = harness();
    const headers = { Authorization: 'Bearer ghp_attacker', Cookie: 'user_session=x', 'Proxy-Authorization': 'Basic x' };
    await handleEgress(new Request('https://api.github.com/user', { headers }), h.deps);
    await handleEgress(new Request('https://github.com/a/b.git/info/refs', { headers }), h.deps);
    for (const r of h.sent) {
      expect(r.headers.get('authorization')).toBeNull();
      expect(r.headers.get('cookie')).toBeNull();
      expect(r.headers.get('proxy-authorization')).toBeNull();
    }
  });

  it('blocks uploads to allowlisted hosts without forwarding them', async () => {
    const h = harness({ token: 'ghp_secret' });
    const res = await handleEgress(new Request('https://api.github.com/gists', { method: 'POST', body: '{}' }), h.deps);
    expect(res.status).toBe(403);
    expect(h.sent).toHaveLength(0);
    expect(h.recorded[0]).toMatchObject({ method: 'POST', host: 'api.github.com', action: 'blocked', status: 403 });
  });

  it('never adds the token to plain HTTP', async () => {
    const h = harness({ token: 'ghp_secret' });
    await handleEgress(new Request('http://api.github.com/rate_limit'), h.deps);
    expect(h.sent[0]?.headers.get('authorization')).toBeNull();
    expect(h.recorded[0]?.action).toBe('allowed');
  });

  it('blocks hosts outside the allowlist with a 403 and never forwards them', async () => {
    const h = harness();
    const res = await handleEgress(new Request('https://exfil.example.net/collect', { method: 'POST', body: 'data' }), h.deps);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('Blocked by sandbox egress policy: exfil.example.net');
    expect(h.sent).toHaveLength(0);
    expect(h.recorded).toEqual([{ at: 1000, method: 'POST', host: 'exfil.example.net', path: '/collect', action: 'blocked', status: 403 }]);
  });

  it('forwards the colo probe without recording it', async () => {
    const h = harness();
    await handleEgress(new Request('https://cloudflare.com/cdn-cgi/trace'), h.deps);
    expect(h.sent).toHaveLength(1);
    expect(h.recorded).toHaveLength(0);
  });

  it('answers 502 and records it when the upstream fetch throws', async () => {
    const h = harness({ fetchImpl: async () => { throw new Error('connect failed'); } });
    const res = await handleEgress(new Request('https://pypi.org/simple/'), h.deps);
    expect(res.status).toBe(502);
    expect(h.recorded[0]).toMatchObject({ action: 'allowed', status: 502 });
  });

  it('still returns the response when recording fails', async () => {
    const h = harness({ recordFails: true });
    const res = await handleEgress(new Request('https://pypi.org/simple/'), h.deps);
    expect(res.status).toBe(200);
  });
});

describe('summarizeEgress', () => {
  it('counts events per action', () => {
    const ev = (action: EgressEvent['action']): EgressEvent => ({ at: 1, method: 'GET', host: 'h', path: '/', action });
    expect(summarizeEgress([ev('allowed'), ev('injected'), ev('blocked'), ev('blocked')])).toEqual({ allowed: 1, injected: 1, blocked: 2 });
    expect(summarizeEgress(undefined)).toEqual({ allowed: 0, injected: 0, blocked: 0 });
  });
});

describe('egressSince', () => {
  it('keeps only events at or after the start time', () => {
    const ev = (at: number): EgressEvent => ({ at, method: 'GET', host: 'h', path: '/', action: 'allowed' });
    expect(egressSince([ev(1), ev(5), ev(9)], 5).map((e) => e.at)).toEqual([5, 9]);
    expect(egressSince(null, 5)).toEqual([]);
  });
});
