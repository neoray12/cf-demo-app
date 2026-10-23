import { parseJsonLoose } from "../json";
import { runSubagent, type AgentDef, type SubagentDef, type ToolResultRecord } from "../runtime";
import { buildKbTools } from "../tools/kb";

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

export const kbAgent: AgentDef = {
  id: "knowledge-base",
  functionId: "kb-agent",
  defaultModel: "kimi-k2.6",
  maxSteps: 4,
  system: () =>
    [
      "你是「企業知識庫助理」，只根據使用者工作區中的文件回答問題。",
      "【第一步】在呼叫任何工具之前，先用使用者提問的語言寫一句簡短的計畫（不超過 40 字），然後才呼叫 search_kb。之後不要再重複計畫。",
      "一律先用 search_kb 檢索。若第一次沒有找到足夠資料，可以把問題改寫成中文或英文關鍵字再查一次；最多查兩次，查完就作答。",
      "只能依據 search_kb 回傳的片段回答，不可使用一般知識或憑空補充；片段沒有提到的細節就說資料中未提及。",
      "回答的每一句話句尾都要標註來源編號 [n]（對應 search_kb 結果的 n 欄位）；一句話用到多個來源就寫 [1][2]。",
      "如果 search_kb 回傳 instruction（表示沒有相關資料），照 instruction 明確回覆「在知識庫中找不到相關資料」，不要用一般知識作答，也不要標註來源。",
      "如果 search_kb 回傳 error，如實告知搜尋失敗，不要編造答案。",
      "請用繁體中文簡潔作答，數字與條件要照抄來源內容。",
    ].join("\n"),
  tools: buildKbTools,
  after: async (ctx, { text, rootSpanId, toolResults }) => {
    const sources = numberedSources(toolResults);
    if (!sources || text.trim() === "") return;
    // A checker failure must not fail the answer that was already streamed.
    try {
      await runSubagent(groundingChecker, { answer: text, sources }, ctx, rootSpanId, 0);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
    }
  },
};
