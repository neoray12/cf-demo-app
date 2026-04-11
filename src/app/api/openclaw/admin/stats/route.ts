import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { OpenClawInstance } from '../../instances/route';

const KV_PREFIX = 'openclaw:';

// GET /api/openclaw/admin/stats
export async function GET() {
  const { env } = await getCloudflareContext();
  const kv = (env as any).KV as KVNamespace;

  const list = await kv.list({ prefix: KV_PREFIX });
  let total = 0;
  let active = 0;
  let sleeping = 0;
  let today = 0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  for (const key of list.keys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;
    try {
      const inst = JSON.parse(raw) as OpenClawInstance;
      if (inst.status === 'deleted') continue;
      total++;
      if (inst.status === 'active') active++;
      if (inst.status === 'sleeping') sleeping++;
      if (new Date(inst.createdAt) >= todayStart) today++;
    } catch {}
  }

  return Response.json({ total, active, sleeping, today });
}
