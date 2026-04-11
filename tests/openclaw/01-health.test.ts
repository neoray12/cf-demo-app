import { describe, it, expect } from 'vitest';
import { api, sandbox, SANDBOX_URL, BASE_URL } from './setup';

describe('01 — Health Check', () => {
  it('T1.1 companion worker /health returns ok', async () => {
    // /health has no auth requirement
    const res = await fetch(`${SANDBOX_URL}/health`);
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('openclaw-sandbox');
  });

  it('T1.2 cf-demo-app admin stats returns valid JSON', async () => {
    const res = await api('/api/openclaw/admin/stats');
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    expect(typeof body.total).toBe('number');
    expect(typeof body.active).toBe('number');
    expect(typeof body.sleeping).toBe('number');
    expect(typeof body.today).toBe('number');
  });

  it('T1.3 environment is correctly configured', () => {
    expect(BASE_URL).toBeTruthy();
    expect(SANDBOX_URL).toBeTruthy();
    console.log(`  BASE_URL:    ${BASE_URL}`);
    console.log(`  SANDBOX_URL: ${SANDBOX_URL}`);
  });
});
