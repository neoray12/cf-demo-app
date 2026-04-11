import { describe, it, expect } from 'vitest';
import { api, uniqueSlug, TEST_OWNER, sleep } from './setup';

describe('03 — Admin Stats', () => {
  let tempInstanceId: string | null = null;

  it('T6.1 stats reflect instance creation', async () => {
    const before = (await (await api('/api/openclaw/admin/stats')).json()) as any;

    const slug = uniqueSlug();
    const res = await api('/api/openclaw/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Stats Test',
        slug,
        owner: TEST_OWNER,
        aiProvider: 'anthropic',
        aiModel: 'claude-sonnet-4-20250514',
        sleepAfter: '10m',
      }),
    });
    expect(res.status).toBe(201);
    tempInstanceId = ((await res.json()) as any).instance.id;

    await sleep(1_000);

    const after = (await (await api('/api/openclaw/admin/stats')).json()) as any;
    expect(after.total).toBeGreaterThanOrEqual(before.total + 1);
    console.log(`  Stats: ${before.total} → ${after.total}`);
  });

  it('T6.2 stats reflect deletion', async () => {
    expect(tempInstanceId).toBeTruthy();
    const before = (await (await api('/api/openclaw/admin/stats')).json()) as any;

    await api(`/api/openclaw/instances/${tempInstanceId}`, { method: 'DELETE' });
    await sleep(1_000);

    const after = (await (await api('/api/openclaw/admin/stats')).json()) as any;
    expect(after.total).toBeLessThanOrEqual(before.total);
    console.log(`  Stats: ${before.total} → ${after.total}`);
  });
});
