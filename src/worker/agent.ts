import { AIChatAgent } from "agents/ai-chat-agent";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages, stepCountIs } from "ai";
import { z } from "zod";
import type { Env } from "./types";

const SYSTEM_PROMPT = `你是一個由 Cloudflare Workers AI 驅動的智慧助理。你可以：
1. 回答一般性問題
2. 透過知識庫搜尋（AI Search）查詢已爬取的網站內容
3. 提供有關 Cloudflare 產品與功能的資訊
4. 使用已連線的 MCP 工具取得外部資訊

回答時請使用繁體中文，除非使用者使用其他語言提問。
回答要精確、有幫助，並在適當時引用資料來源。`;

export class ChatAgent extends AIChatAgent<Env> {
  onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: () =>
        new Response(
          `<!DOCTYPE html><html><head><title>Authorized</title></head><body>
          <script>
            window.opener && window.opener.postMessage('mcp-auth-done', '*');
            window.close();
          </script>
          <p>Authorized. You may close this window.</p>
          </body></html>`,
          { headers: { "content-type": "text/html" } }
        ),
    });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const mcpIdx = segments.indexOf("mcp");

    if (mcpIdx !== -1) {
      const sub = segments[mcpIdx + 1];

      if (sub === "connect" && request.method === "POST") {
        try {
          const { name, serverUrl } = (await request.json()) as {
            name: string;
            serverUrl: string;
          };
          const origin = new URL(request.url).origin;
          const result = await this.addMcpServer(name, serverUrl, origin);
          return Response.json(result);
        } catch (err) {
          const msg = (err as Error).message || "";
          const status = msg.includes("401") || msg.toLowerCase().includes("unauthorized") ? 401
            : msg.toLowerCase().includes("transport") ? 400
            : 500;
          return Response.json(
            { error: "connect_failed", message: msg, authRequired: status === 401 },
            { status }
          );
        }
      }

      if (sub === "disconnect" && request.method === "DELETE") {
        const serverId = segments[mcpIdx + 2];
        if (!serverId) {
          return Response.json({ error: "missing server id" }, { status: 400 });
        }
        await this.removeMcpServer(serverId);
        return Response.json({ ok: true });
      }

      if (sub === "servers" && request.method === "GET") {
        const servers = await this.getMcpServers();
        return Response.json({ servers });
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0]
  ) {
    const gatewayId = this.env.AI_GATEWAY_ID || "nkcf-gateway-01";
    console.log("[ChatAgent] Creating WorkersAI provider with gateway:", gatewayId);

    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: { id: gatewayId },
    });

    const agentState = this.state as { model?: string } | undefined;
    const modelId =
      agentState?.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

    console.log("[ChatAgent] Using model:", modelId);
    console.log("[ChatAgent] Message count:", this.messages.length);

    const env = this.env;

    // Convert UIMessage[] to model messages for streamText
    const chatMessages = await convertToModelMessages(this.messages);

    console.log("[ChatAgent] Converted messages:", chatMessages.length);

    const searchKnowledgeParams = z.object({
      query: z.string().describe("搜尋查詢，使用與使用者問題相同的語言"),
      maxResults: z.number().optional().default(5).describe("最大結果數量 (1-10)"),
    });

    const mcpTools = this.mcp.getAITools();
    console.log("[ChatAgent] MCP tools available:", Object.keys(mcpTools).length);

    try {
      const result = streamText({
        model: workersai(modelId),
        system: SYSTEM_PROMPT,
        messages: chatMessages,
        maxOutputTokens: 4096,
        stopWhen: stepCountIs(5),
        tools: {
          searchKnowledge: {
            description:
              "搜尋知識庫中已爬取的網站內容。當使用者詢問與已爬取網站相關的問題時使用此工具。",
            inputSchema: searchKnowledgeParams,
            execute: async ({ query, maxResults }: z.infer<typeof searchKnowledgeParams>) => {
              try {
                console.log("[ChatAgent] searchKnowledge called:", query);
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
                console.error("[ChatAgent] searchKnowledge error:", err);
                return { error: `知識庫搜尋失敗: ${(err as Error).message}` };
              }
            },
          },
          ...mcpTools,
        },
        onFinish: onFinish as any,
      });

      console.log("[ChatAgent] streamText initiated successfully");
      return result.toUIMessageStreamResponse();
    } catch (err) {
      console.error("[ChatAgent] streamText error:", err);
      throw err;
    }
  }
}
