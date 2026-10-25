import { clearUserCookieHeader } from '@/lib/auth';

export async function POST(request: Request) {
  const secure = new URL(request.url).protocol === 'https:';
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearUserCookieHeader(secure) } });
}
