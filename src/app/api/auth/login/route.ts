import { getCloudflareContext } from '@opennextjs/cloudflare';

const USERS = [
  { username: 'neo', name: 'Neo', email: 'neo@cloudflare.com' },
  { username: 'vera', name: 'Vera', email: 'vera@cloudflare.com' },
  { username: 'menghsien', name: 'Kevin', email: 'menghsien@cloudflare.com' },
  { username: 'demo', name: 'Demo', email: 'demo@cloudflare.com' },
];

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

  const user = USERS.find(u => u.username === username && password === username);
  if (!user) {
    return Response.json({ error: '用戶名或密碼錯誤' }, { status: 401 });
  }

  return Response.json({ name: user.name, email: user.email });
}
