// ── Minimal AWS SigV4 for the R2 S3-compatible API ──
// Shared by the crawler "save to R2" route and the agents knowledge-base routes.

function toHex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const ck = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(data));
}

async function sha256HexBuf(data: ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

async function sha256Hex(data: string): Promise<string> {
  return sha256HexBuf(new TextEncoder().encode(data).buffer as ArrayBuffer);
}

export interface S3PutOptions {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  body: ArrayBuffer | Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
}

export async function s3Put(opts: S3PutOptions): Promise<Response> {
  const { accountId, accessKeyId, secretAccessKey, bucket, key: objectKey, body, contentType, metadata } = opts;
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';

  const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${objectKey}`);
  const host = url.hostname;
  const bodyBuf = body instanceof Uint8Array
    ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
    : body;
  const payloadHash = await sha256HexBuf(bodyBuf);

  // Build metadata headers
  const metaHeaders: Record<string, string> = {};
  if (metadata) {
    for (const [k, v] of Object.entries(metadata)) {
      metaHeaders[`x-amz-meta-${k.toLowerCase()}`] = v;
    }
  }

  // Canonical headers (must be sorted)
  const allHeaders: Record<string, string> = {
    'content-type': contentType,
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...metaHeaders,
  };
  const sortedKeys = Object.keys(allHeaders).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${allHeaders[k]}`).join('\n') + '\n';
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = ['PUT', url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const seedKey = new TextEncoder().encode(`AWS4${secretAccessKey}`).buffer as ArrayBuffer;
  const signingKey = await hmacSha256(
    await hmacSha256(await hmacSha256(await hmacSha256(seedKey, dateStamp), region), service),
    'aws4_request',
  );
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    ...metaHeaders,
  };

  return fetch(url.toString(), { method: 'PUT', headers, body: bodyBuf });
}

// ── Query-string presigned URLs (SigV4) ──

/** RFC 3986 encoding as SigV4 requires: everything except `A-Za-z0-9-._~` is percent-encoded (UTF-8). */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `/bucket/a/b` path with every segment encoded separately (the slashes stay). */
export function encodeObjectPath(bucket: string, key: string): string {
  return `/${[bucket, ...key.split('/')].map(uriEncode).join('/')}`;
}

export interface PresignV4Options {
  method: string;
  host: string;
  /** Already-encoded canonical path. */
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  /** Lower-case header name -> value; `host` is added automatically. */
  headers?: Record<string, string>;
  /** Adds `X-Amz-Content-Sha256=<value>` to the query (R2 accepts `UNSIGNED-PAYLOAD`). */
  contentSha256?: string;
  now?: Date;
}

/**
 * Generic SigV4 query presign. Returns the URL plus the canonical request / string to sign (for tests and debugging).
 * Signed header names are sorted, as SigV4 requires.
 */
export async function presignV4(opts: PresignV4Options): Promise<{ url: string; canonicalRequest: string; stringToSign: string }> {
  const now = opts.now ?? new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const headers: Record<string, string> = { ...(opts.headers ?? {}), host: opts.host };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim();
  const signedHeaders = names.join(';');
  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${opts.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(opts.expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  if (opts.contentSha256) query['X-Amz-Content-Sha256'] = opts.contentSha256;
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
    .join('&');
  const canonicalHeaders = names.map((h) => `${h}:${lower[h]}`).join('\n') + '\n';
  const canonicalRequest = [
    opts.method,
    opts.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    opts.contentSha256 ?? 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const seedKey = new TextEncoder().encode(`AWS4${opts.secretAccessKey}`).buffer as ArrayBuffer;
  const signingKey = await hmacSha256(
    await hmacSha256(await hmacSha256(await hmacSha256(seedKey, dateStamp), opts.region), opts.service),
    'aws4_request',
  );
  const signature = toHex(await hmacSha256(signingKey, stringToSign));
  return {
    url: `https://${opts.host}${opts.path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    canonicalRequest,
    stringToSign,
  };
}

export interface PresignPutOptions {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  contentType: string;
  contentLength: number;
  expiresSeconds?: number;
  now?: Date;
}

/**
 * Presigned R2 PUT URL (SigV4 query auth, region `auto`, `X-Amz-Content-Sha256=UNSIGNED-PAYLOAD`). `content-type`
 * and `content-length` are signed together with `host`, so the uploader must send exactly that type and size
 * (browsers set Content-Length from the body themselves). Async because WebCrypto HMAC is.
 */
export async function presignPut(opts: PresignPutOptions): Promise<string> {
  const { url } = await presignV4({
    method: 'PUT',
    host: `${opts.accountId}.r2.cloudflarestorage.com`,
    path: encodeObjectPath(opts.bucket, opts.key),
    region: 'auto',
    service: 's3',
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
    expiresSeconds: opts.expiresSeconds ?? 300,
    headers: { 'content-type': opts.contentType, 'content-length': String(opts.contentLength) },
    contentSha256: 'UNSIGNED-PAYLOAD',
    now: opts.now,
  });
  return url;
}
