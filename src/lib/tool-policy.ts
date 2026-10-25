// Harness tool policy for the main chat: which tools the model gets this turn.
// The user never toggles tools; the harness decides what is available and the
// model decides what to call. Spec: docs/superpowers/specs/2026-10-25-harness-tools-subagents-observability-design.md
import type { McpServerConfig } from './mcp-client';

/** An MCP server with more tools than this runs in a subagent instead of the main model's tool list. */
export const MCP_DIRECT_MAX = 8;

export interface ToolPolicyInput {
  modelSupportsTools: boolean;
  bindings: { sandbox: boolean; loader: boolean; browser: boolean };
  hasImages: boolean;
  /** Connected servers and how many tools each one lists. */
  servers: Array<{ config: McpServerConfig; toolCount: number }>;
  /** Code Mode comparison example: the only request-level Code Mode override. */
  experiment?: { id: string; codeMode: boolean };
}

export interface ToolPolicy {
  core: string[];
  /** Servers whose tools go straight to the main model. */
  directServers: string[];
  /** Servers the main model reaches through an `ask_<server>` subagent. */
  delegated: Array<{ serverId: string; toolName: string; codeMode: boolean }>;
}

export function delegateToolName(serverId: string): string {
  return `ask_${serverId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

export function resolveToolPolicy(input: ToolPolicyInput): ToolPolicy {
  if (!input.modelSupportsTools) return { core: [], directServers: [], delegated: [] };

  const core = ['searchKnowledge'];
  if (input.hasImages) core.push('searchKnowledgeByImage');
  if (input.bindings.browser) core.push('readWebPage', 'captureScreenshot');
  if (input.bindings.loader) core.push('executeJs');
  if (input.bindings.sandbox) core.push('executeCode', 'createWebPreview');

  const directServers: string[] = [];
  const delegated: ToolPolicy['delegated'] = [];
  for (const { config, toolCount } of input.servers) {
    if (config.delegate || toolCount > MCP_DIRECT_MAX) {
      const codeMode = input.experiment ? input.experiment.codeMode : config.codeMode;
      delegated.push({ serverId: config.id, toolName: delegateToolName(config.id), codeMode });
    } else {
      directServers.push(config.id);
    }
  }
  return { core, directServers, delegated };
}

/**
 * The turn's Code Mode, tagged on every model request of the turn (main agent
 * and subagents) so an AI Gateway filter on code_mode keeps each run together.
 */
export function turnCodeMode(policy: ToolPolicy): boolean {
  return policy.delegated.some((d) => d.codeMode);
}
