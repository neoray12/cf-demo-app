// Server-side identity for the app.
//
// Two sources, checked in order by getRequestUser():
//   1. Cloudflare Access — `Cf-Access-Jwt-Assertion`, verified against the team's
//      JWKS, when ACCESS_TEAM_DOMAIN and ACCESS_AUD are configured.
//   2. The app login cookie — set by /api/auth/login, HMAC-signed with AUTH_SECRET
//      (falling back to CHAT_SANDBOX_SECRET).
// Anything the browser sends as plain JSON (userEmail in the chat body,
// localStorage) is display-only and never identifies a user.

export const USER_COOKIE = 'cf_demo_user';
export const USER_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface LoginUser {
  email: string;
  name: string;
  password: string;
}

export interface RequestUser {
  email: string;
  name: string;
  source: 'access' | 'login';
}

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(s: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(s))) as T;
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ── Login accounts (LOGIN_USERS secret) ──

/** `LOGIN_USERS` is a JSON array of {email, name?, password}; anything malformed is dropped. */
export function parseLoginUsers(raw: unknown): LoginUser[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const users: LoginUser[] = [];
  for (const u of parsed) {
    if (!u || typeof u !== 'object') continue;
    const { email, name, password } = u as Record<string, unknown>;
    if (typeof email !== 'string' || !email.includes('@') || typeof password !== 'string' || !password) continue;
    const e = email.trim().toLowerCase();
    users.push({ email: e, name: typeof name === 'string' && name ? name : e.split('@')[0]!, password });
  }
  return users;
}

/** Match by full email or its local part (`neo` → neo@…); the password is compared in constant time. */
export async function findLoginUser(users: LoginUser[], login: string, password: string): Promise<LoginUser | null> {
  const l = String(login ?? '').trim().toLowerCase();
  if (!l) return null;
  const user = users.find((u) => u.email === l || u.email.split('@')[0] === l);
  // Compare HMACs of both values so the comparison time doesn't depend on where they differ.
  const nonce = crypto.randomUUID();
  const ok = timingSafeEqual(await hmac(nonce, String(password ?? '')), await hmac(nonce, user?.password ?? '\0'));
  return user && ok ? user : null;
}

// ── Login cookie ──

export function authSecret(env: Record<string, unknown>): string | null {
  for (const k of ['AUTH_SECRET', 'CHAT_SANDBOX_SECRET']) {
    const v = env[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

export async function signUserCookie(
  secret: string,
  user: { email: string; name: string },
  now = Date.now(),
  maxAgeSeconds = USER_COOKIE_MAX_AGE_SECONDS,
): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify({ email: user.email, name: user.name, exp: now + maxAgeSeconds * 1000 })));
  return `${body}.${b64urlEncode(await hmac(secret, body))}`;
}

export async function verifyUserCookie(secret: string, token: string, now = Date.now()): Promise<{ email: string; name: string } | null> {
  const [body, sig, extra] = String(token ?? '').split('.');
  if (!body || !sig || extra !== undefined) return null;
  let given: Uint8Array;
  try {
    given = b64urlDecode(sig);
  } catch {
    return null;
  }
  if (!timingSafeEqual(given, await hmac(secret, body))) return null;
  const payload = decodeJson<{ email?: unknown; name?: unknown; exp?: unknown }>(body);
  if (!payload || typeof payload.email !== 'string' || typeof payload.exp !== 'number' || payload.exp <= now) return null;
  return { email: payload.email, name: typeof payload.name === 'string' ? payload.name : payload.email };
}

export function userCookieHeader(token: string, secure: boolean): string {
  return `${USER_COOKIE}=${token}; Path=/; Max-Age=${USER_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearUserCookieHeader(secure: boolean): string {
  return `${USER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// ── Cloudflare Access ──

interface AccessKey {
  kid: string;
  key: CryptoKey;
}

const ACCESS_KEYS_TTL_MS = 60 * 60 * 1000;
let accessKeyCache: { team: string; at: number; keys: AccessKey[] } | null = null;

/** Test hook: forget cached Access signing keys. */
export function __resetAccessKeyCache(): void {
  accessKeyCache = null;
}

async function accessKeys(team: string, now: number, fetchImpl: typeof fetch, refresh: boolean): Promise<AccessKey[]> {
  if (!refresh && accessKeyCache && accessKeyCache.team === team && now - accessKeyCache.at < ACCESS_KEYS_TTL_MS) {
    return accessKeyCache.keys;
  }
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs HTTP ${res.status}`);
  const { keys = [] } = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const imported: AccessKey[] = [];
  for (const jwk of keys) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    imported.push({ kid: jwk.kid, key });
  }
  accessKeyCache = { team, at: now, keys: imported };
  return imported;
}

/** Verify a `Cf-Access-Jwt-Assertion`: RS256 signature against the team's keys, aud, iss and exp. */
export async function verifyAccessJwt(
  token: string,
  cfg: { teamDomain: string; aud: string },
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ email: string } | null> {
  const [h, p, s] = String(token ?? '').split('.');
  if (!h || !p || !s) return null;
  const header = decodeJson<{ alg?: string; kid?: string }>(h);
  const claims = decodeJson<{ email?: unknown; aud?: unknown; iss?: unknown; exp?: unknown }>(p);
  if (!header || header.alg !== 'RS256' || !header.kid || !claims) return null;

  const team = cfg.teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  try {
    let keys = await accessKeys(team, now, fetchImpl, false);
    // Access rotates keys; a kid we haven't seen means the cache is stale.
    if (!keys.some((k) => k.kid === header.kid)) keys = await accessKeys(team, now, fetchImpl, true);
    const key = keys.find((k) => k.kid === header.kid)?.key;
    if (!key) return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;
  } catch (err) {
    console.warn('[auth] Access JWT verification failed:', (err as Error).message);
    return null;
  }

  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(cfg.aud)) return null;
  if (claims.iss !== `https://${team}`) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  if (typeof claims.email !== 'string' || !claims.email) return null;
  return { email: claims.email.toLowerCase() };
}

// ── Request identity ──

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The verified user behind this request, or null. Never throws. */
export async function getRequestUser(request: Request, env: Record<string, unknown>): Promise<RequestUser | null> {
  const team = typeof env.ACCESS_TEAM_DOMAIN === 'string' ? env.ACCESS_TEAM_DOMAIN.trim() : '';
  const aud = typeof env.ACCESS_AUD === 'string' ? env.ACCESS_AUD.trim() : '';
  const accessJwt = request.headers.get('cf-access-jwt-assertion');
  if (team && aud && accessJwt) {
    const access = await verifyAccessJwt(accessJwt, { teamDomain: team, aud });
    if (access) {
      const users = parseLoginUsers(env.LOGIN_USERS);
      const name = users.find((u) => u.email === access.email)?.name ?? access.email.split('@')[0]!;
      return { email: access.email, name, source: 'access' };
    }
  }

  const secret = authSecret(env);
  const token = readCookie(request, USER_COOKIE);
  if (secret && token) {
    const user = await verifyUserCookie(secret, token);
    if (user) return { ...user, source: 'login' };
  }
  return null;
}
