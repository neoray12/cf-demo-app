import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getRequestUser } from '@/lib/auth';
import { DEFAULT_SYSTEM_PROMPT, HARNESS_SECTIONS, SYSTEM_PROMPT_MAX, systemPromptKey, validateSystemPrompt } from '@/lib/system-prompt';

const noStore = { 'Cache-Control': 'no-store' };

// GET — the caller's base prompt (or the default), plus what the harness appends.
export async function GET(request: Request) {
  const { env } = await getCloudflareContext();
  const user = await getRequestUser(request, env as any);
  const custom = user ? await (env as any).KV.get(systemPromptKey(user.email)) : null;
  return Response.json(
    {
      prompt: custom || DEFAULT_SYSTEM_PROMPT,
      isCustom: Boolean(custom),
      canSave: Boolean(user),
      defaultPrompt: DEFAULT_SYSTEM_PROMPT,
      harnessSections: HARNESS_SECTIONS,
      maxLength: SYSTEM_PROMPT_MAX,
    },
    { headers: noStore },
  );
}

// PUT {prompt} — save the caller's base prompt (applies from their next message).
export async function PUT(request: Request) {
  const { env } = await getCloudflareContext();
  const user = await getRequestUser(request, env as any);
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { prompt?: unknown };
  const result = validateSystemPrompt(body.prompt);
  if (!result.ok) return Response.json({ error: result.error, maxLength: SYSTEM_PROMPT_MAX }, { status: 400 });
  await (env as any).KV.put(systemPromptKey(user.email), result.value);
  return Response.json({ ok: true, prompt: result.value, isCustom: true });
}

// DELETE — back to the default prompt.
export async function DELETE(request: Request) {
  const { env } = await getCloudflareContext();
  const user = await getRequestUser(request, env as any);
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  await (env as any).KV.delete(systemPromptKey(user.email));
  return Response.json({ ok: true, prompt: DEFAULT_SYSTEM_PROMPT, isCustom: false });
}
