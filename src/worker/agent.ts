import { AIChatAgent } from "agents/ai-chat-agent";
import { createWorkersAI } from "workers-ai-provider";
import { streamText } from "ai";
import { z } from "zod";
import type { Env } from "./types";

const SYSTEM_PROMPT = `你是一個由 Cloudflare Workers AI 驅動的智慧助理。你可以：
1. 回答一般性問題
2. 透過知識庫搜尋（AI Search）查詢已爬取的網站內容
3. 提供有關 Cloudflare 產品與功能的資訊

回答時請使用繁體中文，除非使用者使用其他語言提問。
回答要精確、有幫助，並在適當時引用資料來源。`;

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0]
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const agentState = this.state as { model?: string } | undefined;
    const modelId =
      agentState?.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

    const env = this.env;

    // Filter out any "data" role messages that agents SDK may inject
    const chatMessages = this.messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
      .map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content }));

    const searchKnowledgeParams = z.object({
      query: z.string().describe("搜尋查詢，使用與使用者問題相同的語言"),
      maxResults: z.number().optional().default(5).describe("最大結果數量 (1-10)"),
    });

    const result = streamText({
      model: workersai(modelId),
      system: SYSTEM_PROMPT,
      messages: chatMessages,
      tools: {
        searchKnowledge: {
          description:
            "搜尋知識庫中已爬取的網站內容。當使用者詢問與已爬取網站相關的問題時使用此工具。",
          inputSchema: searchKnowledgeParams,
          execute: async ({ query, maxResults }: z.infer<typeof searchKnowledgeParams>) => {
            try {
              const numResults = Math.min(Math.max(maxResults ?? 5, 1), 10);
              const ragResult = await (env.AI as any).autorag(
                env.AUTORAG_NAME
              ).search({
                query,
                max_num_results: numResults,
              });

              if (!ragResult?.data?.length) {
                return { found: false, message: "未找到相關的知識庫內容。" };
              }

              const filtered = ragResult.data
                .filter((item: { score: number }) => item.score >= 0.3)
                .map((item: { filename: string; score: number; content: Array<{ text: string }> }) => ({
                  filename: item.filename,
                  score: item.score,
                  text: item.content?.map((c: { text: string }) => c.text).join("\n"),
                }));

              if (!filtered.length) {
                return { found: false, message: "找到結果但相關性不足，請嘗試換個問法。" };
              }

              return { found: true, count: filtered.length, results: filtered };
            } catch (err) {
              return { error: `知識庫搜尋失敗: ${(err as Error).message}` };
            }
          },
        },
      },
      onFinish: onFinish as any,
    });

    return result.toUIMessageStreamResponse();
  }
}
