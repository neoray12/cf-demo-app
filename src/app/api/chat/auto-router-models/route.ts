import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getRequestUser } from '@/lib/auth';
import {
  AUTO_ROUTER_CATALOG,
  autoRouterModelsKey,
  parseModelList,
  resolveAllowedModels,
  validateModelSelection,
} from '@/lib/auto-router-models';

const noStore = { 'Cache-Control': 'no-store' };

function settings(env: Record<string, unknown>) {
  return {
    availableProviders: parseModelList(env.AUTO_ROUTER_ALLOWED_PROVIDERS),
    defaultModels: resolveAllowedModels(null, env.AUTO_ROUTER_ALLOWED_MODELS as string | undefined),
  };
}

// GET — the catalog, which providers this gateway can use, the wrangler default and the caller's own picks.
export async function GET(request: Request) {
  const { env } = await getCloudflareContext();
  const user = await getRequestUser(request, env as any);
  const stored = user ? await (env as any).KV.get(autoRouterModelsKey(user.email)) : null;
  const selected = stored ? parseModelList(stored) : null;
  const { availableProviders, defaultModels } = settings(env as any);
  return Response.json(
    {
      catalog: AUTO_ROUTER_CATALOG,
      availableProviders,
      defaultModels,
      selected,
      effective: resolveAllowedModels(selected, (env as any).AUTO_ROUTER_ALLOWED_MODELS),
      canSave: Boolean(user),
    },
    { headers: noStore },
  );
}

// PUT {models} — save the caller's candidate models.
export async function PUT(request: Request) {
  const { env } = await getCloudflareContext();
  const user = await getRequestUser(request, env as any);
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { models?: unknown };
  const result = validateModelSelection(body.models, settings(env as any).availableProviders);
  if (!result.ok) return Response.json(result, { status: 400 });
  await (env as any).KV.put(autoRouterModelsKey(user.email), result.value.join(','));
  return Response.json({ ok: true, selected: result.value, effective: result.value });
}

// DELETE — back to the wrangler default.
export async function DELETE(request: Request) {
  const { env } = await getCloudflareContext();
  const user = await getRequestUser(request, env as any);
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  await (env as any).KV.delete(autoRouterModelsKey(user.email));
  return Response.json({ ok: true, selected: null, effective: settings(env as any).defaultModels });
}
