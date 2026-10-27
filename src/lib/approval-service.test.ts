import { afterEach, describe, expect, it, vi } from 'vitest';
import { callApprovalWorker, startWorkflowInstance } from './approval-service';

const env = { APPROVAL_WORKER_URL: 'https://wf.example', APPROVAL_SECRET: 's' };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const timeout = () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

afterEach(() => vi.unstubAllGlobals());

describe('callApprovalWorker', () => {
  it('retries /start once after a timeout', async () => {
    const fetch = vi.fn().mockImplementationOnce(timeout).mockResolvedValueOnce(ok({ instanceId: 'apr_1' }));
    vi.stubGlobal('fetch', fetch);
    await expect(callApprovalWorker(env, '/start', { approvalId: 'apr_1' })).resolves.toEqual({ instanceId: 'apr_1' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries /start once after a 5xx', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('boom', { status: 503 })).mockResolvedValueOnce(ok({ instanceId: 'apr_1' }));
    vi.stubGlobal('fetch', fetch);
    await expect(callApprovalWorker(env, '/start', { approvalId: 'apr_1' })).resolves.toEqual({ instanceId: 'apr_1' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":"forbidden"}', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(callApprovalWorker(env, '/start', { approvalId: 'apr_1' })).rejects.toThrow('403');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never retries /event (a decision must not be sent twice)', async () => {
    const fetch = vi.fn().mockImplementation(timeout);
    vi.stubGlobal('fetch', fetch);
    await expect(callApprovalWorker(env, '/event', { instanceId: 'apr_1', decision: 'approve' })).rejects.toThrow('timeout');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('startWorkflowInstance', () => {
  it('creates the instance with the approval id', async () => {
    const wf = { create: vi.fn().mockResolvedValue({ id: 'apr_1' }), get: vi.fn() };
    await expect(startWorkflowInstance(wf, 'apr_1')).resolves.toBe('apr_1');
    expect(wf.create).toHaveBeenCalledWith({ id: 'apr_1', params: { approvalId: 'apr_1' } });
  });

  it('treats an instance that already exists (a retried /start) as started', async () => {
    const wf = { create: vi.fn().mockRejectedValue(new Error('instance.already_exists')), get: vi.fn().mockResolvedValue({ id: 'apr_1' }) };
    await expect(startWorkflowInstance(wf, 'apr_1')).resolves.toBe('apr_1');
    expect(wf.get).toHaveBeenCalledWith('apr_1');
  });

  it('rethrows other errors', async () => {
    const wf = { create: vi.fn().mockRejectedValue(new Error('internal error')), get: vi.fn() };
    await expect(startWorkflowInstance(wf, 'apr_1')).rejects.toThrow('internal error');
  });
});
