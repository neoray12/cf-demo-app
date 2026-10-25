import { getCloudflareContext } from '@opennextjs/cloudflare';
import { authSecret, findLoginUser, parseLoginUsers, signUserCookie, userCookieHeader } from '@/lib/auth';

export async function POST(request: Request) {
  const { username, password, turnstileToken } = await request.json() as {
    username: string;
    password: string;
    turnstileToken: string;
  };

  const { env } = await getCloudflareContext();
  const secret = (env as any).TURNSTILE_SECRET_KEY as string | undefined;
  if (!secret) {
    return Response.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  // Accounts live in the LOGIN_USERS secret, never in the source.
  const users = parseLoginUsers((env as any).LOGIN_USERS);
  const cookieSecret = authSecret(env as any);
  if (users.length === 0 || !cookieSecret) {
    console.error('[auth] LOGIN_USERS or AUTH_SECRET is not configured');
    return Response.json({ error: '登入帳號尚未設定（LOGIN_USERS / AUTH_SECRET）' }, { status: 500 });
  }

  if (!turnstileToken) {
    return Response.json({ error: '請完成人機驗證' }, { status: 400 });
  }

  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', turnstileToken);
  const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData,
  });
  const verifyData = await verifyRes.json() as { success: boolean };
  if (!verifyData.success) {
    return Response.json({ error: '人機驗證失敗，請重試' }, { status: 400 });
  }

  const user = await findLoginUser(users, username, password);
  if (!user) {
    return Response.json({ error: '用戶名或密碼錯誤' }, { status: 401 });
  }

  const token = await signUserCookie(cookieSecret, { email: user.email, name: user.name });
  const secure = new URL(request.url).protocol === 'https:';
  return Response.json(
    { name: user.name, email: user.email },
    { headers: { 'Set-Cookie': userCookieHeader(token, secure) } },
  );
}
