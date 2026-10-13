import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  classifyMcpError,
  GATEWAY_BLOCK_MESSAGE,
  GUARDRAIL_SCENARIOS,
} from './mcp-guardrails';

/** Approximate the Rust DLP regex with a JS RegExp ((?i) -> i flag). */
function toRegExp(source: string): RegExp {
  const insensitive = source.startsWith('(?i)');
  return new RegExp(insensitive ? source.slice(4) : source, insensitive ? 'i' : '');
}

function scenarioRegex(id: number): RegExp {
  const s = GUARDRAIL_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return toRegExp(s.dlpRegex);
}

describe('classifyMcpError', () => {
  it('classifies -30403 as a request block with rule and scenario', () => {
    const err = new McpError(
      -30403,
      'Request blocked | rule_id: e50d7a14-ae32-4b57-9911-ad63394a6c7f | request_id: 31d48cba9800039ade18958400000001',
      {
        rule_id: 'e50d7a14-ae32-4b57-9911-ad63394a6c7f',
        request_id: '31d48cba9800039ade18958400000001',
      },
    );
    expect(classifyMcpError(err, 'saas')).toEqual({
      blocked: true,
      direction: 'request',
      ruleId: 'e50d7a14-ae32-4b57-9911-ad63394a6c7f',
      requestId: '31d48cba9800039ade18958400000001',
      scenarioId: 2,
      message: GATEWAY_BLOCK_MESSAGE,
    });
  });

  it('parses rule_id from the message when data is missing', () => {
    const err = new McpError(
      -30403,
      'Request blocked | rule_id: 4c6f7183-708e-4fb8-abc3-3f3e18f75eaf | request_id: x',
    );
    const result = classifyMcpError(err, 'saas');
    expect(result).toMatchObject({
      blocked: true,
      direction: 'request',
      ruleId: '4c6f7183-708e-4fb8-abc3-3f3e18f75eaf',
      scenarioId: 1,
    });
  });

  it('classifies -30403 without data or parseable rule_id as a bare request block', () => {
    expect(classifyMcpError(new McpError(-30403, 'Request blocked'), 'saas')).toEqual({
      blocked: true,
      direction: 'request',
      message: GATEWAY_BLOCK_MESSAGE,
    });
  });

  it('classifies -32603 from a gateway-routed server as a response block', () => {
    expect(classifyMcpError(new McpError(-32603, 'Internal Error'), 'saas')).toEqual({
      blocked: true,
      direction: 'response',
      message: GATEWAY_BLOCK_MESSAGE,
    });
  });

  it('does not mark -32603 from non-gateway servers as blocked', () => {
    expect(classifyMcpError(new McpError(-32603, 'Internal Error'), 'cf-docs')).toBeNull();
  });

  it('ignores ordinary errors', () => {
    expect(classifyMcpError(new Error('fetch failed'), 'saas')).toBeNull();
  });
});

describe('scenario regexes', () => {
  it('scenario 1 blocks write tools, allows reads', () => {
    const re = scenarioRegex(1);
    expect(re.test('{"name":"sf_create_lead"')).toBe(true);
    expect(re.test('{"name":"sf_list_accounts"')).toBe(false);
  });

  it('scenario 2 blocks Closed stages, allows others', () => {
    const re = scenarioRegex(2);
    expect(re.test('"stage":"Closed Won"')).toBe(true);
    expect(re.test('"stage":"Negotiation/Review"')).toBe(false);
  });

  it('scenario 3 blocks SOQL on Contact/User, allows Account', () => {
    const re = scenarioRegex(3);
    expect(re.test('select name, email from contact limit 3')).toBe(true);
    expect(re.test('(SELECT Email FROM Contacts)')).toBe(true);
    expect(re.test('SELECT Name FROM Account LIMIT 5')).toBe(false);
  });
});
