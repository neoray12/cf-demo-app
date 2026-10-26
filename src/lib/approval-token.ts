// Signed approval links: the manager's email link carries `t = {exp}.{sig}`,
// an HMAC-SHA256 over "{approvalId}.{exp}" with APPROVAL_SECRET. Whoever holds
// the link may approve or reject that one request until it expires. Shared by
// the app and workers/approval-workflow (no Next / Node dependencies).

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function key(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Link token for one approval, valid until `expiresAt` (ms since epoch). */
export async function signApprovalLink(secret: string, approvalId: string, expiresAt: number): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await key(secret, 'sign'), enc.encode(`${approvalId}.${expiresAt}`));
  return `${expiresAt}.${b64url(sig)}`;
}

export async function verifyApprovalLink(
  secret: string,
  approvalId: string,
  token: string | null | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  const sig = fromB64url(token.slice(dot + 1));
  if (!Number.isFinite(exp) || exp < now || !sig) return false;
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', await key(secret, 'verify'), sig, enc.encode(`${approvalId}.${exp}`));
}
