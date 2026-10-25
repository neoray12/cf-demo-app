# Harness 工具政策、MCP Subagent、執行細節與完整 Tracing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主聊天不再有「工具 / Code Mode」手動開關：Harness 依規則決定工具，大型 MCP 交給 subagent，Code Mode 由開發者設定並以一個對照範例比較，每一步的呼叫、token、時間都顯示在畫面上並全部進 Agent Tracing。

**Architecture:** 新的純函式 `resolveToolPolicy()` 決定每輪工具；`/api/chat` 在既有 NDJSON 之外送 Agents Demo 的 span 事件（`trace-events.ts`），主模型的 span 由新的 `createChatSpanTracker()` 從 AI SDK stream 產生，subagent 重用 `runSubagent()`（runtime 加一個模型解析 hook）；前端用 `reduceTrace()` 建 span 樹，畫摘要、waterfall、subagent 卡片與 Code Mode 對照表。

**Tech Stack:** Next.js 15 / OpenNext on Workers、Vercel AI SDK v6（`streamText`、`stepCountIs`）、`agents/observability/ai`（`wrapAISDK`）、`@modelcontextprotocol/sdk`、D1 + R2、vitest。

**Spec:** `docs/superpowers/specs/2026-10-25-harness-tools-subagents-observability-design.md`

## Global Constraints

- 聊天工具列不得有「工具」或「Code Mode」按鈕；請求不再帶 `toolsEnabled` / `codeMode`。
- `MCP_SERVER_URLS` 只有一個 SAP & Salesforce 條目：`saas=https://saasmcp.neokung.work/mcp:oauth:agent:codemode`；不得出現 `saas-cm`。
- Portal Code Mode 的 URL 是原 URL 加 `?codemode=search_and_execute`。
- `MCP_DIRECT_MAX = 8`：已連線 MCP 工具數 > 8 或帶 `:agent` 旗標 → 走 subagent。
- 委派工具名稱 `ask_<serverId>`（`serverId` 中的非 `[A-Za-z0-9_-]` 字元換成 `_`），參數 `{ task: string }`。
- Subagent `functionId`：`<serverId>-agent`（例 `saas-agent`）；主聊天 `functionId: "main-chat"`、`metadata.agentId: "main-chat-demo"`。
- Subagent `maxSteps` 8，與主模型同一個模型、同一個 AI Gateway compat provider。
- `cf-aig-metadata` 恰好 5 個 key：`email`、`usertier`、`department`、`code_mode`（boolean）、`test`（實驗 ID，一般聊天 `"none"`）。
- 對照範例：`experiment.id = "sf-agg"`，題目用 i18n `chat.codeModeSuggestions.agg`，先 `codeMode: false` 再 `codeMode: true`。
- 只有 `experiment.codeMode` 能在請求層覆蓋 Code Mode。
- App Code Mode（`src/lib/codemode.ts`、`/api/codemode-exec`、`SELF` binding）整套移除；`LOADER` 保留。
- 所有模型呼叫走 `getTracedAI({ storeContent: true })`。
- 部署只能 `git push`（CI），不得 `wrangler deploy`；未經使用者要求不 push。

## Review Focus

1. 沒連上 SAP & Salesforce 就點對照範例 → 應提示先連線、開 MCP 面板，不送出（Task 11 測試）。
2. 選了不支援工具的模型（Perplexity）但已連 `saas` → 不註冊任何工具、不出現 `ask_saas`，正常文字回答（Task 2 測試）。
3. Subagent 的 MCP 呼叫被 Gateway 規則攔截 → 委派結果帶 `blocked: true`，主模型不重試，畫面出現 🛡 卡片（Task 6 測試）。
4. 使用者在 subagent 執行中按停止 → subagent 被中止，所有開著的 span 都有 `span-end`（status `error`），歷史記為 `client-aborted`（Task 5 測試）。
5. 開啟這次改版前存的舊對話（沒有 span 事件）→ 不崩潰，退回舊的處理過程摘要（Task 9 測試）。

---

### Task 0: 實測（不改程式）

**Files:** Modify: `docs/superpowers/specs/2026-10-25-harness-tools-subagents-observability-design.md`（新增「實測結果」一節）

- [ ] **Step 1:** 本地 `npm run dev`，在 MCP 面板以 OAuth 連上 SAP & Salesforce；用 `/api/mcp/tools` 記錄 `saas` 工具數與全部工具定義的 JSON 長度（字元數 ÷ 4 ≈ tokens）。
- [ ] **Step 2:** 用同一個 session 的 token 連 `https://saasmcp.neokung.work/mcp?codemode=search_and_execute`（暫時在本地 `.dev.vars` 外另加一行 `MCP_SERVER_URLS` 測試值，不 commit），確認 `tools/list` 回 `portal_codemode_search` / `portal_codemode_execute`。結果：可共用 → Task 6 用同一個 token；不可 → Task 6 以 `mcp-token:{session}:saas#codemode` 分開存（面板仍一張卡）。
- [ ] **Step 3:** 量核心工具定義長度（`buildToolSet` 的工具 description + JSON schema），記錄。
- [ ] **Step 4:** `curl -H "Authorization: Bearer $CF_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/5efa272dc28e4e3933324c44165b6dbe/ai-gateway/gateways/nkcf-gateway-01/logs?per_page=1` 是否 200，記錄（決定後續能否顯示費用）。
- [ ] **Step 5:** 把四項結果寫進 spec「實測結果」，commit：`docs(spec): harness tools measurements`。

### Task 1: MCP URL 旗標與合併 SAP & Salesforce

**Files:**
- Modify: `src/lib/mcp-client.ts`（`McpServerConfig`、`parseMcpServerUrls`、`SERVER_LABELS`）
- Modify: `wrangler.toml`、`wrangler.dev.toml`（`MCP_SERVER_URLS`）
- Modify: `src/app/components/chat/mcp-panel.tsx`（移除 `'saas-cm'` logo）、`src/app/pages/chat.tsx`（`MCP_SERVER_LABELS` 移除 `saas-cm`）、`src/lib/mcp-guardrails.ts`（`GATEWAY_ROUTED_MCP_SERVERS` 只剩 `saas`）
- Test: `src/lib/mcp-client.test.ts`（新建）

**Interfaces:**
- Produces: `McpServerConfig` 新增 `delegate: boolean`、`codeMode: boolean`；`portalCodeModeUrl(url: string): string`（回傳加上 `codemode=search_and_execute` 的 URL，已有 query 時用 `&`）。

- [ ] **Step 1:** 寫失敗測試 `parseMcpServerUrls`：
  - `"saas=https://saasmcp.neokung.work/mcp:oauth:agent:codemode"` → `{ id: "saas", url: "https://saasmcp.neokung.work/mcp", authType: "oauth", delegate: true, codeMode: true }`
  - `"cf-docs=https://docs.mcp.cloudflare.com/mcp"` → `delegate: false, codeMode: false, authType: "none"`
  - 旗標順序互換（`:codemode:oauth`）結果相同
  - `portalCodeModeUrl("https://a/mcp")` → `"https://a/mcp?codemode=search_and_execute"`；`portalCodeModeUrl("https://a/mcp?x=1")` → `"https://a/mcp?x=1&codemode=search_and_execute"`
- [ ] **Step 2:** `npx vitest run src/lib/mcp-client.test.ts` → FAIL。
- [ ] **Step 3:** 實作：從尾端反覆剝除 `:oauth` / `:agent` / `:codemode`；`saas-cm` 從 `SERVER_LABELS` 刪除，`saas` 的說明改為「透過 MCP Server Portal 連接 SAP 與 Salesforce（由專屬 subagent 執行）」。
- [ ] **Step 4:** 兩個 wrangler 檔的 `MCP_SERVER_URLS` 改成 Global Constraints 的值（`cf-docs`、`cf-observability`、`cf-radar` 不變，刪 `saas-cm`）；`grep -rn "saas-cm" src wrangler*.toml` 只剩舊測試（一併刪）。
- [ ] **Step 5:** `npx vitest run` → PASS；commit `feat(mcp): single SAP & Salesforce server with agent/codemode flags`。

### Task 2: Harness 工具政策

**Files:**
- Create: `src/lib/tool-policy.ts`
- Test: `src/lib/tool-policy.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig`（Task 1）。
- Produces:
  ```ts
  export const MCP_DIRECT_MAX = 8;
  export interface ToolPolicyInput {
    modelSupportsTools: boolean;
    bindings: { sandbox: boolean; loader: boolean; browser: boolean };
    hasImages: boolean;
    servers: Array<{ config: McpServerConfig; toolCount: number }>; // 已連線
    experiment?: { id: string; codeMode: boolean };
  }
  export interface ToolPolicy {
    core: string[];                       // 核心工具名稱
    directServers: string[];              // 工具直接給主模型的 server id
    delegated: Array<{ serverId: string; toolName: string; codeMode: boolean }>;
  }
  export function resolveToolPolicy(input: ToolPolicyInput): ToolPolicy;
  export function delegateToolName(serverId: string): string; // "ask_" + sanitized id
  ```

- [ ] **Step 1:** 失敗測試：
  - `modelSupportsTools: false` → `{ core: [], directServers: [], delegated: [] }`（Review Focus 2）
  - 全 binding、無圖 → `core` 等於 `["searchKnowledge","readWebPage","captureScreenshot","executeJs","executeCode","createWebPreview"]`；有圖再加 `"searchKnowledgeByImage"`；`loader: false` 時沒有 `executeJs`
  - `cf-docs` 2 個工具 → `directServers: ["cf-docs"]`
  - 工具數 9、無旗標 → 進 `delegated`，`codeMode: false`
  - `saas`（`delegate: true, codeMode: true`）工具數 3 → `delegated: [{ serverId: "saas", toolName: "ask_saas", codeMode: true }]`
  - `experiment: { id: "sf-agg", codeMode: false }` → `saas` 的 `codeMode` 變 `false`
  - `delegateToolName("cf.radar")` → `"ask_cf_radar"`
- [ ] **Step 2:** 跑測試 → FAIL。
- [ ] **Step 3:** 實作（純函式，無 I/O）。
- [ ] **Step 4:** 跑測試 → PASS；commit `feat(chat): harness tool policy`。

### Task 3: AI Gateway metadata

**Files:**
- Create: `src/lib/gateway-metadata.ts`
- Test: `src/lib/gateway-metadata.test.ts`

**Interfaces:**
- Produces: `buildGatewayMetadata(input: { email?: string; codeMode: boolean; test?: string }): string`（回傳已 `\uXXXX` 跳脫的 JSON 字串）；`usertier` / `department` 規則從 `src/app/api/chat/route.ts` 的 `VIP_EMAILS` / `TECH_EMAILS` 搬來。

- [ ] **Step 1:** 失敗測試：
  - `{ email: "neo@cloudflare.com", codeMode: true, test: "sf-agg" }` → 解析後恰好 `{ email: "neo@cloudflare.com", usertier: "regular", department: "技術", code_mode: true, test: "sf-agg" }`
  - `{ codeMode: false }` → `email: "unknown"`、`test: "none"`
  - `Object.keys(...)` 長度恰為 5
  - 字串不含 `\x7E` 以上字元（`department` 的中文已跳脫）
- [ ] **Step 2:** FAIL → **Step 3:** 實作 → **Step 4:** PASS；commit `feat(chat): five-key AI Gateway metadata`。

### Task 4: Runtime 模型解析 hook

**Files:**
- Modify: `src/lib/agents/runtime.ts`（`RunContext`、`runSubagent` 內 `733–739` 一帶的模型建立）
- Test: `src/lib/agents/runtime.test.ts`（新增案例）

**Interfaces:**
- Produces: `RunContext.languageModel?: (functionId: string) => { model: LanguageModel; label: string; maxOutputTokens?: number }`。有設定時 `runSubagent` 用它取代 `AGENT_MODELS[...]` + `createAgentModel`；`span` 的 model label 用 `label`；沒設定時行為與現在完全相同。

- [ ] **Step 1:** 新增測試：`runSubagent` 在 `ctx.languageModel` 存在時，傳給 `ai.streamText` 的 `model` 是 hook 回傳值，`maxOutputTokens` 取 hook 的值；`experimental_telemetry.functionId` 仍是 `def.functionId`。
- [ ] **Step 2:** FAIL → **Step 3:** 實作 → **Step 4:** `npx vitest run src/lib/agents` 全部 PASS（既有測試不變）；commit `feat(agents): languageModel hook for subagents`。

### Task 5: 主模型 span 追蹤器

**Files:**
- Create: `src/lib/chat-spans.ts`
- Test: `src/lib/chat-spans.test.ts`

**Interfaces:**
- Consumes: `TraceEvent`（`src/lib/agents/trace-events.ts`）。
- Produces:
  ```ts
  export const MAIN_ROOT_SPAN = "main";
  export interface ChatSpanTracker {
    start(t: number): TraceEvent[];                         // run-start 與 root invoke_agent span-start
    onPart(part: { type: string; [k: string]: unknown }, t: number, gateway?: GatewayInfo): TraceEvent[];
    end(t: number, status: "ok" | "error" | "aborted", error?: string): TraceEvent[]; // 關閉所有開著的 span + run-end
    usage(): { input: number; output: number };              // 主模型累計
  }
  export interface GatewayInfo { logId: string | null; cacheStatus: string | null; ray: string | null; routedModel: string | null }
  export function createChatSpanTracker(opts: { model: string; traced: boolean }): ChatSpanTracker;
  ```
  - chat span id：`main/step-<n>`；tool span id：`toolSpanId(MAIN_ROOT_SPAN, toolCallId)`。
  - `start-step` → chat span-start；`finish-step` → chat span-end（`usage`、`ttftMs` = 第一個 text/reasoning delta − span 開始、`detail: { finishReason, gateway }`）；`tool-input-start` → tool span-start；`tool-call` → `span-input`；`tool-result` / `tool-error` → tool span-end（`detail.blocked` 取結果的 `blocked`）。

- [ ] **Step 1:** 失敗測試（以假 parts 序列驅動）：
  - 兩步（呼叫 1 個工具後回答）→ 事件順序：run-start、root start、step-1 start、tool start、tool input、tool end、step-1 end、step-2 start、step-2 end；`usage()` 等於兩步 usage 加總
  - `ttftMs` 正確（用給定的 `t`）
  - `end(t, "aborted")` 在工具 span 還開著時，先送該 tool 的 `span-end`（status `error`）、再 chat span、再 root、最後 `run-end`（Review Focus 4）
  - 同一個 `toolCallId` 的 `tool-input-start` 重複時只開一次
- [ ] **Step 2:** FAIL → **Step 3:** 實作 → **Step 4:** PASS；commit `feat(chat): span tracker for the main chat stream`。

### Task 6: MCP 委派工具（subagent）

**Files:**
- Create: `src/lib/mcp-subagent.ts`
- Modify: `src/lib/chat-tools.ts`（把 `buildMcpTools` 拆出可只建單一 server 的 `buildServerTools(env, sessionId, server, opts: { codeMode: boolean })`；Portal 目錄提示沿用 `buildPortalCatalogPrompt` 的邏輯，改為單一 server）
- Test: `src/lib/mcp-subagent.test.ts`

**Interfaces:**
- Consumes: `delegateToolName`（Task 2）、`RunContext.languageModel`（Task 4）、`runSubagent` / `SubagentDef`（runtime）、`portalCodeModeUrl`（Task 1）。
- Produces:
  ```ts
  export function subagentDef(server: McpServerConfig, tools: ToolSet, catalogPrompt: string, codeMode: boolean): SubagentDef<{ task: string }>;
  export function buildDelegateTool(args: {
    server: McpServerConfig; toolNames: string[]; ctx: RunContext; parentSpanId: string;
    loadTools(): Promise<{ tools: ToolSet; catalogPrompt: string }>; codeMode: boolean;
  }): Tool<{ task: string }, { result: string; blocked?: boolean; error?: string }>;
  ```
  - `subagentDef(...).functionId` = `${server.id}-agent`、`maxSteps` = 8；system prompt 含：只用此 server 工具、回傳精簡結果（表格 / 數字 / ID）、不貼原始 JSON、遇到 `blocked: true` 照實回報不重試；`codeMode` 時附 `catalogPrompt`。
  - 委派工具 description：`{server.name}：{server.description}。可用操作：{toolNames 逗號分隔}`。
  - Subagent 的任一工具結果 `blocked: true` → 委派結果帶 `blocked: true`（Review Focus 3）。

- [ ] **Step 1:** 失敗測試：
  - `subagentDef(saas, tools, "CATALOG", true)` 的 `system` 含 `"CATALOG"`；`codeMode: false` 時不含
  - `functionId === "saas-agent"`、`maxSteps === 8`
  - 用假 `runSubagent`（注入）回傳含 `{ blocked: true }` 的工具結果 → `execute` 回傳 `blocked: true`
  - Subagent 失敗（重試後仍失敗）→ `execute` 回傳 `{ error }`，不 throw
- [ ] **Step 2:** FAIL → **Step 3:** 實作（`runSubagent` 以參數注入以便測試；預設用 runtime 的）。依 Task 0 Step 2 結果決定 token key。
- [ ] **Step 4:** PASS；commit `feat(chat): MCP servers run as subagents via ask_<server>`。

### Task 7: `/api/chat` 整合

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/lib/chat-tools.ts`（`buildToolSet` 改吃 `ToolPolicy`）
- Modify: `src/lib/chat-history.ts`（`TurnRequestInfo` 移除 `toolsEnabled` / `codeMode` / `codeModeActive` / `appCodeModeSkipped`，新增 `toolPolicy: ToolPolicy`、`experiment: { id: string; codeMode: boolean } | null`）

**Interfaces:**
- Consumes: Task 1–6 全部。
- Produces: 請求 body 新欄位 `experiment?: { id: string; codeMode: boolean }`；NDJSON 新增 `TraceEvent` 系列（主模型由 tracker、subagent 由 `runSubagent` 經 `ctx.emit`）；subagent 的 delta 事件帶 `spanId`。

- [ ] **Step 1:** 刪除 `toolsEnabled`、`codeMode`、`appCodeModeSkipped`、`CODE_MODE_PROMPT`、`codemode` 包裝區塊；`useTools` 改為 `modelSupportsTools(...)`。
- [ ] **Step 2:** 建 `RunContext`：`ai` = traced ai、`emit` = `send`、`now` = recorder 時鐘、`conversationId`、`storeContent: true`、`signal` = 請求的 abort signal、`languageModel` = 以 `openai.chat(compatModelId)` 建立（provider 的 `cf-aig-metadata` 用 `buildGatewayMetadata({ email, codeMode: <該 subagent 的 codeMode>, test })`）、`agent: { name: "main-chat", id: "main-chat-demo" }`。主模型 provider 的 metadata 用 `codeMode: false`。
- [ ] **Step 3:** 依 `resolveToolPolicy` 組工具：核心工具、`directServers` 的 MCP 工具、`delegated` 的 `buildDelegateTool`。MCP 連線 / 工具清單、Portal 目錄、附件上傳、sandbox 預熱都包進 `runTracedTool(ctx, MAIN_ROOT_SPAN, <name>, input, fn)`；名稱依序 `mcp.connect:<id>`、`mcp.catalog:<id>`、`sandbox.upload`、`sandbox.warmup`。
- [ ] **Step 4:** `processStream` 的每個 part 交給 tracker，`send` 回傳的事件；`sanitizeSseFetch` 拿到的 gateway header 交給 tracker 的下一個 `finish-step`，同時 `setActiveSpanAttributes({ "aig.log_id", "aig.cache_status", "aig.ray" })`（此時的 active span 是 wrapAISDK 開的 chat span；拿不到就略過，不影響請求）。串流結束 / 錯誤 / 中止時 `tracker.end(...)`。
- [ ] **Step 5:** Tracing 屬性：根 span 開始後 `setActiveSpanAttributes({ "app.code_mode": <任一 delegated codeMode>, "app.experiment": experiment?.id ?? "none", "app.turn_index": turnIndex, "app.user_email": email ?? "unknown", "app.model": compatModelId, "app.tool_policy": JSON.stringify(policy) })`；歷史存檔包進 `runTracedTool(..., "history.save", ...)`。
- [ ] **Step 6:** 本地驗證：
  - `curl` 一般問題（不連 MCP）→ NDJSON 有 `run-start`、`span-start(kind invoke_agent)`、chat span 帶 `usage`、`run-end`；`preview_logs` 的 `Tools registered` 是核心工具
  - `curl` 帶 `mcpServers:["saas"]`（先在瀏覽器完成 OAuth）問「列出 Salesforce 前 5 個 Account」→ 出現 `ask_saas` tool span，其下有 `saas-agent` 的 `invoke_agent` span
- [ ] **Step 7:** `npx tsc --noEmit -p .`（只看本次檔案）與 `npx vitest run` → PASS；commit `feat(chat): harness-selected tools, MCP subagents and span events in /api/chat`。

### Task 8: 移除 App Code Mode

**Files:**
- Delete: `src/lib/codemode.ts`、`src/lib/codemode.test.ts`、`src/app/api/codemode-exec/route.ts`
- Modify: `wrangler.toml`（刪 `[[services]] SELF` 區塊與註解）、`src/lib/chat-tools.ts`（移除 `ToolSetConfig` 簽章用途中只為 Code Mode 存在的部分）

- [ ] **Step 1:** 刪檔，`grep -rn "codemode-exec\|signCodeModeSession\|buildCodeModeModule\|SELF" src wrangler.toml` 無結果（`LOADER` 保留）。
- [ ] **Step 2:** `npx tsc --noEmit -p .`、`npx vitest run`、`npm run build` → 成功；commit `chore(chat): remove app-side Code Mode`。

### Task 9: 前端 span 狀態與摘要

**Files:**
- Modify: `src/lib/chat-turn.ts`（`TurnState` 加 `trace: RunTrace | null`；`applyChatEvent` 把 span 系列事件交給 `reduceTrace`；帶 `spanId` 的 text/reasoning delta 不進答案）
- Create: `src/lib/trace-summary.ts`
- Test: `src/lib/chat-turn.test.ts`、`src/lib/trace-summary.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TraceSummary { totalMs: number; ttftMs: number | null; modelCalls: number; toolCalls: number; subagents: number; inputTokens: number; outputTokens: number }
  export function summarizeTrace(trace: RunTrace): TraceSummary; // 主 + subagent 加總
  export function formatSummary(s: TraceSummary, lang: "zh-TW" | "en"): string;
  ```
  - `formatSummary` zh-TW 範例：`共 8.4 秒 · 首字 1.2 秒 · 3 次模型呼叫 · 2 個工具 · 輸入 5,923 / 輸出 512 tokens`

- [ ] **Step 1:** 失敗測試：
  - 帶 `spanId` 的 `text-delta` 不改變 `content` / `parts`
  - span 事件建立 `trace`，`summarizeTrace` 計數與 tokens 正確（含 subagent chat span）
  - `formatSummary` 輸出上面的範例字串（給定對應數字）
  - 沒有任何 span 事件的舊紀錄 → `trace === null`（Review Focus 5）
- [ ] **Step 2:** FAIL → **Step 3:** 實作 → **Step 4:** PASS；commit `feat(chat): span tree and trace summary in the turn reducer`。

### Task 10: 聊天頁 UI

**Files:**
- Create: `src/app/components/trace/trace-waterfall.tsx`（從 `src/app/components/agents/trace-panel.tsx` 的 `Waterfall` 抽出，兩邊共用）
- Modify: `src/app/components/agents/trace-panel.tsx`（改用共用元件）
- Modify: `src/app/components/chat/process-timeline.tsx`（有 `trace` 時：摘要用 `formatSummary`，展開顯示 `TraceWaterfall`；沒有時維持現狀）
- Modify: `src/app/pages/chat.tsx`（移除「工具」「Code Mode」按鈕與 `toolsEnabled*` / `codeModeEnabled*` state / ref；工具卡片標題加耗時；subagent 卡片）
- Modify: `src/app/components/chat/suggestion-categories.tsx`（移除 `opts.tools`、`opts.codeMode`；移除 App / Portal Code Mode 卡片）
- Modify: `src/i18n/zh-TW.json`、`src/i18n/en.json`

**Interfaces:**
- Consumes: `TurnState.trace`、`summarizeTrace` / `formatSummary`（Task 9）、`waterfallRows`（trace-tree）。
- Produces: `<TraceWaterfall trace={RunTrace} now={number} onSelect?={(spanId: string) => void} />`。

- [ ] **Step 1:** 抽 `TraceWaterfall`，Agents 頁面行為不變（`npx vitest run src/app/components/agents` PASS）。
- [ ] **Step 2:** 聊天頁改動如上；subagent 卡片顯示：名稱（`SAP & Salesforce subagent`）、Code Mode 標籤、串流中的工具晶片與文字尾巴、結束後的 tokens / 時間。
- [ ] **Step 3:** 本地瀏覽器驗證：工具列只剩「模型 / MCP」；一般問題的摘要列與 waterfall；連 `saas` 後的 CRM 問題出現 subagent 卡片；手機寬度不破版。截圖存證。
- [ ] **Step 4:** commit `feat(chat): per-step calls, tokens and timing in the chat UI; drop manual toggles`。

### Task 11: Code Mode 對照範例

**Files:**
- Create: `src/lib/experiment-compare.ts`
- Test: `src/lib/experiment-compare.test.ts`
- Modify: `src/app/components/chat/suggestion-categories.tsx`（「Code Mode 示範」類別只放一張對照卡）、`src/app/pages/chat.tsx`（依序送兩輪、顯示對照表）、i18n

**Interfaces:**
- Consumes: `summarizeTrace`（Task 9）。
- Produces:
  ```ts
  export interface CompareRow { key: "inputTokens" | "outputTokens" | "modelCalls" | "toolCalls" | "totalMs" | "ttftMs"; off: number | null; on: number | null; deltaPct: number | null }
  export function compareRuns(off: TraceSummary | null, on: TraceSummary | null): CompareRow[];
  ```
  - `deltaPct = (on - off) / off * 100`，四捨五入到整數；任一邊為 `null` 或 `off === 0` 時為 `null`。

- [ ] **Step 1:** 失敗測試：
  - `compareRuns({inputTokens: 10000,...}, {inputTokens: 2500,...})` 的 `inputTokens.deltaPct === -75`
  - `off` 為 `null`（第一輪失敗）→ 每列 `off: null, deltaPct: null`
  - 回傳列的順序與 `key` 恰為上面 6 個
- [ ] **Step 2:** FAIL → **Step 3:** 實作 `compareRuns`；聊天頁：點卡片時若 `saas` 未連線 → 設 `mcpConnectHint("saas")`、開 MCP 面板、不送出（Review Focus 1）；已連線 → 開新對話，送 `experiment: { id: "sf-agg", codeMode: false }`，完成後送同題 `codeMode: true`（第二次的 `messages` 只含這一題），兩輪都完成後在第二輪下方顯示對照表。
- [ ] **Step 4:** 本地驗證：點卡片 → 兩輪依序完成 → 對照表數字與兩輪摘要一致；AI Gateway 本地請求的 `cf-aig-metadata` 有 `test: "sf-agg"` 與正確的 `code_mode`（在 `preview_logs` 或 TurnRecord 的 `gatewayCalls` 檢查）。
- [ ] **Step 5:** PASS；commit `feat(chat): Code Mode on/off comparison example`。

### Task 12: 歷史紀錄延伸

**Files:**
- Create: `migrations/chat-history/0002_code_mode.sql`（`ALTER TABLE turns ADD COLUMN code_mode INTEGER; ALTER TABLE turns ADD COLUMN experiment TEXT;`）
- Modify: `src/lib/chat-history.ts`（`saveTurn` 寫入 `code_mode`、`experiment`；`input_tokens` / `output_tokens` 改用主 + subagent 加總，來源為 `TurnRecord.events` 中所有 chat span 的 `usage`）
- Test: `src/lib/chat-history.test.ts`

- [ ] **Step 1:** 失敗測試：TurnRecorder 收到主 chat span（in 100 / out 10）與 subagent chat span（in 400 / out 40）→ 新函式 `turnUsage(record): { input: number; output: number }` 回 `{ input: 500, output: 50 }`。
- [ ] **Step 2:** FAIL → **Step 3:** 實作；本地 `wrangler d1 migrations apply cf-demo-chat-history --local -c wrangler.dev.toml`。
- [ ] **Step 4:** PASS；還原一個新對話確認 waterfall 存在、還原一個舊對話確認不崩潰；commit `feat(history): code_mode/experiment columns and subagent-inclusive usage`。
- [ ] **Step 5:** 告知使用者 production 需執行 `npx wrangler d1 migrations apply cf-demo-chat-history --remote`（建立資源可做，但要在 push 前跟使用者確認時機）。

### Task 13: 文件與總驗證

**Files:** Modify: `agents.md`（第 1、5、6、9 節：工具政策、單一 SAP & Salesforce、subagent、metadata、移除 App Code Mode、span 事件；刪掉 `saas-cm` 與「Code Mode 示範」舊說明）

- [ ] **Step 1:** 更新 `agents.md`。
- [ ] **Step 2:** `npx vitest run`、`npx tsc --noEmit -p .`（無新錯誤）、`npm run build` 全部成功。
- [ ] **Step 3:** 本地端到端走一次 spec「測試」節的四個情境並截圖。
- [ ] **Step 4:** commit `docs: harness tools, MCP subagents and observability`；不 push，等使用者決定。
