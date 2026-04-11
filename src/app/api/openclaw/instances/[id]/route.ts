import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { OpenClawInstance } from '../route';
import { startSandbox, stopSandbox, getSandboxStatus } from '@/lib/openclaw-sandbox';

const KV_PREFIX = 'openclaw:';

function getSandboxEnv(env: any) {
  return {
    OPENCLAW_SANDBOX_URL: (env.OPENCLAW_SANDBOX_URL || process.env.OPENCLAW_SANDBOX_URL) as string | undefined,
    OPENCLAW_SANDBOX_SECRET: (env.OPENCLAW_SANDBOX_SECRET || process.env.OPENCLAW_SANDBOX_SECRET) as string | undefined,
  };
}

// GET /api/openclaw/instances/[id]?check_status=true
export async function GET(
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

  // Optionally check real sandbox status
  const url = new URL(request.url);
  if (url.searchParams.get('check_status') === 'true' && instance.status === 'active') {
    try {
      const sandboxStatus = await getSandboxStatus(getSandboxEnv(env), id);
      if (sandboxStatus.containerStatus === 'sleeping' && instance.status === 'active') {
        instance.status = 'sleeping';
        instance.updatedAt = new Date().toISOString();
        await kv.put(`${KV_PREFIX}${id}`, JSON.stringify(instance));
      }
    } catch {
      // Non-fatal, return cached status
    }
  }

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
  const sandboxEnv = getSandboxEnv(env);

  // Handle status transitions with real sandbox operations
  if (body.status && body.status !== instance.status) {
    const oldStatus = instance.status;
    const newStatus = body.status;

    // Suspend → stop sandbox
    if (newStatus === 'suspended' && (oldStatus === 'active' || oldStatus === 'sleeping')) {
      const result = await stopSandbox(sandboxEnv, id);
      if (!result.success) {
        console.error(`[OpenClaw] Stop failed for ${id}:`, result.error);
      }
    }

    // Resume → start sandbox
    if (newStatus === 'active' && (oldStatus === 'suspended' || oldStatus === 'sleeping')) {
      const result = await startSandbox(sandboxEnv, id, instance.gatewayToken, instance.config.sleepAfter);
      if (!result.success) {
        console.error(`[OpenClaw] Start failed for ${id}:`, result.error);
      }
    }

    instance.status = newStatus;
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

  // Stop the sandbox container before deleting
  const sandboxEnv = getSandboxEnv(env);
  try {
    await stopSandbox(sandboxEnv, id);
  } catch (err) {
    console.error(`[OpenClaw] Stop on delete failed for ${id}:`, err);
  }

  instance.status = 'deleted';
  instance.updatedAt = new Date().toISOString();

  await kv.put(`${KV_PREFIX}${id}`, JSON.stringify(instance));

  return Response.json({ success: true });
}
