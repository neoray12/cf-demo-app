import { describe, it, expect } from 'vitest';
import { api, TEST_OWNER } from './setup';

describe('07 — Cleanup', () => {
  it('T7.1 delete all E2E test instances', async () => {
    const res = await api(
      `/api/openclaw/instances?email=${encodeURIComponent(TEST_OWNER.email)}`,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as any;
    const instances = body.instances || [];
    let cleaned = 0;

    for (const inst of instances) {
      if (inst.status === 'deleted') continue;
      try {
        const del = await api(`/api/openclaw/instances/${inst.id}`, {
          method: 'DELETE',
        });
        if (del.ok) cleaned++;
      } catch {}
    }

    console.log(`  Cleaned up ${cleaned} E2E test instance(s).`);
  });

  it('T7.2 verify no active E2E instances remain', async () => {
    const res = await api(
      `/api/openclaw/instances?email=${encodeURIComponent(TEST_OWNER.email)}`,
    );
    const body = await res.json() as any;
    const active = (body.instances || []).filter(
      (i: any) => i.status !== 'deleted',
    );
    expect(active).toHaveLength(0);
  });
});
