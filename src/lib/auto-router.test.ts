import { describe, it, expect } from 'vitest';
import { parseRoutingHeaders, ROUTING_REASONS } from './auto-router';

describe('parseRoutingHeaders', () => {
  it('reads every routing header AI Gateway returns', () => {
    const h = new Headers({
      'cf-aig-routed-model': 'anthropic/claude-haiku-5.5',
      'cf-aig-routing-reason': 'cost_optimal_within_pool',
      'cf-aig-routing-decision-id': 'df8f2827-9394-4e59-aaa2-df3d588bd989',
      'cf-aig-request-id': '01a1714b-2afd-7451-bf1a-00844a1dc6e9',
      'cf-aig-log-id': '01a1714b-2afd-7451-bf1a-00844a1dc6e9',
    });
    expect(parseRoutingHeaders(h, 'anthropic, workers-ai', ['anthropic/claude-haiku-5.5', '@cf/openai/gpt-oss-20b'])).toEqual({
      model: 'anthropic/claude-haiku-5.5',
      reason: 'cost_optimal_within_pool',
      decisionId: 'df8f2827-9394-4e59-aaa2-df3d588bd989',
      requestId: '01a1714b-2afd-7451-bf1a-00844a1dc6e9',
      logId: '01a1714b-2afd-7451-bf1a-00844a1dc6e9',
      allowedProviders: ['anthropic', 'workers-ai'],
      allowedModels: ['anthropic/claude-haiku-5.5', '@cf/openai/gpt-oss-20b'],
    });
  });

  it('returns null for a response that was not routed', () => {
    expect(parseRoutingHeaders(new Headers({ 'cf-aig-log-id': 'x' }))).toBeNull();
  });

  it('leaves missing fields null and the pool null when none was restricted', () => {
    expect(parseRoutingHeaders(new Headers({ 'cf-aig-routed-model': 'openai/gpt-6-luna' }))).toEqual({
      model: 'openai/gpt-6-luna',
      reason: null,
      decisionId: null,
      requestId: null,
      logId: null,
      allowedProviders: null,
      allowedModels: null,
    });
  });
});

describe('ROUTING_REASONS', () => {
  it('lists the documented reason codes', () => {
    expect(ROUTING_REASONS).toEqual([
      'cost_optimal_within_pool',
      'forced_by_candidate_pool',
      'pinned_by_turn',
      'fallback_candidate_unavailable',
      'fallback_key_not_in_candidates',
      'fallback_router_error',
      'fallback_router_timeout',
      'fallback_unsupported_input',
    ]);
  });
});
