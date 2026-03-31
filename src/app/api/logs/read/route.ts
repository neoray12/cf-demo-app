import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

// ── Minimal AWS SigV4 for R2 S3-compatible API ──

function toHex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return toHex(digest);
}

async function buildAuthHeader(
  method: string,
  url: URL,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<Record<string, string>> {
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, ''); // yyyymmdd
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'; // yyyymmddThhmmssZ

  const host = url.hostname;
  const canonicalUri = url.pathname;
  const canonicalQueryString = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const payloadHash = await sha256Hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [method, canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const seedKey = new TextEncoder().encode(`AWS4${secretAccessKey}`).buffer as ArrayBuffer;
  const signingKey = await hmacSha256(
    await hmacSha256(
      await hmacSha256(
        await hmacSha256(seedKey, dateStamp),
        region,
      ),
      service,
    ),
    'aws4_request',
  );

  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ──────────────────────────────────────────────

// Infer content type from file extension
function inferContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    json: 'application/json', md: 'text/markdown', html: 'text/html', htm: 'text/html',
    txt: 'text/plain', log: 'text/plain', csv: 'text/csv', xml: 'application/xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  };
  // .log.gz → treat as gzipped ndjson
  if (key.endsWith('.log.gz')) return 'application/x-ndjson';
  if (key.endsWith('.gz')) return 'application/gzip';
  return map[ext] || 'text/plain';
}

function isBinaryType(ct: string): boolean {
  return ct.startsWith('image/') || ct === 'application/pdf';
}

export async function GET(request: NextRequest) {
  const { env } = await getCloudflareContext();
  const { searchParams } = new URL(request.url);
  const bucket = searchParams.get('bucket');
  const key = searchParams.get('key');

  if (!bucket || !key) {
    return Response.json({ error: 'bucket and key parameters required' }, { status: 400 });
  }

  const accountId = (env as any).CF_ACCOUNT_ID as string;
  const accessKeyId = (env as any).R2_ACCESS_KEY_ID as string;
  const secretAccessKey = (env as any).R2_SECRET_ACCESS_KEY as string;

  if (!accessKeyId || !secretAccessKey) {
    return Response.json({ error: 'R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not configured' }, { status: 500 });
  }

  const s3Url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`);
  const authHeaders = await buildAuthHeader('GET', s3Url, accessKeyId, secretAccessKey);

  const response = await fetch(s3Url.toString(), { headers: authHeaders });

  if (!response.ok) {
    const body = await response.text();
    return Response.json({ error: `R2 fetch failed ${response.status}: ${body}` }, { status: response.status });
  }

  // Determine content type from R2 response header or file extension
  const r2ContentType = response.headers.get('Content-Type') || '';
  const contentType = inferContentType(key) || r2ContentType || 'text/plain';

  // Binary files (images, pdf) → return as base64 data URL
  if (isBinaryType(contentType)) {
    const buf = await response.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    const base64 = btoa(binary);
    return Response.json({ base64, contentType });
  }

  // Read the body once — needed because body can only be consumed once
  const rawBuf = await response.arrayBuffer();

  // Gzipped files → decompress
  const isGzip = key.endsWith('.gz') || response.headers.get('Content-Encoding') === 'gzip';

  if (isGzip) {
    try {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(new Uint8Array(rawBuf));
      writer.close();
      const text = await new Response(ds.readable).text();
      return Response.json({ content: text, contentType, compressed: true });
    } catch {
      // Decompression failed — return raw bytes as text
      const text = new TextDecoder().decode(rawBuf);
      return Response.json({ content: text, contentType, compressed: false });
    }
  }

  // Text files
  const text = new TextDecoder().decode(rawBuf);
  return Response.json({ content: text, contentType, compressed: false });
}
