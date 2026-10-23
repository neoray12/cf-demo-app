import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { runParallel, runSubagent, type AgentDef, type RunContext, type SubagentDef } from "../runtime";
import { buildDocsTools } from "../tools/cf-docs";

export const docsResearcher: SubagentDef<{ question: string }> = {
  functionId: "docs-researcher",
  model: "glm-5.3-flash",
  maxSteps: 4,
  system: [
    "You are a Cloudflare documentation researcher.",
    "You have at most 4 steps and the LAST one must be your written answer, so be economical:",
    "step 1 = call search_docs (once or twice, in parallel); step 2 = at most one read_doc_page, and only if the snippets are clearly not enough; then write the answer.",
    "Answer ONLY from tool results; never use outside knowledge. If the docs do not cover it, say so.",
    "Reply with a concise bullet-point summary in English, and put the source URL after each bullet.",
  ].join(" "),
  tools: (ctx) => buildDocsTools(ctx, { withRead: true }),
  prompt: ({ question }) => question,
};

function docsAgentTools(ctx: RunContext): ToolSet {
  const { search_docs } = buildDocsTools(ctx, { withRead: false });
  return {
    search_docs: search_docs!,
    research: tool({
      description:
        "Research several sub-questions in parallel with dedicated documentation researchers. Use only for comparisons, multi-product or multi-step questions. Pass 2-4 focused questions.",
      inputSchema: z.object({
        questions: z.array(z.string().min(1)).min(2).max(4).describe("2-4 self-contained sub-questions"),
      }),
      execute: async ({ questions }, options) => {
        const { ok, failed } = await runParallel(
          questions.map((question, i) => ({
            name: question,
            run: () => runSubagent(docsResearcher, { question }, ctx, options.toolCallId, i),
          })),
        );
        // A researcher that burned all its steps on tool calls returns no text: report it as failed.
        const answered = ok.filter((r) => r.value.text.trim() !== "");
        const empty = ok
          .filter((r) => r.value.text.trim() === "")
          .map((r) => ({ name: r.name, error: "no answer within the step limit" }));
        return {
          findings: answered.map((r) => ({ question: r.name, summary: r.value.text })),
          failed: [...failed, ...empty],
        };
      },
    }),
  };
}

export const docsAgent: AgentDef = {
  id: "cloudflare-docs",
  functionId: "docs-agent",
  defaultModel: "kimi-k2.6",
  maxSteps: 6,
  system: () =>
    [
      "你是「Cloudflare 文件專家」，只根據官方 Cloudflare 文件回答問題。",
      "簡單、單一主題的問題：直接呼叫 search_docs，再根據結果回答。",
      "只有在問題涉及比較、多個產品或多個步驟時，才呼叫 research，並傳入 2–4 個彼此獨立、可單獨搜尋的子問題。",
      "只能依據工具回傳的內容作答，不要憑空補充；找不到就明說。",
      "請用使用者提問的語言回答，並在相關段落附上英文原文文件連結。",
      "research 回傳後，直接整合 findings 作答，不要再重複搜尋同樣的內容。",
      "如果 research 的 failed 不是空的，必須在回答中註明哪些子問題沒有查到結果。",
    ].join("\n"),
  tools: docsAgentTools,
};
