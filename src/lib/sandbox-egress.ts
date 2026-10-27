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
