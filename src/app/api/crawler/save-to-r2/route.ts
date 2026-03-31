import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

// ── Minimal AWS SigV4 for R2 S3-compatible API ──

const R2_BUCKET_NAME = 'cf-demo-crawler';

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

async function s3Put(
  accountId: string, accessKeyId: string, secretAccessKey: string,
  objectKey: string, body: ArrayBuffer | Uint8Array, contentType: string,
  metadata?: Record<string, string>,
): Promise<Response> {
  const region = 'auto';
  const service = 's3';
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';

  const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${objectKey}`);
  const host = url.hostname;
  const payloadHash = await sha256HexBuf(body instanceof Uint8Array ? body.buffer as ArrayBuffer : body);

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

  const bodyBuf = body instanceof Uint8Array ? (body.buffer as ArrayBuffer) : body;
  return fetch(url.toString(), { method: 'PUT', headers, body: bodyBuf });
}

// ── Content sanitization for AI Search (AutoRAG) embedding ──

function sanitizeHtml(raw: string): string {
  let text = raw;
  const blockTags = ['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'header', 'footer', 'aside'];
  for (const tag of blockTags) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }
  text = text.replace(/<(link|meta|input|br|hr|img)[^>]*\/?>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#\d+;/g, '');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  return text.trim();
}

function sanitizeMarkdown(raw: string): string {
  let text = raw;
  text = text.replace(/^!\[\]\([^\)]+\)\s*$/gm, '');
  text = text.replace(/^\[([^\]]*)\]\([^\)]+\)\s*$/gm, (_, label) => {
    if (label && label.trim().length > 3 && !/^[\s→←▶◀↗↘►]+$/.test(label.trim())) return label.trim();
    return '';
  });
  text = text.replace(/(\n\[.+?\]\(.+?\)\s*){5,}/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function sanitizeForRag(raw: string, contentType: string): { content: string; contentType: string; ext: string } {
  if (contentType === 'text/html' || contentType.includes('html')) {
    return { content: sanitizeHtml(raw), contentType: 'text/plain', ext: 'txt' };
  }
  if (contentType === 'text/markdown' || contentType.includes('markdown')) {
    return { content: sanitizeMarkdown(raw), contentType: 'text/markdown', ext: 'md' };
  }
  return { content: raw, contentType, ext: '' };
}

export async function POST(request: NextRequest) {
  try {
    const { env } = await getCloudflareContext();
    const { content, sourceUrl, contentType, filename, binary } = await request.json();

    if (!content) {
      return Response.json({ success: false, error: 'No content provided' }, { status: 400 });
    }
    if (!filename) {
      return Response.json({ success: false, error: 'No filename provided' }, { status: 400 });
    }

    const accountId = (env as any).CF_ACCOUNT_ID as string;
    const accessKeyId = (env as any).R2_ACCESS_KEY_ID as string;
    const secretAccessKey = (env as any).R2_SECRET_ACCESS_KEY as string;

    if (!accessKeyId || !secretAccessKey) {
      return Response.json({ success: false, error: 'R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not configured' }, { status: 500 });
    }

    let storedKey = filename;
    const metadata: Record<string, string> = {
      sourceurl: sourceUrl ?? '',
      crawledat: new Date().toISOString(),
    };

    // Binary files (screenshot/pdf) — store as-is via S3 API
    if (binary) {
      const binaryStr = atob(content);
      const buffer = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        buffer[i] = binaryStr.charCodeAt(i);
      }
      console.log(`[save-to-r2] Binary upload via S3 API: ${filename}, size=${buffer.byteLength}, contentType=${contentType}`);
      const r2Resp = await s3Put(accountId, accessKeyId, secretAccessKey, filename, buffer, contentType, metadata);
      if (!r2Resp.ok) {
        const errBody = await r2Resp.text();
        console.error(`[save-to-r2] S3 PUT failed: ${r2Resp.status}`, errBody);
        return Response.json({ success: false, error: `R2 upload failed (${r2Resp.status}): ${errBody.slice(0, 200)}` }, { status: 500 });
      }
    } else {
      // Text files — sanitize for RAG then upload via S3 API
      const sanitized = sanitizeForRag(content, contentType);
      storedKey = sanitized.ext && !filename.endsWith(`.${sanitized.ext}`)
        ? filename.replace(/\.[^.]+$/, `.${sanitized.ext}`)
        : filename;

      const textBuffer = new TextEncoder().encode(sanitized.content);
      console.log(`[save-to-r2] Text upload via S3 API: ${storedKey}, size=${textBuffer.byteLength}, contentType=${sanitized.contentType}`);
      const r2Resp = await s3Put(accountId, accessKeyId, secretAccessKey, storedKey, textBuffer, sanitized.contentType, metadata);
      if (!r2Resp.ok) {
        const errBody = await r2Resp.text();
        console.error(`[save-to-r2] S3 PUT failed: ${r2Resp.status}`, errBody);
        return Response.json({ success: false, error: `R2 upload failed (${r2Resp.status}): ${errBody.slice(0, 200)}` }, { status: 500 });
      }
    }

    // Trigger AI Search index job (fire-and-forget)
    let indexJobId: string | null = null;
    try {
      const syncRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/instances/${(env as any).AUTORAG_NAME}/jobs`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${(env as any).CF_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: '{}',
        }
      );
      const syncData = (await syncRes.json()) as { success?: boolean; result?: { id?: string } };
      if (syncData.success && syncData.result?.id) indexJobId = syncData.result.id;
    } catch { /* Non-critical */ }

    return Response.json({ success: true, key: storedKey, indexJobId });
  } catch (err) {
    console.error('[save-to-r2] Error:', err);
    return Response.json(
      { success: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
