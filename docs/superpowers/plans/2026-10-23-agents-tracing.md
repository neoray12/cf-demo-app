# Agents Demo（知識庫 / Cloudflare 文件 / 資安情資）+ Agent Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sidebar「MCP 卡控」下方新增「Agents」，內含三個接真實資料的通用型 agent（企業知識庫、Cloudflare 文件專家、資安情資 Radar），全部走 Workers AI，trace 同時送進 Cloudflare Agents tracing 並即時畫在畫面上（含 TTFT）。

**Architecture:** 沿用 Next.js（OpenNext）API route + Vercel AI SDK v6。`/api/agents/[agentId]` 用 `wrapAISDK(ai)` 包裝後的 `streamText` 經 AI Gateway compat 呼叫 Workers AI；subagent 是 AI SDK tool，`execute` 內再跑一次被包裝的 `streamText`，因此在 Cloudflare 上自動形成巢狀 `invoke_agent`。伺服器同時把每個 span 的開始 / 結束以 NDJSON 串給前端，前端用純函式 reducer 組成 trace tree 畫 waterfall。

**Tech Stack:** Next.js 15 + OpenNext、AI SDK `ai@6`、`@ai-sdk/openai`（compat）、`agents`（只用 `agents/observability/ai`）、`@modelcontextprotocol/sdk`（沿用 `src/lib/mcp-client.ts`）、AI Search REST、R2 S3 API / REST、Browser Rendering REST、Radar API、KV、shadcn（new-york）、recharts、vitest。

**Spec:** `docs/superpowers/specs/2026-10-23-agents-tracing-demo-design.md`（v3 + Radar 語意修正 `f9d9523`）

## Global Constraints

- 帳號 `5efa272dc28e4e3933324c44165b6dbe`；AI Gateway `nkcf-gateway-01`，compat base `https://gateway.ai.cloudflare.com/v1/{account}/nkcf-gateway-01/compat`，model id 形如 `workers-ai/@cf/...`。
- 只用 Workers AI 模型：`@cf/zai-org/glm-5.3-flash`、`@cf/moonshotai/kimi-k2.6`、`@cf/zai-org/glm-5.3`。
- 每個模型請求都帶 header `cf-aig-skip-cache: true`；Kimi 關思考用 body `reasoning_effort: "none"`（**不是** `chat_template_kwargs`）；所有 agent `max_tokens` ≥ 2000。
- 所有外部服務走 REST + `CF_API_TOKEN`（本地 `npm run dev` 要能跑），不新增 `[ai]` 以外的 binding 依賴。
- Tracing：`wrangler.toml` 加 `[observability.traces] enabled = true`、`head_sampling_rate = 1`。
- Tracing 身分：`functionId` 固定字串（`kb-agent`、`docs-agent`、`threat-intel-agent`、`docs-researcher`、`grounding-checker`、`attack-analyst`、`network-analyst`、`bot-analyst`）；`metadata.agentId = "{functionId}-demo"`；`metadata.conversationId` = 前端產生的對話 ID。
- UI 只用 shadcn 元件；預設繁體中文，所有字串進 `src/i18n/zh-TW.json` 與 `en.json`。
- 分支 `feat/agents-tracing`，從 `feat/mcp-guardrails` 切出；只做本地 commit，**push 前一定要問使用者**；**禁止** `wrangler deploy` / `npm run deploy`。
- 不建立 debug endpoint 或臨時檔；spike 用的檔案放 scratchpad，結束即刪。
- 單元測試：`npm test`（`vitest.config.ts`，`src/**/*.test.ts`，node 環境，`@` → `src`）。任何會被測試 import 的模組都**不可靜態 import `cloudflare:workers`**（只能在 `tracing.ts` 內動態 import）。
- 外部 fetch（MCP、Radar、AI Search、R2 REST）一律 `AbortSignal.timeout(20_000)`；Browser Rendering `30_000`；模型串流 60 s 沒有任何 part 視同 abort。

## Review Focus

1. **知識庫檢索 0 筆**：使用者問資料裡沒有的事，agent 必須回「知識庫中找不到相關資料」而不是用模型常識作答 → Task 7 `search_kb` 空結果測試。
2. **單一 subagent 失敗**（MCP 逾時、Radar 5xx、模型錯誤）：其他 subagent 的結果仍要回來，彙整時註明哪一面向失敗，trace 該 span 標紅 → Task 4 `runParallel` 測試。
3. **使用者中途離開 / 重送**：request 被中斷時要停止模型串流與 subagent，不留下永遠 open 的 span → Task 4 abort 測試。
4. **推理模型用光 `max_tokens` 沒有正文**（GLM-5.3 / Kimi 思考模式）：畫面要顯示「模型未產生回覆」而不是空白泡泡 → Task 3 `emptyAnswer` 測試。
5. **非台灣 / 寫法不標準的國家**（「日本」、`jp`、`Japan`）：`jp` 正規化成 `JP`；無法辨識的值回傳工具錯誤讓模型修正，不讓整個 run 崩潰 → Task 6 location 測試。

---

## 檔案結構

| 檔案 | 責任 |
|------|------|
| `src/lib/agents/ids.ts` | `AGENT_IDS`、`AgentId`（前後端共用，無任何相依） |
| `src/lib/agents/models.ts` | 模型清單（`ModelKey` → Workers AI id、reasoning effort、max tokens、顯示資訊） |
| `src/lib/agents/gateway.ts` | 建立經 AI Gateway 的 AI SDK model；注入 `reasoning_effort` |
| `src/lib/agents/trace-events.ts` | `TraceEvent` 型別、NDJSON 編碼 / 解析（前後端共用） |
| `src/lib/agents/trace-tree.ts` | 純函式 reducer：事件 → `RunTrace` tree；waterfall 攤平 |
| `src/lib/agents/tracing.ts` | `getTracedAI()`（`wrapAISDK`，本地 fallback）、active span 屬性 / 例外 |
| `src/lib/agents/runtime.ts` | `pipeStepStream`、`runSubagent`、`runParallel`、`runAgent` |
| `src/lib/agents/registry.ts` | 伺服器端 `AgentId → AgentDef` |
| `src/lib/agents/catalog.ts` | 前端可用的 agent metadata（路由、i18n key、預設模型、建議提示詞、功能旗標、Dashboard URL） |
| `src/lib/agents/json.ts` | `parseJsonLoose` |
| `src/lib/agents/tools/cf-docs.ts` | `search_docs`、`read_doc_page` 工具 |
| `src/lib/agents/tools/radar.ts` | Radar 白名單端點、parser、KV 快取、工具建構 |
| `src/lib/agents/tools/kb.ts` | `search_kb` 工具 |
| `src/lib/agents/kb.ts` | 工作區 ID、AI Search 搜尋 / 同步、R2 列表、上傳驗證 |
| `src/lib/agents/defs/{docs,threat-intel,knowledge-base}.ts` | 三個 agent 與其 subagent 定義 |
| `src/lib/r2-s3.ts` | 從 `save-to-r2` 抽出的 `s3Put`（可指定 bucket） |
| `src/app/api/agents/[agentId]/route.ts` | 執行 agent，回 NDJSON 串流 |
| `src/app/api/agents/kb/{upload,import-site,status,docs}/route.ts` | 知識庫工作區 API |
| `scripts/seed-kb/*.md`、`scripts/seed-kb/upload.sh` | 「雲朵科技」範例文件與上傳腳本 |
| `src/app/(dashboard)/agents/[agentId]/page.tsx` | 路由 |
| `src/app/pages/agent-chat.tsx` | 共用 agent 聊天頁 |
| `src/app/components/agents/use-agent-run.ts` | fetch + NDJSON + reducer + client TTFT |
| `src/app/components/agents/{trace-panel,span-detail,agent-message,kb-workspace,radar-chart}.tsx` | UI 元件 |
| `src/components/ui/select.tsx` | shadcn `select`（新增） |

---

### Task 0: 分支、相依套件、雲端資源

**Files:**
- Modify: `wrangler.toml`、`wrangler.dev.toml`、`package.json`
- Create: `src/components/ui/select.tsx`（shadcn CLI 產生）

- [ ] **Step 1: 建立 worktree**（主目錄 `main` 有使用者未提交的 MCP prompts 改動，不能動）

```bash
git worktree add ../cf-demo-app-agents -b feat/agents-tracing feat/mcp-guardrails
cd ../cf-demo-app-agents
git cherry-pick df66fa2 f9d9523 <本計畫的 commit>   # git log main --oneline -3 -- docs/superpowers
cp ../cf-demo-app/.dev.vars .
npm ci
```

- [ ] **Step 2: 安裝相依**：`npm i agents@0.30.0`；`npx shadcn@latest add select`。確認 `npm test` 仍全綠（guardrails 既有測試）。

- [ ] **Step 3: wrangler 設定**：`wrangler.toml` 與 `wrangler.dev.toml` 都加：

```toml
[observability.traces]
enabled = true
head_sampling_rate = 1
```
兩份 `[vars]` 都加 `KB_AI_SEARCH = "cf-demo-kb"`、`KB_BUCKET_NAME = "cf-demo-kb"`。（不加 R2 binding：與爬蟲一樣走 S3 API / REST，本地 dev 才寫得到真的 bucket——這是對 spec 6.1「R2 binding `KB_BUCKET`」的刻意偏離。）

- [ ] **Step 4: 建 R2 bucket**：`npx wrangler r2 bucket create cf-demo-kb`。驗證：`npx wrangler r2 bucket list` 列出 `cf-demo-kb`。

- [ ] **Step 5: 建 AI Search instance `cf-demo-kb`**：`POST /accounts/{account}/ai-search/instances`，設定複製自 `cf-demo-ai-search`（`GET .../ai-search/instances/cf-demo-ai-search` 取得），只改 `id: "cf-demo-kb"`、`source: "cf-demo-kb"`；保留 `token_id`、`ai_gateway_id: "nkcf-gateway-01"`、`embedding_model: "@cf/qwen/qwen3-embedding-0.6b"`、`rewrite_query: true`、`reranking: true`、`chunk_size: 1024`、`score_threshold: 0.4`。若 API 拒絕，改在 Dashboard 用相同設定建立。驗證：`GET .../ai-search/instances/cf-demo-kb` 回 `success: true`。

- [ ] **Step 6: Commit**

```bash
git add wrangler.toml wrangler.dev.toml package.json package-lock.json src/components/ui/select.tsx
git commit -m "chore: enable agent tracing, add agents package and KB config"
```

---

### Task 1: Spike（不留產品程式碼，只留結論與測試 fixture）

目的：鎖定三件 spec 沒能事先確定的事，結論寫進 spec §7。

- [ ] **Step 1: `wrapAISDK` 在 OpenNext 下能否運作**
  1. 在 scratchpad 寫最小 route（不 commit），`import * as ai from "ai"; import { wrapAISDK } from "agents/observability/ai";` 呼叫 `generateText`。
  2. `npm run dev`（Node）：記錄靜態 import 是否崩潰；若崩潰，改 `await import("agents/observability/ai")` 包 try/catch 是否可行。
  3. `npx opennextjs-cloudflare build && npx opennextjs-cloudflare preview`（workerd，本地；**不是 deploy**）：確認 wrapped 呼叫成功、`cloudflare:workers` 被正確 external。
  4. 結論 → 決定 Task 4 `getTracedAI()` 用靜態或動態 import。刪除 spike route。

- [ ] **Step 2: AI Search 資料夾過濾與索引延遲**
  1. 用 `npx wrangler r2 object put cf-demo-kb/spike/a.md --file <scratch>.md --remote` 上傳一份含獨特字串的檔案，觸發 `POST .../ai-search/instances/cf-demo-kb/jobs`，每 15 秒 `POST .../ai-search/namespaces/default/instances/cf-demo-kb/search` 查詢，記錄「上傳 → 可查到」秒數。
  2. 試出資料夾過濾的 body 寫法（候選：`ai_search_options.retrieval.filters = { type: "eq", key: "folder", value: "spike/" }`；或 `{ type: "gte", key: "folder", value: "spike/" }` + `lt "spike0"` 的前綴寫法）。用另一個資料夾的檔案確認被排除。
  3. 刪除 `spike/` 物件。結論 → Task 7 `kbSearchBody()` 的確切格式；索引延遲 > 3 分鐘則 KB UI 文案強調「會前準備工作區」。

- [ ] **Step 3: 擷取測試 fixture**（會 commit，作為 Task 5、6 的測試資料）
  - `src/lib/agents/tools/__fixtures__/cf-docs-search.txt`：`search_cloudflare_documentation` 對「Workers vs Pages」的原始 `content[0].text`。
  - `src/lib/agents/tools/__fixtures__/radar/{attackers_of,l7_attacks_from,l3_attacks_mitigated_in,top_attacked_industries,l7_attack_trend_from,outages,traffic_anomalies,bgp_hijacks,internet_quality,bot_vs_human,ai_crawlers,email_threats,domain_rank}.json`：依 Task 6 端點表各抓一份原始回應（`compareLastWeek` 的那幾支抓帶 `7dControl` 的版本；`traffic_anomalies` 抓到空陣列也照存）。

- [ ] **Step 4: 把三項結論寫進 spec §7 並 commit**

```bash
git add docs/superpowers/specs/2026-10-23-agents-tracing-demo-design.md src/lib/agents/tools/__fixtures__
git commit -m "docs: record agents tracing spike results; add tool fixtures"
```

---

### Task 2: 模型清單與 Gateway model

**Files:**
- Create: `src/lib/agents/models.ts`、`src/lib/agents/gateway.ts`
- Test: `src/lib/agents/gateway.test.ts`

**Interfaces:**
- Produces:
  - `type ModelKey = "glm-5.3-flash" | "kimi-k2.6" | "kimi-k2.6-thinking" | "glm-5.3"`
  - `interface AgentModel { key: ModelKey; workersAiId: string; reasoningEffort: "low" | "none" | "high"; maxTokens: number; labelKey: string; slow: boolean; ttftHint: string }`
  - `const AGENT_MODELS: Record<ModelKey, AgentModel>`
  - `function injectBodyParams(init: RequestInit | undefined, params: Record<string, unknown>): RequestInit | undefined`
  - `function createAgentModel(env: AgentEnv, model: AgentModel, meta: { functionId: string; conversationId: string }): LanguageModel`（`AgentEnv` 定義於 Task 4 `runtime.ts`；此處先 import type）

- [ ] **Step 1: 寫失敗測試**

```ts
describe("injectBodyParams", () => {
  it("adds reasoning_effort to a JSON body", () => {
    const out = injectBodyParams({ method: "POST", body: JSON.stringify({ model: "m", stream: true }) }, { reasoning_effort: "none" });
    expect(JSON.parse(out!.body as string)).toEqual({ model: "m", stream: true, reasoning_effort: "none" });
  });
  it("leaves non-JSON or missing bodies untouched", () => {
    expect(injectBodyParams(undefined, { reasoning_effort: "low" })).toBeUndefined();
    const init = { body: "not json" };
    expect(injectBodyParams(init, { reasoning_effort: "low" })).toBe(init);
  });
});
describe("AGENT_MODELS", () => {
  it("pins the measured settings", () => {
    expect(AGENT_MODELS["glm-5.3-flash"]).toMatchObject({ workersAiId: "@cf/zai-org/glm-5.3-flash", reasoningEffort: "low", slow: false });
    expect(AGENT_MODELS["kimi-k2.6"]).toMatchObject({ workersAiId: "@cf/moonshotai/kimi-k2.6", reasoningEffort: "none", slow: false });
    expect(AGENT_MODELS["kimi-k2.6-thinking"]).toMatchObject({ workersAiId: "@cf/moonshotai/kimi-k2.6", reasoningEffort: "high", slow: true });
    expect(AGENT_MODELS["glm-5.3"]).toMatchObject({ workersAiId: "@cf/zai-org/glm-5.3", reasoningEffort: "low", slow: true });
    for (const m of Object.values(AGENT_MODELS)) expect(m.maxTokens).toBeGreaterThanOrEqual(2000);
  });
});
```

- [ ] **Step 2: 執行確認失敗**：`npx vitest run src/lib/agents/gateway.test.ts` → FAIL（模組不存在）。

- [ ] **Step 3: 實作**
  - `maxTokens`：thinking 8000，其餘 4000。`ttftHint`：flash `"0.8–2.8s"`、kimi `"0.7–8.8s"`、kimi-thinking `"思考 0.6–1s／正文 16–25s"`、glm-5.3 `"1–36s"`。`labelKey` = `agents.models.{key}`。
  - `createAgentModel`：`createOpenAI({ apiKey: env.CF_API_TOKEN, baseURL: compat, headers: { "cf-aig-authorization": "Bearer " + env.CF_AIG_TOKEN（有才帶）, "cf-aig-skip-cache": "true", "cf-aig-metadata": JSON（{ agent: functionId, conversation: conversationId }，非 ASCII 用 `\uXXXX` 跳脫，同 chat route 做法） }, fetch: (url, init) => fetch(url, injectBodyParams(init, { reasoning_effort: model.reasoningEffort })) }).chat("workers-ai/" + model.workersAiId)`。

- [ ] **Step 4: 執行確認通過**：同 Step 2 → PASS。

- [ ] **Step 5: Commit**：`git add src/lib/agents/models.ts src/lib/agents/gateway.ts src/lib/agents/gateway.test.ts && git commit -m "feat(agents): Workers AI model catalog via AI Gateway"`

---

### Task 3: Trace 事件協定與 trace tree reducer

**Files:**
- Create: `src/lib/agents/ids.ts`、`src/lib/agents/trace-events.ts`、`src/lib/agents/trace-tree.ts`
- Test: `src/lib/agents/trace-events.test.ts`、`src/lib/agents/trace-tree.test.ts`

**Interfaces:**
- Produces（`trace-events.ts`，型別照 spec §6.2，另加 `run-end.status`）：
  - `type SpanKind = "invoke_agent" | "chat" | "execute_tool"`
  - `type TraceEvent`（spec §6.2 全部成員；`run-end` 增加 `status: "ok" | "error" | "aborted"`、`error?: string`）
  - `type CitationEvent = Extract<TraceEvent, { type: "citation" }>`、`type ChartEvent = Extract<TraceEvent, { type: "chart" }>`
  - `function encodeEvent(e: TraceEvent): string`（JSON + `"\n"`）
  - 另建 `src/lib/agents/ids.ts`：`export const AGENT_IDS = ["knowledge-base", "cloudflare-docs", "threat-intel"] as const; export type AgentId = (typeof AGENT_IDS)[number];`
  - `function createNdjsonParser(): { push(chunk: string): TraceEvent[]; flush(): TraceEvent[] }`
- Produces（`trace-tree.ts`）：
  - `interface SpanNode { id: string; parentId?: string; kind: SpanKind; name: string; start: number; end: number | null; status?: "ok" | "error"; usage?: { input: number; output: number }; ttftMs?: number; detail?: unknown; children: SpanNode[] }`
  - `interface RunTrace { runId: string; agent: string; model: string; spans: Record<string, SpanNode>; rootIds: string[]; text: string; reasoning: string; citations: CitationEvent["source"][]; charts: ChartEvent["chart"][]; ttftMs?: number; totalMs?: number; usage?: { input: number; output: number }; status: "running" | "ok" | "error" | "aborted"; error?: string; emptyAnswer: boolean }`
  - `function reduceTrace(state: RunTrace | null, e: TraceEvent): RunTrace`（不可變更新）
  - `function waterfallRows(trace: RunTrace): Array<{ node: SpanNode; depth: number }>`（DFS，同層依 `start` 排序）

- [ ] **Step 1: 寫失敗測試**
  - `createNdjsonParser`：`push('{"type":"run-st')` → `[]`；再 `push('art",...}\n{"type":"text-delta"...}\n')` → 兩個事件；`flush()` 處理無結尾換行的最後一行；空行忽略。
  - `reduceTrace`：
    - 巢狀：`span-start invoke_agent a` → `span-start chat a:chat:0 (parent a)` → `span-end` → `rootIds = ["a"]`、`spans.a.children[0].id === "a:chat:0"`。
    - 並行 subagent：`t1`(execute_tool) 底下三個 `invoke_agent` 的 `start` 相同、`end` 不同，`waterfallRows` 深度為 2、依 start 再依插入順序。
    - `text-delta` 累加到 `text`；`run-end { ttftMs: 812, totalMs: 3800 }` 寫入。
    - **Review Focus 4**：`run-end status "ok"` 但從未收到 `text-delta` → `emptyAnswer === true`；有 text 則 `false`。
    - `run-end status "aborted"` → 所有 `end === null` 的 span 補上 `end = totalMs`、`status = "error"`。
    - `span-end status "error"` 的 `detail` 保留。

- [ ] **Step 2: 執行確認失敗**：`npx vitest run src/lib/agents/trace-` → FAIL。

- [ ] **Step 3: 實作兩個模組**（`span-start` 若 parent 尚不存在，先放 `spans`、等 parent 出現時不需回補——事件順序保證 parent 先 start；不存在時當 root）。

- [ ] **Step 4: 執行確認通過** → PASS。

- [ ] **Step 5: Commit**：`git commit -m "feat(agents): NDJSON trace events and trace tree reducer"`（加入上述 4 檔）

---

### Task 4: Tracing 包裝與 agent runtime

**Files:**
- Create: `src/lib/agents/tracing.ts`、`src/lib/agents/runtime.ts`、`src/lib/agents/json.ts`
- Test: `src/lib/agents/runtime.test.ts`、`src/lib/agents/json.test.ts`

**Interfaces:**
- Consumes: Task 2 `createAgentModel`、`AGENT_MODELS`；Task 3 `TraceEvent`。
- Produces（`tracing.ts`）：
  - `function getTracedAI(opts: { storeContent: boolean }): Promise<typeof import("ai")>`（`agents/observability/ai` 與 `cloudflare:workers` 只能在函式內動態 import；依 Task 1 結論：OpenNext / workerd 下回傳 `wrapAISDK(ai, { storeMessages: storeContent, storeTools: storeContent })`；不可用時回傳原生 `ai`；依 flag memoize）
  - `function setActiveSpanAttributes(attrs: Record<string, string | number | boolean>): void`、`function recordActiveSpanException(err: unknown): void`（`tracing.getActiveSpan()`，不可用時 no-op）
- Produces（`runtime.ts`）：
  - `interface AgentEnv { CF_ACCOUNT_ID: string; CF_API_TOKEN: string; CF_AIG_TOKEN?: string; AI_GATEWAY_ID: string; KB_AI_SEARCH: string; KB_BUCKET_NAME: string; MCP_SERVER_URLS: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string; KV: KVNamespace }`
  - `interface RunContext { env: AgentEnv; ai: typeof import("ai"); emit(e: TraceEvent): void; now(): number; conversationId: string; storeContent: boolean; workspace?: string; signal: AbortSignal }`
  - `interface SubagentDef<I> { functionId: string; model: ModelKey; system: string; maxSteps: number; tools(ctx: RunContext): ToolSet; prompt(input: I): string; toDetail?(text: string): unknown }`（`toDetail` 省略時 detail 為 `{ output: text.slice(0, 2000) }`）
  - `interface ToolResultRecord { toolName: string; output: unknown }`
  - `interface AgentDef { id: AgentId; functionId: string; defaultModel: ModelKey; maxSteps: number; system(ctx: RunContext): string; tools(ctx: RunContext): ToolSet; after?(ctx: RunContext, result: { text: string; rootSpanId: string; toolResults: ToolResultRecord[] }): Promise<void> }`（`AgentId` 來自 `ids.ts`）
  - `function pipeStepStream(stream: AsyncIterable<TextStreamPart<ToolSet>>, ctx: RunContext, opts: { parentSpanId: string; modelLabel: string; forwardText: boolean }): Promise<{ text: string; firstTokenAt?: number; toolResults: ToolResultRecord[] }>`
  - `function runSubagent<I>(def: SubagentDef<I>, input: I, ctx: RunContext, parentSpanId: string, index: number): Promise<{ text: string }>`
  - `function runParallel<T>(tasks: Array<{ name: string; run(): Promise<T> }>): Promise<{ ok: Array<{ name: string; value: T }>; failed: Array<{ name: string; error: string }> }>`
  - `function runAgent(def: AgentDef, messages: ModelMessage[], modelKey: ModelKey, ctx: RunContext): Promise<void>`
  - `function parseJsonLoose<T>(text: string): T | null`（`json.ts`；去掉 ```json 圍欄、取第一個 `{`…最後一個 `}`）

- [ ] **Step 1: 寫失敗測試**（用 fake async iterable 模擬 v6 `fullStream` part）
  - `pipeStepStream` 對序列 `start-step` → `reasoning-delta`(t=500) → `text-delta`(t=800) → `tool-call{toolCallId:"c1",toolName:"search_docs"}` → `tool-result{toolCallId:"c1"}` → `finish-step{usage:{inputTokens:120,outputTokens:30}}` → `start-step` → `text-delta` → `finish-step` 發出的事件依序為：`span-start chat P:chat:0`、`reasoning-delta`、`text-delta`、`span-start execute_tool c1 (parent P)`、`span-end c1 ok`、`span-end P:chat:0 { ttftMs: 500, usage: {input:120, output:30} }`、`span-start chat P:chat:1` …（`now()` 由測試注入）。
  - `forwardText: false` 時不發 `text-delta` / `reasoning-delta`，但回傳的 `text` 仍是完整文字、`ttftMs` 仍計算。
  - `tool-error` → `span-end status "error"`、`detail: { error }`。
  - **Review Focus 3**：`signal` 在第二個 part 後 abort → 迭代停止、所有已開的 span 都收到 `span-end status "error" detail {error:"aborted"}`，函式 reject `AbortError`。
  - **Review Focus 2**：`runParallel([ok("a"), fail("b","boom"), ok("c")])` → `ok` 有 a、c，`failed` 為 `[{name:"b", error:"boom"}]`，不 throw。
  - `parseJsonLoose('```json\n{"unsupported":[]}\n```')` → `{ unsupported: [] }`；`parseJsonLoose("nope")` → `null`。

- [ ] **Step 2: 執行確認失敗** → FAIL。

- [ ] **Step 3: 實作**
  - span id：chat 用 `${parentSpanId}:chat:${stepIndex}`；tool 用 `toolCallId`；subagent 用 `${parentSpanId}:${functionId}:${index}`。
  - idle：`pipeStepStream` 每收到一個 part 重設 60 s 計時器，逾時走與 abort 相同的收尾路徑（`detail.error = "idle timeout"`）。
  - `runSubagent`：發 `span-start invoke_agent`（name = `functionId`）→ `ctx.ai.streamText({ model: createAgentModel(...), system, prompt, tools, stopWhen: stepCountIs(maxSteps), maxOutputTokens: model.maxTokens, abortSignal: ctx.signal, experimental_telemetry: { isEnabled: true, functionId, metadata: { agentId: functionId + "-demo", conversationId } } })` → `pipeStepStream(..., { forwardText: false })` → `span-end`（`detail: { output: text.slice(0, 2000) }`）。錯誤時 `recordActiveSpanException` 並 rethrow。
  - `runAgent`：`run-start` → 根 span `invoke_agent`（id = `runId`）→ 主 `streamText`（`forwardText: true`，`messages`）→ `def.after?.()` → 根 `span-end` → `run-end`（`ttftMs` = 第一個可見 token 相對 run 開始；`usage` 為所有 chat span 加總，由 runtime 自行累加）。任何例外 → `run-end status "error"`；abort → `"aborted"`。

- [ ] **Step 4: 執行確認通過** → PASS。

- [ ] **Step 5: Commit**：`git commit -m "feat(agents): traced runtime with subagents, parallel fan-out and span events"`

---

### Task 5: Cloudflare 文件專家 agent + `/api/agents/[agentId]` route

**Files:**
- Create: `src/lib/agents/tools/cf-docs.ts`、`src/lib/agents/defs/docs.ts`、`src/lib/agents/registry.ts`、`src/app/api/agents/[agentId]/route.ts`
- Test: `src/lib/agents/tools/cf-docs.test.ts`

**Interfaces:**
- Consumes: Task 4 全部；`parseMcpServerUrls`、`callMcpTool`（`src/lib/mcp-client.ts`）。
- Produces:
  - `function parseDocsSearchResult(text: string): Array<{ url: string; title: string; snippet: string }>`（snippet 取前 600 字）
  - `function isAllowedDocUrl(url: string): boolean`
  - `function buildDocsTools(ctx: RunContext, opts: { withRead: boolean }): ToolSet`（`search_docs({ query })`、`read_doc_page({ url })`）
  - `const docsResearcher: SubagentDef<{ question: string }>`、`const docsAgent: AgentDef`
  - `const AGENTS: Record<AgentId, AgentDef>`（此 task 先只有 `cloudflare-docs`）
  - Route：`POST /api/agents/{agentId}`，body `{ messages: Array<{ role: "user" | "assistant"; content: string }>; model?: ModelKey; conversationId: string; workspace?: string; storeContent?: boolean }` → `200 application/x-ndjson`；未知 agent → 404 JSON；`messages` 空或 `conversationId` 缺 → 400。

- [ ] **Step 1: 寫失敗測試**
  - `parseDocsSearchResult(fixture)`：長度 ≥ 1，每筆 `url` 以 `https://developers.cloudflare.com/` 開頭、`title` 非空。
  - `isAllowedDocUrl`：允許 `https://developers.cloudflare.com/workers/`；拒絕 `http://developers.cloudflare.com/`、`https://developers.cloudflare.com.evil.com/`、`https://evil.com/?u=https://developers.cloudflare.com/`、`javascript:alert(1)`。

- [ ] **Step 2: 執行確認失敗** → FAIL。

- [ ] **Step 3: 實作工具與 agent**
  - `search_docs`：`callMcpTool(cfDocsServer, "search_cloudflare_documentation", { query })`，回傳前 5 筆 parse 結果；每筆發 `citation` 事件（`spanId` = toolCallId）。
  - `read_doc_page`：`isAllowedDocUrl` 不通過 → 回 `{ error }`；通過 → `POST .../browser-rendering/markdown { url }`，回 markdown 前 12000 字。逾時 30 s。
  - `docsResearcher`（`functionId: "docs-researcher"`、`glm-5.3-flash`、`maxSteps: 4`、tools `withRead: true`）：system 要求只根據工具結果、以條列摘要並附 URL。
  - `docsAgent`（`functionId: "docs-agent"`、預設 `kimi-k2.6`、`maxSteps: 6`）：tools = `search_docs` + `research({ questions: string[] /* 2–4 */ })`；`research.execute` 用 `runParallel` 對每題 `runSubagent(docsResearcher, { question }, ctx, toolCallId, i)`，回 `{ findings: ok, failed }`。system（繁中）：簡單題直接 `search_docs`；涉及比較 / 多產品 / 步驟的問題才用 `research`；回答用使用者語言，附英文原文連結；`failed` 非空時要註明。

- [ ] **Step 4: 實作 route**：`getCloudflareContext()` 取 env；`ReadableStream` + `TextEncoder`，`ctx.emit = e => controller.enqueue(encodeEvent(e))`；建一個 `AbortController`，在 `request.signal` abort 時與 `ReadableStream` 的 `cancel()` 被呼叫時都 abort 它，`signal = controller.signal`；`ai = await getTracedAI({ storeContent: body.storeContent ?? true })`；`runAgent(...)` 完成後 `controller.close()`。Header `Cache-Control: no-store`。

- [ ] **Step 5: 執行單元測試** → PASS。

- [ ] **Step 6: 端到端驗證**：`npm run dev` 後

```bash
curl -sN -X POST localhost:3000/api/agents/cloudflare-docs -H 'content-type: application/json' \
  -d '{"conversationId":"t1","messages":[{"role":"user","content":"Durable Objects、KV、D1 各適合什麼情境？"}]}'
```
預期：首行 `run-start`；出現 `span-start` `execute_tool` `research` 與其下 ≥ 2 個 `invoke_agent docs-researcher`（同一 `parentId`）；出現 `citation`；末行 `run-end` `status:"ok"`、`ttftMs` 有值。再問「Workers 是什麼？」預期**沒有** `research`（快速路徑）。

- [ ] **Step 7: Commit**：`git commit -m "feat(agents): Cloudflare docs agent with parallel researchers and NDJSON route"`

---

### Task 6: Radar 工具與資安情資 agent

**Files:**
- Create: `src/lib/agents/tools/radar.ts`、`src/lib/agents/defs/threat-intel.ts`
- Modify: `src/lib/agents/registry.ts`（加 `threat-intel`）
- Test: `src/lib/agents/tools/radar.test.ts`

**Interfaces:**
- Consumes: Task 4、Task 1 fixtures。
- Produces:
  - `type RadarToolName` = 下表 14 個名稱
  - `interface RadarResult { title: string; scope: string; unit: "percent" | "normalized" | "mbps" | "ms" | "rank" | "events"; period: string; data: Array<{ label: string; value: number; previous?: number }>; events?: Array<{ date: string; title: string; detail?: string }>; sourceUrl: string; note?: string }`
  - `function normalizeLocation(input: string | undefined): string`（預設 `"TW"`；`/^[a-z]{2}$/i` → 大寫；否則 throw `Error("location 必須是 ISO 3166-1 alpha-2 代碼，例如 TW、JP、US")`）
  - `function buildRadarRequest(name: RadarToolName, input: Record<string, unknown>): { path: string; params: URLSearchParams }`
  - `function parseRadar(name: RadarToolName, json: unknown, input: Record<string, unknown>): RadarResult`
  - `function radarQuery(env: AgentEnv, name: RadarToolName, input: Record<string, unknown>): Promise<RadarResult & { cacheHit: boolean }>`（KV key `radar:${name}:${params.toString()}`，TTL 600 s）
  - `function buildRadarTools(ctx: RunContext, names: RadarToolName[]): ToolSet`
  - `const attackAnalyst, networkAnalyst, botAnalyst: SubagentDef<{ question: string; location: string; domain?: string }>`、`const threatIntelAgent: AgentDef`

**端點表**（`scope` 文字照抄；`period` 由 `meta.dateRange` 組成 `YYYY-MM-DD ~ YYYY-MM-DD`；`compareLastWeek` 時加 `dateRange=7dControl`，`previous` 取 `summary_1` / `top_1` 同 label 值）：

| 工具 | 端點與參數 | unit | scope | sourceUrl |
|------|-----------|------|-------|-----------|
| `attackers_of(location, compareLastWeek)` | `attacks/layer7/top/locations/origin?location=&dateRange=7d&limit=10` | percent | 攻擊{國}的來源國家（應用層） | `https://radar.cloudflare.com/security/application-layer/{cc}` |
| `attack_targets_from(location)` | `attacks/layer7/top/locations/target?location=&dateRange=7d&limit=10` | percent | 源自{國}的攻擊目標國家（應用層） | 同上 |
| `l7_attacks_from(location, dimension, compareLastWeek)` | `attacks/layer7/summary/{mitigation_product\|http_method}?location=&dateRange=7d` | percent | 源自{國}的應用層攻擊，依{維度}分布 | 同上 |
| `l3_attacks_mitigated_in(location, compareLastWeek)` | `attacks/layer3/summary/vector?location=&dateRange=7d` | percent | 在{國}資料中心緩解的網路層攻擊手法 | `https://radar.cloudflare.com/security/network-layer/{cc}` |
| `top_attacked_industries()` | `attacks/layer7/top/industry?dateRange=7d&limit=10`（**不帶 location**） | percent | 全球最常被攻擊的產業（應用層） | `https://radar.cloudflare.com/security/application-layer` |
| `l7_attack_trend_from(location)` | `attacks/layer7/timeseries?location=&dateRange=7d&aggInterval=1d` | normalized | 源自{國}的應用層攻擊量趨勢（0–1 正規化，非次數） | 同 L7 |
| `outages(location, recentOnly)` | `annotations/outages?location=&limit=10`（`recentOnly` 時加 `dateRange=52w`） | events | {國}的網路中斷事件 | `https://radar.cloudflare.com/outage-center` |
| `traffic_anomalies(location)` | `traffic_anomalies?location=&dateRange=28d&limit=10` | events | {國}近 28 天的流量異常 | `https://radar.cloudflare.com/{cc}` |
| `bgp_hijacks(location)` | `bgp/hijacks/events?involvedCountry=&dateRange=28d&per_page=10` | events | 近 28 天涉及{國} ASN 的 BGP 劫持事件 | `https://radar.cloudflare.com/routing/{cc}` |
| `internet_quality(location)` | `quality/speed/summary?location=` | mbps / ms（拆成兩組 data：頻寬 mbps、延遲 ms；`unit` 取 `mbps`，延遲放 `note`） | {國}的網路速度品質（近 90 天） | `https://radar.cloudflare.com/quality/{cc}` |
| `bot_vs_human(location)` | `http/summary/bot_class?location=&dateRange=7d` | percent | {國}的 HTTP 流量中人類與機器人占比 | `https://radar.cloudflare.com/traffic/{cc}` |
| `ai_crawlers(location)` | `ai/bots/summary/user_agent?location=&dateRange=7d` | percent | {國}的 AI 爬蟲流量依 user agent 分布 | `https://radar.cloudflare.com/ai-insights` |
| `email_threats()` | `email/security/summary/malicious?dateRange=7d` | percent | 全球郵件中惡意郵件占比 | `https://radar.cloudflare.com/email-security` |
| `domain_rank(domain)` | `ranking/domain/{domain}`（domain 須符合 `^[a-z0-9.-]+\.[a-z]{2,}$`） | rank | {domain} 的全球熱門度排名與分類 | `https://radar.cloudflare.com/domains/domain/{domain}` |

`{國}` 以 `Intl.DisplayNames(["zh-TW"], { type: "region" })` 轉中文；`{cc}` 小寫。`events` 類若陣列為空，`data: []`、`note: "此期間無紀錄"`。

- [ ] **Step 1: 寫失敗測試**（全部用 Task 1 fixtures）
  - 每個工具 `parseRadar` 至少一個斷言：`attackers_of` 帶 compare → `data[0]` 形如 `{ label: "美國", value: 22.605155, previous: 22.985498 }`（以 fixture 實際值為準）、`unit "percent"`、`scope` 含「攻擊臺灣的來源國家」或「攻擊台灣」（依 `Intl.DisplayNames` 實際輸出鎖定）。
  - `l7_attack_trend_from` → `unit "normalized"`、`scope` 含「非次數」。
  - `traffic_anomalies` 空 fixture → `data: []`、`note: "此期間無紀錄"`。
  - `buildRadarRequest("top_attacked_industries", { location: "TW" })` 的 params **不含** `location`；任何工具的 params 都不含 `industry`。
  - **Review Focus 5**：`normalizeLocation("jp") === "JP"`；`normalizeLocation(undefined) === "TW"`；`normalizeLocation("Japan")` throw；`buildRadarTools` 的 `execute` 遇到 throw 時**回傳** `{ error }`（不 reject）。
  - `domain_rank` 拒絕 `"https://x.com"`、`"a b.com"`。

- [ ] **Step 2: 執行確認失敗** → FAIL。

- [ ] **Step 3: 實作 `radar.ts`**：`execute` 內呼叫 `radarQuery`、`setActiveSpanAttributes({ "cache.hit": cacheHit, "radar.endpoint": path })`；`data.length > 0` 時 `ctx.emit({ type: "chart", spanId: toolCallId, chart: { kind: unit === "normalized" ? "line" : "bar", title, unit, period, data: data.map(({label, value}) => ({label, value})), sourceUrl } })`。回給模型的是完整 `RadarResult`。

- [ ] **Step 4: 驗證 sourceUrl 都存在**：對端點表每個 `sourceUrl`（`{cc}=tw`、`domain=cloudflare.com`）跑 `curl -s -o /dev/null -w '%{http_code}\n' -L <url>`，預期全部 `200`；不是 200 的改成 `https://radar.cloudflare.com/{cc}`。

- [ ] **Step 5: 實作 agent**
  - 三位分析師（`glm-5.3-flash`、`maxSteps: 4`）：`attack-analyst` 拿前 6 個工具；`network-analyst` 拿 `outages`、`traffic_anomalies`、`bgp_hijacks`、`internet_quality`；`bot-analyst` 拿 `bot_vs_human`、`ai_crawlers`、`email_threats`、`domain_rank`。共同 system（繁中）：只能引用工具回傳的數字；描述時**照抄 `scope`**，不可把「源自台灣」說成「台灣被攻擊」；數字是占比或正規化值，不是次數；空資料說「此期間無紀錄」；Radar 不提供單一產業在某國的被攻擊數字。
  - `threatIntelAgent`（`functionId: "threat-intel-agent"`、預設 `kimi-k2.6`、`maxSteps: 4`）：唯一工具 `brief({ question: string, analysts: ("attack"|"network"|"bot")[] /* 1–3 */, location?: string, domain?: string })` → `runParallel` 跑選中的分析師，回 `{ reports: ok, failed }`。system：依問題挑分析師；最後輸出「三點重點 → 數據表 → 建議的 Cloudflare 產品 → Radar 來源連結」，`failed` 非空要註明。

- [ ] **Step 6: 單元測試 PASS；端到端**：`curl` 問「誰在攻擊台灣？跟上週比有什麼變化？」→ 出現 `invoke_agent attack-analyst`、≥ 1 個 `chart` 事件、`run-end ok`。再問「台灣金融業上週被攻擊幾次？」→ 回覆說明 Radar 不提供該數字（人工讀 `text-delta`）。

- [ ] **Step 7: Commit**：`git commit -m "feat(agents): Radar threat intel agent with analyst subagents"`

---

### Task 7: 知識庫核心、範例資料與知識庫 agent

**Files:**
- Create: `src/lib/agents/kb.ts`、`src/lib/agents/tools/kb.ts`、`src/lib/agents/defs/knowledge-base.ts`、`scripts/seed-kb/*.md`（8 份）、`scripts/seed-kb/upload.sh`
- Modify: `src/lib/agents/registry.ts`（加 `knowledge-base`）
- Test: `src/lib/agents/kb.test.ts`

**Interfaces:**
- Produces（`kb.ts`）：
  - `function isValidWorkspace(id: string): boolean`（`/^(default|ws-[a-z0-9]{8})$/`）、`function newWorkspaceId(): string`
  - `function kbSearchBody(workspace: string, query: string, maxResults: number): object`（過濾格式依 Task 1 結論）
  - `function kbSearch(env: AgentEnv, workspace: string, query: string, maxResults?: number): Promise<{ results: Array<{ filename: string; score: number; snippet: string; sourceUrl: string | null }>; topScore: number }>`
  - `function kbListDocs(env: AgentEnv, workspace: string): Promise<Array<{ key: string; size: number; uploaded: string }>>`（R2 REST `GET /r2/buckets/{bucket}/objects?prefix={workspace}/`）
  - `function kbTriggerSync(env: AgentEnv): Promise<string | null>`、`function kbSyncStatus(env: AgentEnv): Promise<{ status: string; lastActivity: string | null }>`
  - `function validateUpload(file: { name: string; size: number }, existingCount: number): string | null`（回錯誤訊息 key 或 null）
  - `function buildKbTools(ctx: RunContext): ToolSet`（`search_kb({ query, maxResults? })`）
  - `const groundingChecker: SubagentDef<{ answer: string; sources: string }>`、`const kbAgent: AgentDef`

- [ ] **Step 1: 寫失敗測試**
  - `isValidWorkspace`：`default`、`ws-a1b2c3d4` true；`ws-../x`、`WS-A1B2C3D4`、`ws-a1b2c3d` false；`newWorkspaceId()` 通過驗證。
  - `validateUpload`：11 MB → `"agents.kb.errors.tooLarge"`；`a.exe` → `"agents.kb.errors.badType"`；`existingCount === 20` → `"agents.kb.errors.tooMany"`；`a.pdf`/`.docx`/`.md`/`.txt` 5 MB → `null`。
  - `kbSearchBody("ws-a1b2c3d4", "q", 5)` 含 Task 1 確定的資料夾過濾。
  - **Review Focus 1**：`search_kb` 在 `kbSearch` 回空時（注入 stub），工具回傳 `{ results: [], instruction: "知識庫中沒有相關資料。請明確回覆找不到，不要用一般知識作答。" }`。

- [ ] **Step 2: 執行確認失敗** → FAIL。

- [ ] **Step 3: 實作 `kb.ts` 與 `search_kb`**：`kbSearch` 沿用 `chat-tools.ts` `aiSearchQuery` 的請求形狀（REST `.../ai-search/namespaces/default/instances/{KB_AI_SEARCH}/search`，score < 0.3 丟棄，snippet 前 500 字）；`search_kb` 每筆結果發 `citation`，並 `setActiveSpanAttributes({ "kb.results": n, "kb.top_score": topScore })`。

- [ ] **Step 4: 實作 agent**
  - `kbAgent`（`functionId: "kb-agent"`、`glm-5.3-flash`、`maxSteps: 4`）：system（繁中）：先用 `search_kb` 檢索（可改寫成中英關鍵字再查一次）；只根據結果回答，每句句尾標 `[n]` 對應來源；查無資料時照工具 `instruction` 回覆。
  - `after()`：從 `toolResults` 取出 `search_kb` 的結果，有任何 result 時 `runSubagent(groundingChecker, { answer: text, sources: <編號後的 snippet 清單> }, ctx, rootSpanId, 0)`；`groundingChecker`（`glm-5.3-flash`、`maxSteps: 1`、無工具）輸出 JSON `{"unsupported": string[]}`，`toDetail` 用 `parseJsonLoose` 解析成 `{ unsupported }`，解析失敗為 `{ unsupported: [], parseError: true }`。

- [ ] **Step 5: 範例資料**：`scripts/seed-kb/` 寫 8 份繁中 markdown（虛構「雲朵科技股份有限公司」）：`employee-handbook.md`（特休依年資天數、請假、加班費）、`travel-expense.md`（住宿上限：台北 3,200 元 / 其他縣市 2,600 元 / 海外依地區、報帳期限 30 天）、`it-support-faq.md`（VPN 已改 Cloudflare WARP、WARP 連不上內網排錯 5 步驟、密碼重設）、`security-policy.md`、`product-spec-cloudbox.md`、`customer-service-sop.md`、`onboarding-checklist.md`、`office-guide.md`。每份 600–1500 字，含可被提問驗證的具體數字。`upload.sh`：對每檔 `npx wrangler r2 object put cf-demo-kb/default/<name> --file <path> --content-type text/markdown --remote`，最後 `curl -X POST .../ai-search/instances/cf-demo-kb/jobs`。執行它。

- [ ] **Step 6: 單元測試 PASS；端到端**（等索引完成後）：`curl` `knowledge-base`，`workspace:"default"`，問「出差住宿上限多少？」→ `citation` 指向 `default/travel-expense.md`、回覆含「3,200」、出現 `invoke_agent grounding-checker`；問「公司股價多少？」→ 回覆含「找不到」、`search_kb` span 後無 citation。

- [ ] **Step 7: Commit**：`git commit -m "feat(agents): knowledge base agent with grounding check and sample workspace"`

---

### Task 8: 知識庫工作區 API（上傳 / 匯入網站 / 狀態 / 文件清單）

**Files:**
- Create: `src/lib/r2-s3.ts`、`src/app/api/agents/kb/upload/route.ts`、`src/app/api/agents/kb/import-site/route.ts`、`src/app/api/agents/kb/status/route.ts`、`src/app/api/agents/kb/docs/route.ts`
- Modify: `src/app/api/crawler/save-to-r2/route.ts`（改用 `src/lib/r2-s3.ts`）
- Test: `src/lib/r2-s3.test.ts`

**Interfaces:**
- Produces:
  - `function s3Put(opts: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; key: string; body: ArrayBuffer | Uint8Array; contentType: string; metadata?: Record<string, string> }): Promise<Response>`（從 `save-to-r2` 原樣搬出，`R2_BUCKET_NAME` 改為參數）
  - `POST /api/agents/kb/upload`：multipart `file`、`workspace` → `{ key, indexJobId }`；驗證失敗 400 `{ error: <i18n key> }`
  - `POST /api/agents/kb/import-site`：`{ url, workspace }` → 啟動 Browser Rendering crawl（`limit: 30`、`depth: 2`、`formats: ["markdown"]`）→ `{ jobId }`；`GET ?jobId=&workspace=` → 進行中 `{ status: "running", finished, total }`；完成時把每頁 markdown 寫入 `{workspace}/site/{slug}.md`（metadata `sourceurl`），觸發同步，回 `{ status: "completed", saved }`
  - `GET /api/agents/kb/status` → `kbSyncStatus`；`GET /api/agents/kb/docs?workspace=` → `kbListDocs`
  - 所有 route 先 `isValidWorkspace`，不通過 400。

- [ ] **Step 1: 寫失敗測試**：`s3Put` 以 stub `fetch` 驗證請求 URL 為 `https://{accountId}.r2.cloudflarestorage.com/{bucket}/{key}`、帶 `x-amz-meta-sourceurl`、`Authorization` 以 `AWS4-HMAC-SHA256` 開頭。

- [ ] **Step 2: 執行確認失敗** → FAIL。

- [ ] **Step 3: 搬移 `s3Put` 並改 `save-to-r2` 使用它**（行為不變）。

- [ ] **Step 4: 實作四個 route**（crawl 的請求 / 輪詢 body 形狀照 `src/app/api/browser-rendering/[endpoint]/route.ts` 現有用法；slug = URL path 轉 `[a-z0-9-]`，最長 80，空字串用 `index`）。

- [ ] **Step 5: 驗證**：`npm test` PASS；`npm run dev` 後
  - 上傳一份 md 到 `ws-test0001` → 200；`GET /api/agents/kb/docs?workspace=ws-test0001` 列出它。
  - 爬蟲頁「存入 R2」功能仍可用（回歸）。
  - 清除：`npx wrangler r2 object delete cf-demo-kb/ws-test0001/<key> --remote`。

- [ ] **Step 6: Commit**：`git commit -m "feat(agents): knowledge base workspace upload, site import and status APIs"`

---

### Task 9: Agent 聊天頁、Trace 面板、Sidebar、i18n

**Files:**
- Create: `src/lib/agents/catalog.ts`、`src/app/(dashboard)/agents/[agentId]/page.tsx`、`src/app/pages/agent-chat.tsx`、`src/app/components/agents/use-agent-run.ts`、`src/app/components/agents/trace-panel.tsx`、`src/app/components/agents/span-detail.tsx`、`src/app/components/agents/agent-message.tsx`
- Modify: `src/app/components/app-sidebar.tsx`（「MCP 卡控」項目之後）、`src/i18n/zh-TW.json`、`src/i18n/en.json`
- Test: `src/lib/agents/catalog.test.ts`

**Interfaces:**
- Consumes: Task 3 `createNdjsonParser`、`reduceTrace`、`waterfallRows`、`RunTrace`；Task 2 `AGENT_MODELS`。
- Produces:
  - `interface AgentCatalogEntry { id: AgentId; path: string; icon: LucideIcon; titleKey: string; descKey: string; defaultModel: ModelKey; suggestionKeys: string[]; features: { workspace: boolean; charts: boolean; grounding: boolean } }`、`const AGENT_CATALOG: AgentCatalogEntry[]`（順序：知識庫、文件、資安情資；路徑 `/agents/knowledge-base`、`/agents/cloudflare-docs`、`/agents/threat-intel`；icon `BookOpen`、`FileSearch`、`Radar`）
  - `const AGENTS_DASHBOARD_URL: string`（暫定 `https://dash.cloudflare.com/5efa272dc28e4e3933324c44165b6dbe/workers-and-pages/observability`，Task 11 確認後更新）
  - `function useAgentRun(agentId: AgentId): { turns: Array<{ user: string; trace: RunTrace | null; clientTtftMs?: number }>; send(text: string, opts: { model: ModelKey; workspace?: string; storeContent: boolean }): void; stop(): void; running: boolean; conversationId: string; reset(): void }`（`clientTtftMs` = 按下送出到第一個 `text-delta`/`reasoning-delta` 的 `performance.now()` 差；`stop` 呼叫 `AbortController.abort()`）

- [ ] **Step 1: 寫失敗測試**：`AGENT_CATALOG.map(a => a.id)` 等於 `AGENT_IDS`（不要 import `registry.ts`——它會拉進伺服器模組）、所有 `titleKey`/`descKey`/`suggestionKeys` 都存在於 `zh-TW.json` 與 `en.json`（用 `import zh from "@/i18n/zh-TW.json"` 以點路徑查值）。

- [ ] **Step 2: 執行確認失敗** → FAIL。

- [ ] **Step 3: catalog + i18n**：新增 `sidebar.agents`、`agents.{knowledgeBase,cloudflareDocs,threatIntel}.{title,desc,suggestions.*}`、`agents.models.*`、`agents.trace.*`（首字、總耗時、tokens、工具、subagent、在 Cloudflare 查看、模型未產生回覆、已中止）、`agents.kb.*`（含 `errors.tooLarge/badType/tooMany`、內容會記錄於 trace 7 天的提醒、「不記錄內容」開關）。建議提示詞照 spec §4 各 agent 的「建議提示詞」。

- [ ] **Step 4: Sidebar**：在「MCP 卡控」`SidebarMenuItem` 之後加 `Collapsible`（樣式同爬蟲群組，`defaultOpen={pathname.startsWith("/agents")}`，icon `Workflow`，標籤 `sidebar.agents`），子項目由 `AGENT_CATALOG` 產生。

- [ ] **Step 5: 頁面與元件**
  - `page.tsx`：client component，`use(params)` 取 `agentId`；不在 catalog → `notFound()`。
  - `agent-chat.tsx` 版面照 spec §6.3：Header（標題、說明、模型 `Select`（顯示 `ttftHint`，`slow` 加「首字較慢」`Badge`）、「在 Cloudflare 查看 Trace」外部連結 `Button`）；左側 `ScrollArea` 聊天、空狀態建議 `Card`、`Textarea` + 送出 / 停止 `Button`；右側 `TracePanel`；`< md` 時 Trace 進 `Sheet`，Header 顯示「Trace」按鈕，每輪回覆下方顯示小指標列。
  - `agent-message.tsx`：`MarkdownRenderer`（沿用）、來源清單、`Collapsible` 顯示工具 / subagent 呼叫（名稱、耗時、`detail`）、思考內容；`trace.emptyAnswer` 時顯示 `agents.trace.emptyAnswer`；`status "aborted"` 顯示已中止。
  - `trace-panel.tsx`：指標 `Badge` 列（client TTFT、server TTFT、總耗時、tokens in→out、工具數、subagent 數、模型）；輪次切換（`Tabs`）；`waterfallRows` 每列 = 縮排名稱 + 以 `totalMs` 為 100% 的絕對定位時間條（`invoke_agent` / `chat` / `execute_tool` 三色，error 紅色，chat 條上以 ▲ 標 `ttftMs`）；點列開 `SpanDetail`（`Tabs`：概要 / detail JSON / tokens）。
  - 對話 ID：`crypto.randomUUID()`，「新對話」按鈕重置。

- [ ] **Step 6: 驗證**：`npm test` PASS；`npx tsc --noEmit` 無新錯誤；`npm run dev` 用瀏覽器開 `/agents/cloudflare-docs`、`/agents/threat-intel`：送建議提示詞 → 文字串流、waterfall 即時長出並行 subagent 列、指標顯示 TTFT；中途按停止 → 所有 span 收尾、顯示已中止；切到 375 px 寬 → Trace 在 Sheet 內；深色模式可讀。

- [ ] **Step 7: Commit**：`git commit -m "feat(agents): agent chat pages with live trace waterfall and sidebar entry"`

---

### Task 10: 知識庫工作區 UI、Radar 圖表、引用驗證徽章

**Files:**
- Create: `src/app/components/agents/kb-workspace.tsx`、`src/app/components/agents/radar-chart.tsx`
- Modify: `src/app/pages/agent-chat.tsx`、`src/app/components/agents/agent-message.tsx`、i18n 兩檔

**Interfaces:**
- Consumes: Task 8 四個 KB API；Task 3 `RunTrace.charts`、grounding-checker span 的 `detail.unsupported`。
- Produces: `<KbWorkspace value={workspace} onChange={setWorkspace} storeContent={…} onStoreContentChange={…} />`、`<RadarChart chart={ChartEvent["chart"]} />`

- [ ] **Step 1: `KbWorkspace`**（`features.workspace` 時顯示於聊天上方 `Card`）：工作區 `Select`（「雲朵科技範例」= `default`、「我的工作區」= localStorage `cf-demo-kb-workspace` 中的 `ws-xxxxxxxx`，沒有就「建立」）；拖放上傳（`validateUpload` 先在前端擋）；「匯入網站」`Input` + `Button`（輪詢顯示進度）；文件清單；同步狀態 `Badge`（每 10 s 輪詢 `/status`，直到 idle）；`storeContent` 開關與 7 天提醒文字。`default` 工作區不顯示上傳 / 匯入。

- [ ] **Step 2: `RadarChart`**：recharts，`bar` → 橫條圖（有 `previous` 時第二組淺色條標「上週」）、`line` → 折線圖；標題、`period`、`unit` 說明（normalized 顯示「相對值」）、`sourceUrl` 連結；顏色用既有 CSS 變數以支援深色模式。`agent-message.tsx` 依 `chart.spanId` 把圖放在對應工具呼叫下方。

- [ ] **Step 3: 引用驗證徽章**：找 `name === "grounding-checker"` 的 span：`unsupported.length === 0` → 綠色「引用驗證：全部有依據」；否則黃色「n 句缺少依據」並在 `Collapsible` 列出句子；`parseError` → 灰色「驗證未完成」。

- [ ] **Step 4: 驗證**（`npm run dev` + 瀏覽器）：`/agents/knowledge-base` 用 `default` 問三個建議提示詞 → 有來源與綠色徽章；建立我的工作區、上傳一份 PDF → 清單出現、同步完成後可查到內容；匯入一個小網站（如 `https://example.com`）→ 進度到完成；`/agents/threat-intel` 問「台灣的流量有多少是機器人？哪些 AI 爬蟲最活躍？」→ 兩張圖、來源連結可點；深色模式圖表可讀。測完刪除測試工作區物件。

- [ ] **Step 5: Commit**：`git commit -m "feat(agents): KB workspace UI, Radar charts and grounding badge"`

---

### Task 11: 文件、production 驗證

**Files:**
- Modify: `AGENTS.md`（新增「### 7. Agents Demo」：三個 agent、資料源、檔案表、Radar `location` 語意表、模型實測結論、KB bucket / instance 名稱、tracing 設定與 2026-12-01 計費提醒）、`src/lib/agents/catalog.ts`（`AGENTS_DASHBOARD_URL`）

- [ ] **Step 1: 寫 `AGENTS.md` 段落並 commit**：`git commit -m "docs: record Agents demo in AGENTS.md"`

- [ ] **Step 2: 本地總驗證**：`npm test` 全綠；`npx tsc --noEmit`；`npx opennextjs-cloudflare build` 成功（只 build，不 deploy）。

- [ ] **Step 3: 請使用者確認 push**（AGENTS.md 規定）。說明：push `feat/agents-tracing` 的方式（PR 或合併到 main 觸發 CI/CD）由使用者決定；`.dev.vars` 的 secrets 已在 production 存在，無需新增。**未獲同意前停在這裡。**

- [ ] **Step 4: Production 驗證**（部署後）：三個 agent 各跑一次建議提示詞；Dashboard → Agents 分頁確認出現 `kb-agent`、`docs-agent`、`threat-intel-agent`，點進去 session replay 有訊息與工具參數、Trace waterfall 中 subagent 巢狀在 `execute_tool` 底下且並行；記下 Agents 分頁實際 URL，更新 `AGENTS_DASHBOARD_URL` 並 commit（`fix(agents): point trace link at Agents dashboard`）。若 subagent 沒有巢狀或 agent 未出現，回到 Task 4 檢查 `experimental_telemetry` 與 `getTracedAI` 是否在 workerd 下回傳 wrapped 版本。
