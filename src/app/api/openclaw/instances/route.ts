import { getCloudflareContext } from '@opennextjs/cloudflare';
import { provisionSandbox } from '@/lib/openclaw-sandbox';

export interface OpenClawInstance {
  id: string;
  name: string;
  slug: string;
  owner: { name: string; email: string };
  status: 'provisioning' | 'active' | 'sleeping' | 'suspended' | 'deleted';
  gatewayToken: string;
  sandboxId: string;
  config: {
    aiProvider: string;
    aiModel: string;
    sleepAfter: string;
    channels: string[];
  };
  createdAt: string;
  updatedAt: string;
}

const KV_PREFIX = 'openclaw:';

// GET /api/openclaw/instances?email=xxx (optional filter)
export async function GET(request: Request) {
  const { env } = await getCloudflareContext();
  const kv = (env as any).KV as KVNamespace;
  const url = new URL(request.url);
  const emailFilter = url.searchParams.get('email');

  const list = await kv.list({ prefix: KV_PREFIX });
  const instances: OpenClawInstance[] = [];

  for (const key of list.keys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;
    try {
      const instance = JSON.parse(raw) as OpenClawInstance;
      if (instance.status === 'deleted') continue;
      if (emailFilter && instance.owner.email !== emailFilter) continue;
      instances.push(instance);
    } catch {
      // skip malformed entries
    }
  }

  // Sort by createdAt desc
  instances.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return Response.json({ instances });
}

// POST /api/openclaw/instances — create a new instance
export async function POST(request: Request) {
  const { env } = await getCloudflareContext();
  const kv = (env as any).KV as KVNamespace;

  const body = await request.json() as {
    name: string;
    slug: string;
    owner: { name: string; email: string };
    aiProvider?: string;
    aiModel?: string;
    sleepAfter?: string;
  };

  if (!body.name || !body.slug || !body.owner?.email) {
    return Response.json({ error: '缺少必要欄位: name, slug, owner' }, { status: 400 });
  }

  // Validate slug format
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(body.slug) && !/^[a-z0-9]$/.test(body.slug)) {
    return Response.json({ error: 'Slug 格式不正確，只允許小寫字母、數字和連字號' }, { status: 400 });
  }

  // Check slug uniqueness
  const existing = await kv.list({ prefix: KV_PREFIX });
  for (const key of existing.keys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;
    try {
      const inst = JSON.parse(raw) as OpenClawInstance;
      if (inst.slug === body.slug && inst.status !== 'deleted') {
        return Response.json({ error: `Slug "${body.slug}" 已被使用` }, { status: 409 });
      }
    } catch {}
  }

  // Generate ID and gateway token
  const id = `oc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const gatewayToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const now = new Date().toISOString();
  const instance: OpenClawInstance = {
    id,
    name: body.name,
    slug: body.slug,
    owner: body.owner,
    status: 'provisioning',
    gatewayToken,
    sandboxId: id,
    config: {
      aiProvider: body.aiProvider || 'anthropic',
      aiModel: body.aiModel || 'claude-sonnet-4-20250514',
      sleepAfter: body.sleepAfter || '10m',
      channels: [],
    },
    createdAt: now,
    updatedAt: now,
  };

  await kv.put(`${KV_PREFIX}${id}`, JSON.stringify(instance));

  // Provision real Sandbox container via companion worker
  const sandboxEnv = {
    OPENCLAW_SANDBOX_URL: (env as any).OPENCLAW_SANDBOX_URL as string | undefined,
    OPENCLAW_SANDBOX_SECRET: (env as any).OPENCLAW_SANDBOX_SECRET as string | undefined,
  };

  // Fire-and-forget: provision sandbox in background, update KV on completion
  const provisionPromise = (async () => {
    try {
      const result = await provisionSandbox(sandboxEnv, id, {
        gatewayToken,
        aiProvider: instance.config.aiProvider,
        aiModel: instance.config.aiModel,
        sleepAfter: instance.config.sleepAfter,
      });

      const raw = await kv.get(`${KV_PREFIX}${id}`);
      if (raw) {
        const inst = JSON.parse(raw) as OpenClawInstance;
        if (inst.status === 'provisioning') {
          inst.status = result.success ? 'active' : 'suspended';
          inst.updatedAt = new Date().toISOString();
          await kv.put(`${KV_PREFIX}${id}`, JSON.stringify(inst));
        }
      }

      if (!result.success) {
        console.error(`[OpenClaw] Provision failed for ${id}:`, result.error);
      }
    } catch (err) {
      console.error(`[OpenClaw] Provision error for ${id}:`, err);
      // Mark as active anyway so user can retry — sandbox may still be starting
      try {
        const raw = await kv.get(`${KV_PREFIX}${id}`);
        if (raw) {
          const inst = JSON.parse(raw) as OpenClawInstance;
          if (inst.status === 'provisioning') {
            inst.status = 'active';
            inst.updatedAt = new Date().toISOString();
            await kv.put(`${KV_PREFIX}${id}`, JSON.stringify(inst));
          }
        }
      } catch {}
    }
  })();

  // Use waitUntil if available (Cloudflare Workers), otherwise just fire-and-forget
  const ctx = (env as any).ctx;
  if (ctx?.waitUntil) {
    ctx.waitUntil(provisionPromise);
  }

  return Response.json({ instance }, { status: 201 });
}
