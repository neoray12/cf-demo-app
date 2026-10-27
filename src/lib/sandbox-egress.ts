/**
 * Sandbox egress policy — shared by the cf-chat-sandbox Worker (which applies it
 * in its outbound handler) and the app (which renders the resulting log).
 *
 * Default deny: every HTTP(S) request the model's code makes inside the
 * container is routed through the Worker. Only the hosts below may leave, and
 * GitHub API calls get the token added at the egress — the container never sees
 * it. Events never include headers or bodies.
 */

export type EgressAction = 'allowed' | 'injected' | 'blocked';

export interface EgressEvent {
  at: number;
  method: string;
  host: string;
  path: string;
  action: EgressAction;
  status?: number;
}

export interface EgressRule {
  /** Exact host, or `*.example.com` for any subdomain (not the apex). */
  host: string;
  /** Credential added at the egress (HTTPS only). */
  inject?: 'github';
}

// Constant on purpose: neither the model nor the user can change it.
export const EGRESS_ALLOWLIST: readonly EgressRule[] = [
  { host: 'api.github.com', inject: 'github' },
  { host: 'github.com' },
  { host: 'raw.githubusercontent.com' },
  { host: 'objects.githubusercontent.com' },
  { host: 'pypi.org' },
  { host: 'files.pythonhosted.org' },
];

// The Worker's own colo probe (placement + telemetry) runs this from inside the
// container; it is let through but not logged as the model's traffic.
const PROBE_URL = { host: 'cloudflare.com', path: '/cdn-cgi/trace' };

const MAX_PATH = 120;

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

export function matchesHost(pattern: string, host: string): boolean {
  const p = normalizeHost(pattern);
  const h = normalizeHost(host);
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

export function decideEgress(url: string): { action: EgressAction; host: string; probe?: true } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { action: 'blocked', host: '' };
  }
  const host = normalizeHost(parsed.hostname);
  if (host === PROBE_URL.host && parsed.pathname === PROBE_URL.path && !parsed.search) {
    return { action: 'allowed', host, probe: true };
  }
  const rule = EGRESS_ALLOWLIST.find((r) => matchesHost(r.host, host));
  if (!rule) return { action: 'blocked', host };
  // Never add a credential to plain HTTP — it would cross the wire in clear text.
  if (rule.inject && parsed.protocol === 'https:') return { action: 'injected', host };
  return { action: 'allowed', host };
}

export function toEgressEvent(
  request: { method: string; url: string },
  action: EgressAction,
  status: number | undefined,
  at: number
): EgressEvent {
  let host = '';
  let path = '';
  try {
    const u = new URL(request.url);
    host = normalizeHost(u.hostname);
    path = u.pathname.slice(0, MAX_PATH);
  } catch {
    // Unparseable URL — keep the event, without a host/path
  }
  const event: EgressEvent = { at, method: request.method.toUpperCase(), host, path, action };
  if (status !== undefined) event.status = status;
  return event;
}

export function appendEgress(list: EgressEvent[] | null, e: EgressEvent, max = 50): EgressEvent[] {
  return [...(list ?? []), e].slice(-max);
}

export function egressSince(list: EgressEvent[] | null, start: number): EgressEvent[] {
  return (list ?? []).filter((e) => e.at >= start);
}

export interface EgressDeps {
  fetch: (request: Request) => Promise<Response>;
  /** GitHub token held by the Worker; never reaches the container. */
  githubToken?: string;
  record: (event: EgressEvent) => Promise<void>;
  now?: () => number;
}

/**
 * Apply the policy to one outbound request from the container. Logs only the
 * decision (method / host / path / status) — never headers or bodies.
 */
export async function handleEgress(request: Request, deps: EgressDeps): Promise<Response> {
  const at = (deps.now ?? Date.now)();
  const decision = decideEgress(request.url);
  if (decision.probe) return deps.fetch(request);

  let action = decision.action;
  let response: Response;
  if (action === 'blocked') {
    response = new Response(`Blocked by sandbox egress policy: ${decision.host}`, {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  } else {
    let outgoing = request;
    if (action === 'injected') {
      if (deps.githubToken) {
        outgoing = new Request(request);
        outgoing.headers.set('Authorization', `Bearer ${deps.githubToken}`);
      } else {
        // No secret configured: still allowed, but nothing was injected.
        action = 'allowed';
      }
    }
    try {
      response = await deps.fetch(outgoing);
    } catch {
      response = new Response('Sandbox egress fetch failed', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  }

  try {
    await deps.record(toEgressEvent(request, action, response.status, at));
  } catch (err) {
    console.error('[EGRESS] record failed:', (err as Error).message);
  }
  return response;
}
