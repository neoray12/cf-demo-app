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
