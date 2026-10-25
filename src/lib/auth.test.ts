import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseLoginUsers,
  findLoginUser,
  signUserCookie,
  verifyUserCookie,
  verifyAccessJwt,
  getRequestUser,
  USER_COOKIE,
  __resetAccessKeyCache,
} from './auth';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

describe('parseLoginUsers', () => {
  it('parses a JSON array and lower-cases emails', () => {
    const users = parseLoginUsers('[{"email":"Neo@Cloudflare.com","name":"Neo","password":"s3cret"}]');
    expect(users).toEqual([{ email: 'neo@cloudflare.com', name: 'Neo', password: 's3cret' }]);
  });

  it('drops malformed entries and returns [] for bad JSON', () => {
    expect(parseLoginUsers('[{"email":"a@b.c"},{"email":"x@y.z","password":"p"}]')).toEqual([
      { email: 'x@y.z', name: 'x', password: 'p' },
    ]);
    expect(parseLoginUsers('not json')).toEqual([]);
    expect(parseLoginUsers(undefined)).toEqual([]);
  });
});

describe('findLoginUser', () => {
  const users = parseLoginUsers('[{"email":"neo@cloudflare.com","name":"Neo","password":"pw-neo"}]');

  it('accepts the email or its local part', async () => {
    expect((await findLoginUser(users, 'neo@cloudflare.com', 'pw-neo'))?.email).toBe('neo@cloudflare.com');
    expect((await findLoginUser(users, ' NEO ', 'pw-neo'))?.email).toBe('neo@cloudflare.com');
  });

  it('rejects a wrong password or unknown user', async () => {
    expect(await findLoginUser(users, 'neo', 'neo')).toBeNull();
    expect(await findLoginUser(users, 'demo', 'demo')).toBeNull();
  });
});

describe('user cookie', () => {
  it('round-trips and rejects tampering and expiry', async () => {
    const token = await signUserCookie('k1', { email: 'neo@cloudflare.com', name: 'Neo' }, 1000, 60);
    expect(await verifyUserCookie('k1', token, 1000 + 59_000)).toEqual({ email: 'neo@cloudflare.com', name: 'Neo' });
    expect(await verifyUserCookie('k2', token, 1000)).toBeNull();
    expect(await verifyUserCookie('k1', token, 1000 + 61_000)).toBeNull();
    const [body, sig] = token.split('.');
    const forged = b64urlJson({ email: 'vera@cloudflare.com', name: 'Vera', exp: 9e12 });
    expect(await verifyUserCookie('k1', `${forged}.${sig}`, 1000)).toBeNull();
    expect(await verifyUserCookie('k1', `${body}`, 1000)).toBeNull();
  });
});

describe('Access JWT', () => {
  const team = 'neokung.cloudflareaccess.com';
  const aud = 'aud-tag-123';
  let keyPair: CryptoKeyPair;
  let jwk: JsonWebKey;
  const fetchCerts = async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] }));

  beforeAll(async () => {
    keyPair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  });

  async function makeJwt(claims: Record<string, unknown>, kid = 'k1') {
    const head = b64urlJson({ alg: 'RS256', kid, typ: 'JWT' });
    const payload = b64urlJson(claims);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(`${head}.${payload}`));
    return `${head}.${payload}.${b64url(new Uint8Array(sig))}`;
  }

  const now = 1_800_000_000_000;
  const good = { email: 'neo@cloudflare.com', aud: [aud], iss: `https://${team}`, exp: now / 1000 + 600 };

  it('accepts a valid token', async () => {
    __resetAccessKeyCache();
    const jwt = await makeJwt(good);
    expect(await verifyAccessJwt(jwt, { teamDomain: team, aud }, now, fetchCerts)).toEqual({ email: 'neo@cloudflare.com' });
  });

  it('rejects wrong aud, wrong iss, expiry and a bad signature', async () => {
    __resetAccessKeyCache();
    expect(await verifyAccessJwt(await makeJwt({ ...good, aud: ['other'] }), { teamDomain: team, aud }, now, fetchCerts)).toBeNull();
    expect(await verifyAccessJwt(await makeJwt({ ...good, iss: 'https://evil.cloudflareaccess.com' }), { teamDomain: team, aud }, now, fetchCerts)).toBeNull();
    expect(await verifyAccessJwt(await makeJwt({ ...good, exp: now / 1000 - 1 }), { teamDomain: team, aud }, now, fetchCerts)).toBeNull();
    const jwt = await makeJwt(good);
    const tampered = jwt.replace(/\.[^.]+\./, `.${b64urlJson({ ...good, email: 'vera@cloudflare.com' })}.`);
    expect(await verifyAccessJwt(tampered, { teamDomain: team, aud }, now, fetchCerts)).toBeNull();
  });
});

describe('getRequestUser', () => {
  it('uses the signed login cookie', async () => {
    const token = await signUserCookie('secret', { email: 'neo@cloudflare.com', name: 'Neo' });
    const req = new Request('https://demo.test/api/chat', { headers: { cookie: `session_id=x; ${USER_COOKIE}=${token}` } });
    expect(await getRequestUser(req, { AUTH_SECRET: 'secret' })).toEqual({ email: 'neo@cloudflare.com', name: 'Neo', source: 'login' });
  });

  it('returns null without a valid identity', async () => {
    const req = new Request('https://demo.test/api/chat', { headers: { cookie: `${USER_COOKIE}=garbage.sig` } });
    expect(await getRequestUser(req, { AUTH_SECRET: 'secret' })).toBeNull();
    expect(await getRequestUser(new Request('https://demo.test/'), { AUTH_SECRET: 'secret' })).toBeNull();
  });

  it('ignores the Access header when Access is not configured', async () => {
    const req = new Request('https://demo.test/', { headers: { 'cf-access-jwt-assertion': 'a.b.c' } });
    expect(await getRequestUser(req, { AUTH_SECRET: 'secret' })).toBeNull();
  });
});
