import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { OpenClawInstance } from '../route';

const KV_PREFIX = 'openclaw:';

// GET /api/openclaw/instances/[id]
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { env } = await getCloudflareContext();
  const kv = (env as any).KV as KVNamespace;

  const raw = await kv.get(`${KV_PREFIX}${id}`);
  if (!raw) {
    return Response.json({ error: '實例不存在' }, { status: 404 });
  }

  const instance = JSON.parse(raw) as OpenClawInstance;
  return Response.json({ instance });
}

// PATCH /api/openclaw/instances/[id] — update status or config
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { env } = await getCloudflareContext();
  const kv = (env as any).KV as KVNamespace;

  const raw = await kv.get(`${KV_PREFIX}${id}`);
  if (!raw) {
    return Response.json({ error: '實例不存在' }, { status: 404 });
  }

  const instance = JSON.parse(raw) as OpenClawInstance;
  const body = await request.json() as Partial<Pick<OpenClawInstance, 'status' | 'name' | 'config'>>;

  if (body.status) {
    instance.status = body.status;
  }
  if (body.name) {
    instance.name = body.name;
  }
  if (body.config) {
    instance.config = { ...instance.config, ...body.config };
  }
  instance.updatedAt = new Date().toISOString();

  await kv.put(`${KV_PREFIX}${id}`, JSON.stringify(instance));

  return Response.json({ instance });
}

// DELETE /api/openclaw/instances/[id] — soft delete
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { env } = await getCloudflareContext();
  const kv = (env as any).KV as KVNamespace;

  const raw = await kv.get(`${KV_PREFIX}${id}`);
  if (!raw) {
    return Response.json({ error: '實例不存在' }, { status: 404 });
  }

  const instance = JSON.parse(raw) as OpenClawInstance;
  instance.status = 'deleted';
  instance.updatedAt = new Date().toISOString();

  await kv.put(`${KV_PREFIX}${id}`, JSON.stringify(instance));

  return Response.json({ success: true });
}
