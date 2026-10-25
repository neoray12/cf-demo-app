// cf-aig-metadata for every main-chat and subagent model request. AI Gateway
// keeps at most five custom entries, so these are the five used for filtering.

const VIP_EMAILS = new Set(['vera@cloudflare.com', 'menghsien@cloudflare.com']);
const TECH_EMAILS = new Set(['neo@cloudflare.com']);

export function buildGatewayMetadata(input: { email?: string; codeMode: boolean; test?: string }): string {
  const email = input.email || 'unknown';
  // \uXXXX-escape non-ASCII (e.g. 技術) so the header stays Latin-1/ByteString safe;
  // AI Gateway decodes the escapes — do not encodeURIComponent.
  return JSON.stringify({
    email,
    usertier: VIP_EMAILS.has(email) ? 'VIP' : 'regular',
    department: TECH_EMAILS.has(email) ? '技術' : '業務',
    code_mode: input.codeMode,
    test: input.test || 'none',
  }).replace(/[^\x20-\x7E]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
