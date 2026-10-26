import { describe, it, expect, vi, afterEach } from 'vitest';
import { getFreshAccessToken, mcpRefreshKey, mcpTokenKey } from './mcp-auth';

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

afterEach(() => vi.unstubAllGlobals());

describe('getFreshAccessToken', () => {
  it('returns a stored token that has not expired', async () => {
    const kv = fakeKv({ [mcpTokenKey('s', 'saas')]: JSON.stringify({ accessToken: 'a1', expiresAt: Date.now() + 60_000 }) });
    expect(await getFreshAccessToken(kv, 's', 'saas')).toBe('a1');
  });

  it('refreshes with the long-lived refresh entry once the access token is gone', async () => {
    const kv = fakeKv({
      [mcpRefreshKey('s', 'saas')]: JSON.stringify({ refreshToken: 'r1', clientId: 'c', tokenEndpoint: 'https://auth.example/token' }),
    });
    const fetchMock = vi.fn(async () => Response.json({ access_token: 'a2', token_type: 'bearer', expires_in: 900, refresh_token: 'r2' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getFreshAccessToken(kv, 's', 'saas')).toBe('a2');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://auth.example/token');
    expect(JSON.parse(kv.store.get(mcpTokenKey('s', 'saas'))!).accessToken).toBe('a2');
    // A rotated refresh token replaces the old one.
    expect(JSON.parse(kv.store.get(mcpRefreshKey('s', 'saas'))!).refreshToken).toBe('r2');
  });

  it('returns null when there is nothing to refresh with', async () => {
    expect(await getFreshAccessToken(fakeKv(), 's', 'saas')).toBeNull();
  });
});
