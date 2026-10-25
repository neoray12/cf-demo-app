import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getRequestUser } from '@/lib/auth';

// The verified identity behind this browser (Access JWT or the login cookie).
export async function GET(request: Request) {
  const { env } = await getCloudflareContext();
  const user = await getRequestUser(request, env as any);
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  return Response.json(user, { headers: { 'Cache-Control': 'no-store' } });
}
