import { McpError } from '@modelcontextprotocol/sdk/types.js';

export type GuardrailLevel = 'tool' | 'action' | 'parameter' | 'response';

export interface GuardrailPolicyRow {
  selector: string;
  operator: string;
  value: string;
}

export interface GuardrailScenario {
  id: 1 | 2 | 3 | 4;
  level: GuardrailLevel;
  /** Cloudflare Gateway HTTP policy (rule) ID */
  ruleId: string;
  titleKey: string;
  descKey: string;
  policy: GuardrailPolicyRow[];
  /** DLP regex as stored in the profile (Rust regex syntax) */
  dlpRegex: string;
  action: 'Block';
  phase: 'upload' | 'download';
  allowPromptKey: string;
  blockPromptKey: string;
  resetPromptKey?: string;
}

const UPSTREAM_HOST = 'salesforce-mcp.neokung.work';

export const GUARDRAIL_SCENARIOS: GuardrailScenario[] = [
  {
    id: 1,
    level: 'tool',
    ruleId: '4c6f7183-708e-4fb8-abc3-3f3e18f75eaf',
    titleKey: 'guardrails.s1.title',
    descKey: 'guardrails.s1.desc',
    policy: [
      { selector: 'Host', operator: 'in', value: UPSTREAM_HOST },
      { selector: 'DLP Profile', operator: 'in', value: 'MCP Demo: Block CRM write tools' },
      { selector: 'Body Phase', operator: 'is', value: 'upload' },
    ],
    dlpRegex: 'sf_(create|update)_(account|contact|opportunity|lead|case)',
    action: 'Block',
    phase: 'upload',
    allowPromptKey: 'guardrails.s1.allowPrompt',
    blockPromptKey: 'guardrails.s1.blockPrompt',
  },
  {
    id: 2,
    level: 'action',
    ruleId: 'e50d7a14-ae32-4b57-9911-ad63394a6c7f',
    titleKey: 'guardrails.s2.title',
    descKey: 'guardrails.s2.desc',
    policy: [
      { selector: 'Host', operator: 'in', value: UPSTREAM_HOST },
      { selector: 'DLP Profile', operator: 'in', value: 'MCP Demo: Block closing opportunities' },
      { selector: 'Body Phase', operator: 'is', value: 'upload' },
    ],
    dlpRegex: '"stage"\\s{0,3}:\\s{0,3}"Closed',
    action: 'Block',
    phase: 'upload',
    allowPromptKey: 'guardrails.s2.allowPrompt',
    blockPromptKey: 'guardrails.s2.blockPrompt',
    resetPromptKey: 'guardrails.s2.resetPrompt',
  },
  {
    id: 3,
    level: 'parameter',
    ruleId: '5e050c10-4b80-4352-b691-79f36730d759',
    titleKey: 'guardrails.s3.title',
    descKey: 'guardrails.s3.desc',
    policy: [
      { selector: 'Host', operator: 'in', value: UPSTREAM_HOST },
      { selector: 'DLP Profile', operator: 'in', value: 'MCP Demo: Block SOQL on people data' },
      { selector: 'Body Phase', operator: 'is', value: 'upload' },
    ],
    dlpRegex: '(?i)FROM\\s{1,5}(Contacts?|Users?)\\b',
    action: 'Block',
    phase: 'upload',
    allowPromptKey: 'guardrails.s3.allowPrompt',
    blockPromptKey: 'guardrails.s3.blockPrompt',
  },
  {
    id: 4,
    level: 'response',
    ruleId: '0b3b9c32-c2dd-4318-8467-9388df53dfee',
    titleKey: 'guardrails.s4.title',
    descKey: 'guardrails.s4.desc',
    policy: [
      { selector: 'Host', operator: 'in', value: UPSTREAM_HOST },
      { selector: 'DLP Profile', operator: 'in', value: 'MCP Demo: Block PII in responses' },
      { selector: 'Body Phase', operator: 'is', value: 'download' },
    ],
    dlpRegex: '[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\\.[A-Za-z0-9-]{1,63}){0,3}\\.[A-Za-z]{2,10}',
    action: 'Block',
    phase: 'download',
    allowPromptKey: 'guardrails.s4.allowPrompt',
    blockPromptKey: 'guardrails.s4.blockPrompt',
  },
];

/** MCP servers whose traffic goes through Cloudflare Gateway (via the MCP Server Portal). */
export const GATEWAY_ROUTED_MCP_SERVERS: ReadonlySet<string> = new Set(['saas']);

const ACCOUNT_ID = '5efa272dc28e4e3933324c44165b6dbe';

export function gatewayRuleUrl(ruleId: string): string {
  return `https://one.dash.cloudflare.com/${ACCOUNT_ID}/traffic-policies/firewall-policies/http/edit/${ruleId}`;
}

export const GATEWAY_BLOCK_MESSAGE =
  '此工具呼叫被組織的資安政策（Cloudflare Gateway）攔截。不要重試，也不要改用其他工具繞過；請告知使用者被攔截的動作。';

export interface GatewayBlock {
  blocked: true;
  direction: 'request' | 'response';
  ruleId?: string;
  requestId?: string;
  scenarioId?: number;
  message: string;
}

const GATEWAY_REQUEST_BLOCK_CODE = -30403;
const INTERNAL_ERROR_CODE = -32603;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Interpret an MCP error as a Cloudflare Gateway block.
 * - -30403: request blocked, carries rule_id / request_id.
 * - -32603 from a gateway-routed server: response DLP block (no rule ID available).
 */
export function classifyMcpError(err: unknown, serverId: string): GatewayBlock | null {
  if (!(err instanceof McpError)) return null;

  if (err.code === GATEWAY_REQUEST_BLOCK_CODE) {
    const data = (err.data ?? {}) as Record<string, unknown>;
    const ruleId =
      str(data.rule_id) ?? err.message.match(/rule_id:\s*([0-9a-f-]{36})/i)?.[1];
    const requestId =
      str(data.request_id) ?? err.message.match(/request_id:\s*([0-9a-zA-Z-]+)/)?.[1];
    const scenarioId = GUARDRAIL_SCENARIOS.find((s) => s.ruleId === ruleId)?.id;
    return {
      blocked: true,
      direction: 'request',
      ...(ruleId ? { ruleId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(scenarioId ? { scenarioId } : {}),
      message: GATEWAY_BLOCK_MESSAGE,
    };
  }

  if (err.code === INTERNAL_ERROR_CODE && GATEWAY_ROUTED_MCP_SERVERS.has(serverId)) {
    return { blocked: true, direction: 'response', message: GATEWAY_BLOCK_MESSAGE };
  }

  return null;
}
