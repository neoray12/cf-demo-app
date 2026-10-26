// Runs an approved MCP write as the person who asked for it (their MCP token,
// refreshed if it expired while the approval waited), so Gateway policies, DLP
// and Portal logs still apply to them. Used by the in-chat approval (low risk)
// and by the Workflow's execute step (high risk).
import { callMcpTool, parseMcpServerUrls, portalCodeModeUrl } from './mcp-client';
import { getFreshAccessToken } from './mcp-auth';
import { classifyMcpError } from './mcp-guardrails';
import { getApproval, transition, type Approval } from './approvals';

interface ExecEnv {
  KV: KVNamespace;
  HISTORY_DB: D1Database;
  MCP_SERVER_URLS?: string;
}

export type ExecOutcome = { ok: true; result: unknown } | { ok: false; error: string; blocked?: boolean };

async function callApproved(env: ExecEnv, a: Approval): Promise<ExecOutcome> {
  const server = parseMcpServerUrls(env.MCP_SERVER_URLS || '').find((s) => s.id === a.serverId);
  if (!server) return { ok: false, error: `MCP server ${a.serverId} 不存在` };
  let token: string | undefined;
  if (server.authType === 'oauth') {
    const t = await getFreshAccessToken(env.KV, a.sessionId, a.serverId);
    if (!t) return { ok: false, error: `送出者的 ${server.name} 授權已失效，請重新連線後再送一次` };
    token = t;
  }
  const conn = a.codeMode ? { ...server, url: portalCodeModeUrl(server.url) } : server;
  try {
    const res = await callMcpTool(conn, a.toolName, a.args, token);
    const text = res.content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n');
    if (res.isError) return { ok: false, error: text || '工具回傳錯誤' };
    return { ok: true, result: res.structuredContent ?? text };
  } catch (err) {
    const block = classifyMcpError(err, a.serverId);
    if (block) return { ok: false, blocked: true, error: `被 Gateway 政策攔截（${block.direction}${block.ruleId ? `，rule ${block.ruleId}` : ''}）` };
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * approved → executing → done | failed. Returns the final approval, or null if
 * it was not in the approved state (e.g. someone else is already running it).
 */
export async function executeApproval(env: ExecEnv, id: string): Promise<Approval | null> {
  const db = env.HISTORY_DB;
  const a = await getApproval(db, id);
  if (!a || !(await transition(db, id, 'executing', { step: 'execute', label: '開始寫入（以送出者身分）' }))) return null;
  const out = await callApproved(env, a);
  if (out.ok) {
    await transition(db, id, 'done', { step: 'done', label: '寫入完成' }, { result: out.result });
  } else {
    await transition(db, id, 'failed', { step: 'failed', label: out.blocked ? '寫入被 Gateway 攔截' : '寫入失敗' }, { error: out.error });
  }
  return getApproval(db, id);
}
