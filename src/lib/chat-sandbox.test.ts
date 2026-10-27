import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCode } from './chat-sandbox';

const ENV = { CHAT_SANDBOX_URL: 'https://sandbox.test', CHAT_SANDBOX_SECRET: 's' };

function mockSandboxResponse(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => vi.unstubAllGlobals());

describe('executeCode egress log', () => {
  it('passes the egress events from the sandbox Worker through', async () => {
    const egress = [{ at: 1, method: 'GET', host: 'api.github.com', path: '/rate_limit', action: 'injected', status: 200 }];
    mockSandboxResponse({ success: true, stdout: '5000', stderr: '', results: [], error: null, sandbox: null, egress });
    const r = await executeCode(ENV, 'sbx-1', 'print(1)');
    expect(r.egress).toEqual(egress);
  });

  it('returns an empty log when the Worker sends none (older deployment)', async () => {
    mockSandboxResponse({ success: true, stdout: '1', stderr: '', results: [], error: null, sandbox: null });
    const r = await executeCode(ENV, 'sbx-1', 'print(1)');
    expect(r.egress).toEqual([]);
  });
});
