import { parseJsonLoose } from "../json";
import { runSubagent, runTracedTool, type AgentDef, type SubagentDef, type ToolResultRecord } from "../runtime";
import { buildKbTools, kbCounter, searchKbNumbered, type KbSearchOutput } from "../tools/kb";

interface NumberedResult {
  n?: number;
  filename?: string;
  snippet?: string;
}

export const groundingChecker: SubagentDef<{ answer: string; sources: string }> = {
  functionId: "grounding-checker",
  model: "kimi-k2.6", // the run's model (ctx.modelKey) overrides this
  maxSteps: 1,
  system: [
    "你是「事實查核員」，檢查一份回答中的每個論述是否都有「來源片段」支持。",
    "逐句檢查回答：如果某句話的內容（數字、條件、名稱、結論）無法在來源片段中找到依據，就算「無依據」。",
    "回答開頭可能有一句「計畫／過程說明」（例如「我先查詢…」「讓我搜尋一下…」），這類不含事實的句子與客套話請直接忽略，不要列入 unsupported；只檢查含有事實、數字、條件或結論的句子。",
    "只根據提供的來源片段判斷，不要用你自己的知識；標註 [n] 只是引用記號，不能當作有依據的證明，要核對內容。",
    '只輸出一個 JSON 物件，格式為 {"unsupported": ["無依據的句子或論述", ...]}。每項用回答中的原文（可截短）。全部都有依據時輸出 {"unsupported": []}。不要輸出其他文字、不要 Markdown 程式碼區塊。',
  ].join("\n"),
  tools: () => ({}),
  prompt: ({ answer, sources }) => `【回答】\n${answer}\n\n【來源片段】\n${sources}`,
  toDetail: (text) => {
    const parsed = parseJsonLoose<{ unsupported?: unknown }>(text);
    if (parsed && Array.isArray(parsed.unsupported) && parsed.unsupported.every((u) => typeof u === "string")) {
      return { unsupported: parsed.unsupported as string[] };
    }
    return { unsupported: [] as string[], parseError: true };
  },
};

function numberedSources(toolResults: ToolResultRecord[]): string {
  const lines: string[] = [];
  for (const tr of toolResults) {
    if (tr.toolName !== "search_kb") continue;
    const results = (tr.output as { results?: NumberedResult[] } | null | undefined)?.results;
    if (!Array.isArray(results)) continue;
    for (const r of results) lines.push(`[${r.n ?? lines.length + 1}] ${r.filename ?? ""}\n${r.snippet ?? ""}`);
  }
  return lines.join("\n\n");
}

const PREFETCH_QUERY_MAX_CHARS = 500;
const PREFETCH_RESULTS = 5;

/** The prefetched search as text for the root's system prompt: numbered passages, or what to do without any. */
export function kbPrefetchContext(output: KbSearchOutput): string {
  const head = "【預先檢索結果】系統已在一開始用使用者的問題執行過一次 search_kb：";
  if ("error" in output) return `${head}搜尋失敗（${output.error}）。請呼叫 search_kb 搜尋；仍然失敗就如實告知。`;
  if ("instruction" in output || output.results.length === 0) {
    return `${head}沒有找到相關資料。可以把問題改寫成中文或英文關鍵字，再呼叫 search_kb 一次；仍然沒有就回覆「在知識庫中找不到相關資料」。`;
  }
  const passages = output.results
    .map((r) => `[${r.n}] ${r.filename}（score ${r.score.toFixed(2)}）\n${r.snippet}`)
    .join("\n\n");
  return `${head}\n\n${passages}`;
}

const CITATION_MARKER_RE = /\[\d+\]/;
const SHORT_UNCITED_MAX_CHARS = 60;

/** Whether the grounding checker should run: skipped after a tool-calls ending and for short texts without a [n] citation. */
export function shouldCheckGrounding(finalText: string, finalFinishReason: string | undefined): boolean {
  if (finalFinishReason === "tool-calls") return false;
  const text = finalText.trim();
  return !(text.length < SHORT_UNCITED_MAX_CHARS && !CITATION_MARKER_RE.test(text));
}

export const kbAgent: AgentDef = {
  id: "knowledge-base",
  functionId: "kb-agent",
  defaultModel: "kimi-k2.6",
  // step 0: answer from the prefetch (or one follow-up search); step 1: answer; step 2: forced answer (R23)
  maxSteps: 3,
  system: () =>
    [
      "你是「企業知識庫助理」，只根據使用者工作區中的文件回答問題。",
      "系統已在一開始用使用者的問題搜尋過知識庫，結果附在最後的【預先檢索結果】（[n] 是來源編號）。",
      "【預先檢索結果】足以回答時：直接作答，不要寫計畫句，也不要呼叫工具。",
      "不夠時：先用一句話（不超過 40 字）說明要改查什麼，再把問題改寫成中文或英文關鍵字呼叫 search_kb（最多再查一次），查完就作答。新結果的編號會接續在預先檢索結果之後。",
      "只能依據檢索到的片段回答，不可使用一般知識或憑空補充；片段沒有提到的細節就說資料中未提及。",
      "回答的每一句話句尾都要標註來源編號 [n]（對應片段的編號 / search_kb 結果的 n 欄位）；一句話用到多個來源就寫 [1][2]。",
      "如果沒有相關資料（search_kb 回傳 instruction），明確回覆「在知識庫中找不到相關資料」，不要用一般知識作答，也不要標註來源。",
      "如果搜尋回傳 error，如實告知搜尋失敗，不要編造答案。",
      "請完全用使用者提問的語言簡潔作答（中文問題用繁體中文，英文問題用英文）：來源片段若是其他語言，先翻譯再引用，不要貼上未翻譯的原文段落；產品名稱、程式碼與網址保持原樣。數字與條件要照抄來源內容。",
    ].join("\n"),
  tools: buildKbTools,
  // t=0: search_kb(user question) as a traced tool span under the root; awaited (AI Search ≈ 1–2 s) so the first
  // model call already has the passages. It takes source numbers [1..n]; a follow-up search_kb continues the counter.
  prefetch: async (ctx, rootSpanId, userText) => {
    const query = userText.trim().slice(0, PREFETCH_QUERY_MAX_CHARS);
    const counter = kbCounter(ctx);
    const output = await runTracedTool(
      ctx,
      rootSpanId,
      "search_kb",
      { query },
      (spanId) => searchKbNumbered(ctx, query, PREFETCH_RESULTS, spanId, counter),
      { callId: "prefetch", failed: (o) => ("error" in o ? o.error : undefined) },
    );
    // toolResults: the grounding checker sees the prefetched passages among its sources
    return { context: kbPrefetchContext(output), toolResults: [{ toolName: "search_kb", output }] };
  },
  prefetchMode: "await",
  // Only the final answer step is checked (R30): the plan sentence written before search_kb is not a claim.
  // Not checked: a run that ended on tool calls (step limit; finalText is then just the plan sentence), and a short
  // text with no [n] marker (a plan / meta sentence, not an answer with claims).
  after: async (ctx, { finalText, finalFinishReason, rootSpanId, toolResults }) => {
    const sources = numberedSources(toolResults);
    if (!sources || finalText.trim() === "") return;
    if (!shouldCheckGrounding(finalText, finalFinishReason)) return;
    // A checker failure must not fail the answer that was already streamed.
    try {
      await runSubagent(groundingChecker, { answer: finalText, sources }, ctx, rootSpanId, 0);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
    }
  },
};
