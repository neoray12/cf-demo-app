// Big MCP servers run in a subagent: the main model gets one `ask_<server>`
// tool, and the subagent works through that server's tools in its own context
// (its spans, tokens and time show up under the delegate tool's span).
import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { runSubagent, toolSpanId, errorMessage, type RunContext, type SubagentDef } from './agents/runtime';
import { delegateToolName } from './tool-policy';
import type { McpServerConfig } from './mcp-client';
import { classifyCall, type Classification, type ApprovalStatus, type Risk } from './approvals';

/** An approval the subagent's write turned into (shown as a card in the chat). */
export interface ApprovalRef {
  id: string;
  risk: Risk;
  summary: string;
  status: ApprovalStatus;
}

/** A write the harness held back: create the approval and return its reference. */
export type RequestApproval = (call: { toolName: string; args: Record<string, unknown>; classification: Classification }) => Promise<ApprovalRef>;

export type DelegateResult =
  | { result: string; codeMode: boolean; blocked?: boolean; approvals?: ApprovalRef[]; [k: string]: unknown }
  | { error: string };

const SUBAGENT_MAX_STEPS = 8;

export function subagentDef(
  server: McpServerConfig,
  tools: ToolSet,
  catalogPrompt: string,
  codeMode: boolean,
): SubagentDef<{ task: string }> {
  return {
    functionId: `${server.id}-agent`,
    // Ignored: the main chat supplies ctx.languageModel (same model as the main agent).
    model: 'glm-5.3-flash',
    maxSteps: SUBAGENT_MAX_STEPS,
    system:
      `你是 ${server.name} 的專屬 subagent，只能用這個 server 的工具完成主 agent 交辦的任務。` +
      '回傳精簡結果（表格、數字、ID），不要貼原始 JSON。' +
      '如果工具結果含有 "blocked": true，代表被組織的資安政策攔截：不要重試、不要繞過，直接回報哪個動作被攔截。' +
      '寫入（建立 / 更新 / 下達 / 關閉）需要人工審批：工具結果含有 "pendingApproval": true 時代表已送出審批、還沒寫入，' +
      '不要重試、不要改用其他工具繞過，直接回報「已送出審批」與審批內容。' +
      '用與任務相同的語言回答。' +
      (codeMode ? `\n\n${catalogPrompt}` : ''),
    tools: () => tools,
    prompt: ({ task }) => `任務：${task}`,
  };
}

export function buildDelegateTool(args: {
  server: McpServerConfig;
  toolNames: string[];
  ctx: RunContext;
  parentSpanId: string;
  codeMode: boolean;
  /** `spanId` = this delegate call's tool span, so loading shows up on the subagent card. */
  loadTools(spanId: string): Promise<{ tools: Record<string, any>; catalogPrompt: string }>;
  /** Holds writes back for approval; without it writes run directly. */
  requestApproval?: RequestApproval;
  /** Injected in tests; defaults to the agents runtime. */
  run?: (def: SubagentDef<{ task: string }>, input: { task: string }, ctx: RunContext, parentSpanId: string, index: number) => Promise<{ text: string }>;
}): Tool<{ task: string }, DelegateResult> {
  const { server, toolNames, ctx, parentSpanId, codeMode, loadTools, requestApproval, run = runSubagent } = args;
  return tool({
    description:
      `${server.name}：${server.description}。` +
      (toolNames.length ? `可用操作：${toolNames.join(', ')}。` : '') +
      `把完整任務交給 ${delegateToolName(server.id)}，它會自己呼叫工具並回傳精簡結果。`,
    inputSchema: z.object({ task: z.string().min(1).describe('要交辦的完整任務，含所有條件') }),
    execute: async ({ task }, options): Promise<DelegateResult> => {
      try {
        const delegateSpanId = toolSpanId(parentSpanId, options.toolCallId);
        const loaded = await loadTools(delegateSpanId);
        // The first Gateway block inside the subagent is surfaced to the main chat (🛡 card).
        let block: Record<string, unknown> | null = null;
        const approvals: ApprovalRef[] = [];
        const keyPrefix = `tool_${server.id}_`;
        const tools: ToolSet = {};
        for (const [name, t] of Object.entries(loaded.tools)) {
          const exec = (t as { execute?: (...a: unknown[]) => Promise<unknown> }).execute;
          tools[name] = exec
            ? {
                ...t,
                execute: async (...a: unknown[]) => {
                  const toolArgs = (a[0] ?? {}) as Record<string, unknown>;
                  const classification = requestApproval ? classifyCall(name, toolArgs, server.id) : null;
                  if (classification && requestApproval) {
                    // Human in the loop: the write is not made here; it runs after approval.
                    const toolName = name.startsWith(keyPrefix) ? name.slice(keyPrefix.length) : name;
                    const ref = await requestApproval({ toolName, args: toolArgs, classification });
                    approvals.push(ref);
                    return {
                      pendingApproval: true,
                      approvalId: ref.id,
                      risk: ref.risk,
                      message:
                        ref.risk === 'high'
                          ? '高風險寫入：已建立審批 Workflow 並寄信給主管，核准後才會寫入。'
                          : '已送出審批：使用者在聊天裡核准後才會寫入。',
                    };
                  }
                  const out = await exec(...a);
                  if (!block && (out as { blocked?: unknown } | null)?.blocked === true) block = out as Record<string, unknown>;
                  return out;
                },
              }
            : t;
        }
        const def = subagentDef(server, tools, loaded.catalogPrompt, codeMode);
        // The main stream's abort (stop button, idle, hard cap) also stops the subagent.
        const signal = options.abortSignal ? AbortSignal.any([ctx.signal, options.abortSignal]) : ctx.signal;
        const { text } = await run(def, { task }, { ...ctx, signal }, delegateSpanId, 0);
        const extra = approvals.length ? { approvals } : {};
        return block ? { ...(block as object), result: text, blocked: true, codeMode, ...extra } : { result: text, codeMode, ...extra };
      } catch (err) {
        return { error: errorMessage(err) };
      }
    },
  }) as Tool<{ task: string }, DelegateResult>;
}
