// AI Gateway Auto Router (`cloudflare/auto`): what it tells us about a routing
// decision. It returns these headers only — the model, a reason code and IDs;
// candidate scores stay inside AI Gateway (not in headers, the body or the logs API).

export interface AutoRouting {
  /** The model that served the request, e.g. anthropic/claude-haiku-5.5. */
  model: string;
  /** One of ROUTING_REASONS (null if the header was missing). */
  reason: string | null;
  decisionId: string | null;
  requestId: string | null;
  logId: string | null;
  /** The candidate providers we restricted the pool to (cf-aig-allowed-providers); null = Cloudflare's default pool. */
  allowedProviders: string[] | null;
  /** The candidate models we sent (cf-aig-allowed-models); null = no model restriction. */
  allowedModels: string[] | null;
}

/** Documented values of cf-aig-routing-reason. */
export const ROUTING_REASONS = [
  'cost_optimal_within_pool',
  'forced_by_candidate_pool',
  'pinned_by_turn',
  'fallback_candidate_unavailable',
  'fallback_key_not_in_candidates',
  'fallback_router_error',
  'fallback_router_timeout',
  'fallback_unsupported_input',
] as const;

export function parseRoutingHeaders(headers: Headers, allowedProviders?: string, allowedModels?: string[] | null): AutoRouting | null {
  const model = headers.get('cf-aig-routed-model');
  if (!model) return null;
  const pool = allowedProviders
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    model,
    reason: headers.get('cf-aig-routing-reason'),
    decisionId: headers.get('cf-aig-routing-decision-id'),
    requestId: headers.get('cf-aig-request-id'),
    logId: headers.get('cf-aig-log-id'),
    allowedProviders: pool && pool.length ? pool : null,
    allowedModels: allowedModels && allowedModels.length ? allowedModels : null,
  };
}
