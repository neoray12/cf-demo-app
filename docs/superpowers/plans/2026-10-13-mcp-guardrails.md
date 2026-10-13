# MCP 卡控 Demo 與聊天處理過程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 cf-demo-app 加入 MCP 卡控 demo（首頁可展開類別 + `/mcp-guardrails` 說明頁 + 聊天中的 Gateway 攔截卡片），並修正「思考中」計時器、改成處理過程時間軸。

**Architecture:** 純邏輯（錯誤分類、場景資料、時間軸建構）放在 `src/lib/` 的小模組並以 vitest 單元測試；`/api/chat` 只改事件轉送；UI 拆出 `suggestion-categories.tsx`、`process-timeline.tsx`，`chat.tsx` 只負責接線。Gateway 規則與 DLP profile 已在帳號建立好（見 spec），本計畫不呼叫任何 Cloudflare 管理 API。

**Tech Stack:** Next.js（OpenNext on Workers）、React 19、Tailwind 4、shadcn、react-i18next、Vercel AI SDK `ai`、`@modelcontextprotocol/sdk` 1.29、vitest 3。

**Spec:** `docs/superpowers/specs/2026-10-13-mcp-guardrails-design.md`

## Global Constraints

- 繁體中文為主，所有新 UI 文字都要同時加到 `src/i18n/zh-TW.json` 與 `src/i18n/en.json`。
- 不要 `git push`、不要 `wrangler deploy` / `npm run deploy`；每個 task 只做本地 commit，commit message 結尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 不要 commit `tsconfig.tsbuildinfo`，也不要動工作區裡尚未 commit 的 MCP prompts 相關改動（`src/app/api/mcp/prompts/`、`prompt-picker.tsx`、`use-mcp-prompt-picker.ts`、`mcp-client.ts` 的 prompts 函式、`chat.tsx` 的 prompt picker 接線、i18n 的 `chat.prompts`）。`git add` 一律指定檔案；碰到同一檔案時用 `git add -p` 只加自己的 hunk。
- Gateway 規則 ID（照抄）：場景 1 `4c6f7183-708e-4fb8-abc3-3f3e18f75eaf`、2 `e50d7a14-ae32-4b57-9911-ad63394a6c7f`、3 `5e050c10-4b80-4352-b691-79f36730d759`、4 `0b3b9c32-c2dd-4318-8467-9388df53dfee`。
- Gateway 擋下 request：`McpError.code === -30403`，`data = { rule_id, request_id }`。擋下 response：`McpError.code === -32603`，沒有 rule ID，只在經 Gateway 的 Portal server（`saas`）上才解讀為「可能被攔截」。
- 模型收到的攔截訊息（照抄）：`此工具呼叫被組織的資安政策（Cloudflare Gateway）攔截。不要重試，也不要改用其他工具繞過；請告知使用者被攔截的動作。`
- 場景 2 的 demo 商機：`006hg000001fNCzAAM`，名稱「MCP Demo 商機 (Spike)」。
- 完成後在本地 `npm run dev` 驗證才能 commit 最後一個 task。

## Review Focus

1. **`saas` 沒連線時點 MCP 範例**：不能送出一個沒有 Salesforce 工具的請求（模型會亂答），應打開 MCP 面板並提示。→ Task 6 Step 4 的手動驗證（專案沒有 DOM 測試環境，不為此新增）。
2. **非 Gateway 的 `-32603`**（例如 `cf-docs` 真的內部錯誤）不能被誤標成「被攔截」。→ Task 1 的測試 `does not mark -32603 from non-gateway servers as blocked`。
3. **舊訊息 / 沒有 timeline 的訊息**（重新整理後、錯誤訊息）不能讓時間軸元件崩潰。→ Task 4 的測試 `returns only a waiting step for empty events`、Task 5 的 null guard。
4. **使用者中途按停止**：時間軸中進行中的步驟要結束在停止時間，不能永遠轉圈。→ Task 4 的測試 `closes open steps at end time`。
5. **`?prompt=` 重新整理重複帶入**：讀取後要清掉 URL 參數。→ Task 6 Step 5 的手動驗證。

---

### Task 1: 單元測試設定、場景資料與 MCP 錯誤分類

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`（scripts 加 `"test": "vitest run"`）
- Create: `src/lib/mcp-guardrails.ts`
- Test: `src/lib/mcp-guardrails.test.ts`

（spec 寫的場景檔位置 `src/app/pages/mcp-guardrails-scenarios.ts` 改為 `src/lib/mcp-guardrails.ts`，因為 server 端的 `chat-tools.ts` 也要用 rule ID 對照表。）

**Interfaces:**
- Produces:
  - `type GuardrailLevel = "tool" | "action" | "parameter" | "response"`
  - `interface GuardrailScenario { id: 1|2|3|4; level: GuardrailLevel; ruleId: string; titleKey: string; descKey: string; policy: { selector: string; operator: string; value: string }[]; action: "Block"; phase: "upload" | "download"; allowPromptKey: string; blockPromptKey: string; resetPromptKey?: string }`
  - `const GUARDRAIL_SCENARIOS: GuardrailScenario[]`
  - `const GATEWAY_ROUTED_MCP_SERVERS: ReadonlySet<string>`（內容 `["saas"]`）
  - `function gatewayRuleUrl(ruleId: string): string` → `https://one.dash.cloudflare.com/5efa272dc28e4e3933324c44165b6dbe/traffic-policies/firewall-policies/http/edit/${ruleId}`
  - `interface GatewayBlock { blocked: true; direction: "request" | "response"; ruleId?: string; requestId?: string; scenarioId?: number; message: string }`
  - `function classifyMcpError(err: unknown, serverId: string): GatewayBlock | null`
  - `const GATEWAY_BLOCK_MESSAGE: string`（Global Constraints 的那句）

- [ ] **Step 1: 建 `vitest.config.ts`**：`include: ['src/**/*.test.ts']`，`environment: 'node'`，`resolve.alias` 把 `@` 指到 `./src`。`package.json` 加 `"test": "vitest run"`。

- [ ] **Step 2: Write the failing tests** in `src/lib/mcp-guardrails.test.ts`

```ts
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { classifyMcpError, GUARDRAIL_SCENARIOS, GATEWAY_BLOCK_MESSAGE } from './mcp-guardrails';

it('classifies -30403 as a request block with rule and scenario', () => {
  const err = new McpError(-30403, 'Request blocked | rule_id: e50d7a14-ae32-4b57-9911-ad63394a6c7f | request_id: 31d48cba9800039ade18958400000001',
    { rule_id: 'e50d7a14-ae32-4b57-9911-ad63394a6c7f', request_id: '31d48cba9800039ade18958400000001' });
  expect(classifyMcpError(err, 'saas')).toEqual({ blocked: true, direction: 'request',
    ruleId: 'e50d7a14-ae32-4b57-9911-ad63394a6c7f', requestId: '31d48cba9800039ade18958400000001',
    scenarioId: 2, message: GATEWAY_BLOCK_MESSAGE });
});
it('parses rule_id from the message when data is missing', () => { /* new McpError(-30403, '... rule_id: 4c6f… | request_id: x') → ruleId '4c6f7183-708e-4fb8-abc3-3f3e18f75eaf', scenarioId 1 */ });
it('classifies -32603 from a gateway-routed server as a response block', () => {
  expect(classifyMcpError(new McpError(-32603, 'Internal Error'), 'saas'))
    .toEqual({ blocked: true, direction: 'response', message: GATEWAY_BLOCK_MESSAGE });
});
it('does not mark -32603 from non-gateway servers as blocked', () => {
  expect(classifyMcpError(new McpError(-32603, 'Internal Error'), 'cf-docs')).toBeNull();
});
it('ignores ordinary errors', () => { expect(classifyMcpError(new Error('fetch failed'), 'saas')).toBeNull(); });
it('scenario regexes match spike request bodies', () => {
  // 以 JS RegExp 近似 DLP regex（把 (?i) 換成 i flag）
  // 1 擋：'{"name":"sf_create_lead"' ；放：'{"name":"sf_list_accounts"'
  // 2 擋：'"stage":"Closed Won"' ；放：'"stage":"Negotiation/Review"'
  // 3 擋：'select name, email from contact limit 3'、'(SELECT Email FROM Contacts)'；放：'SELECT Name FROM Account LIMIT 5'
});
```

場景 regex 測試需要在 `GuardrailScenario` 上放 `dlpRegex: string`（原樣存 spec 的 Rust regex），測試裡把開頭的 `(?i)` 去掉並改用 `i` flag。場景 4 不測（是 email）。

- [ ] **Step 3: Run** `npx vitest run src/lib/mcp-guardrails.test.ts` → FAIL（module not found）

- [ ] **Step 4: Implement `src/lib/mcp-guardrails.ts`**：用 `instanceof McpError` 判斷；`-30403` 時 rule ID 先取 `data.rule_id`，沒有就從 message 以 `/rule_id:\s*([0-9a-f-]{36})/` 解析；`scenarioId` 由 `GUARDRAIL_SCENARIOS` 依 `ruleId` 對照。四個場景的 `policy` 列依 spec「場景與已建立的資源」表：`Host in salesforce-mcp.neokung.work`、`DLP Profile in MCP Demo: …`、`Body Phase is upload/download`。i18n key 前綴 `guardrails.s{n}.*`（文字在 Task 7 加）。

- [ ] **Step 5: Run** `npm test` → PASS（6 tests）

- [ ] **Step 6: Commit** `git add vitest.config.ts package.json src/lib/mcp-guardrails.ts src/lib/mcp-guardrails.test.ts` → `git commit -m "feat: guardrail scenarios and MCP gateway-block classification"`

---

### Task 2: 工具被攔截時回傳 blocked 結果、system prompt 加規則

**Files:**
- Modify: `src/lib/chat-tools.ts:409-503`（`buildMcpTools` 的 execute catch）
- Modify: `src/lib/mcp-client.ts:153-191`（`callMcpTool` 在 finally 關閉 client）
- Modify: `src/app/api/chat/route.ts:12`（`SYSTEM_PROMPT` 末尾加一句）

**Interfaces:**
- Consumes: `classifyMcpError(err, serverId)`、`GatewayBlock`（Task 1）
- Produces: MCP 工具被擋時的 tool result 形狀：`GatewayBlock & { source: string; tool: string }`（`source` = server 名稱，`tool` = MCP 原始工具名稱）。前端 Task 5 依 `result.blocked === true` 判斷。

- [ ] **Step 1: `callMcpTool`**：把 `callTool` + `close` 包成 `try { … } finally { await client.close().catch(() => {}) }`，錯誤照樣拋出（目前拋錯時 client 不會關）。
- [ ] **Step 2: `buildMcpTools` 的 catch**：先 `const block = classifyMcpError(err, serverId)`；有值就 `return { ...block, source: server.name, tool: tool.name }`，並 `console.warn('[Chat API] MCP tool blocked by Gateway', { toolKey, ruleId: block.ruleId, direction: block.direction })`；沒有值才維持原本的 `{ error: … }`。
- [ ] **Step 3: `SYSTEM_PROMPT`** 末尾加：`\n\n如果工具結果含有 "blocked": true，代表該動作被組織的資安政策攔截：不要重試、不要改用其他工具繞過，直接告訴使用者哪個動作被攔截。`
- [ ] **Step 4: Verify** `npx tsc --noEmit` 無新錯誤；`npm test` PASS。
- [ ] **Step 5: Commit** `feat: surface Gateway-blocked MCP calls as structured tool results`

---

### Task 3: 轉送 tool-error、略過空 delta

**Files:**
- Modify: `src/app/api/chat/route.ts:466-470`（`processTextDelta` 空字串直接 return）、`:536-560`（主串流 switch）
- Modify: `src/app/pages/chat.tsx:26-33`（`ToolCallInfo.status` 加 `"error"`，新增 `error?: string`）、`:1310-1314`（`appendPart` 略過空字串）、`:1341-1395`（事件 switch 加 `tool-error`）

**Interfaces:**
- Produces: NDJSON 事件 `{ type: "tool-error", toolCallId: string, toolName: string, error: string }`；`ToolCallInfo = { id; name; args?; result?; status: "calling" | "done" | "error"; error?: string }`。

- [ ] **Step 1: 後端**：主串流 switch 加 `case 'tool-error': send(controller, { type: 'tool-error', toolCallId: part.toolCallId, toolName: part.toolName, error: String((part.error as Error)?.message ?? part.error) })`；`reasoning-delta` 只在 `part.text` 非空時送出；`processTextDelta` 開頭 `if (!raw) return;`。smart-retry 串流沒有工具，只需同樣略過空 delta。
- [ ] **Step 2: 前端**：`appendPart` 開頭 `if (!text) return;`；新增 `case "tool-error"`：`ensureTool(...)`，把該工具設成 `status: "error", error: event.error`。
- [ ] **Step 3: 前端「已結束」判斷**：凡是 `status === "done"` 的判斷（`awaitingModel`、`SourcesDisplay` 除外）改用 `status !== "calling"`；`ToolCallDisplay` 在 `status === "error"` 時用 destructive 樣式顯示 `t("chat.tool.failed")` 與錯誤訊息。
- [ ] **Step 4: Verify** `npx tsc --noEmit`；`npm run dev`，暫時讓模型呼叫一個參數不合法的工具（例如在聊天輸入「用 sf_get_account 查 id 為空字串的帳戶」）確認工具顯示失敗、不再轉圈。
- [ ] **Step 5: Commit** `fix: forward tool-error events and drop empty stream deltas`

---

### Task 4: 時間軸建構函式（純邏輯）

**Files:**
- Create: `src/lib/chat-timeline.ts`
- Test: `src/lib/chat-timeline.test.ts`

**Interfaces:**
- Produces:
  - `type TimelineEvent = { t: number; kind: "text" | "reasoning" } | { t: number; kind: "tool-start"; id: string; name: string } | { t: number; kind: "tool-end"; id: string; outcome: "done" | "error" | "blocked" }`（`t` 為相對送出時間的毫秒）
  - `type TimelineStepKind = "waiting" | "reasoning" | "tool" | "composing" | "writing"`
  - `interface TimelineStep { kind: TimelineStepKind; start: number; end: number | null; toolId?: string; toolName?: string; outcome?: "done" | "error" | "blocked" }`
  - `function buildTimeline(events: TimelineEvent[], endAt: number | null): TimelineStep[]`（`endAt` 為 null 代表仍在串流，最後一步 `end` 為 null）

規則（依 spec B2 表）：送出到第一個事件為 `waiting`；連續的 reasoning 事件合併成一個 `reasoning`；`tool-start`→對應 `tool-end` 為一個 `tool`（並行工具各自一段，彼此重疊）；所有工具都結束後到下一個事件之間為 `composing`；連續 text 合併為 `writing`。`endAt` 不為 null 時，所有 `end === null` 的步驟收在 `endAt`。

- [ ] **Step 1: Write the failing tests**

```ts
it('returns only a waiting step for empty events', () => { expect(buildTimeline([], null)).toEqual([{ kind: 'waiting', start: 0, end: null }]); expect(buildTimeline([], 500)).toEqual([{ kind: 'waiting', start: 0, end: 500 }]); });
it('waiting → reasoning → writing', () => { /* events: reasoning@3000, reasoning@3500, text@5000, text@5200; endAt 6000 → [waiting 0-3000, reasoning 3000-5000, writing 5000-6000] */ });
it('tool then composing then writing', () => { /* text@1000, tool-start a@1500, tool-end a@3800 done, text@6000; endAt 7000 → [waiting 0-1000, writing 1000-1500, tool a 1500-3800 done, composing 3800-6000, writing 6000-7000] */ });
it('parallel tools: composing starts only after the last tool ends', () => { /* tool-start a@1000, tool-start b@1100, tool-end b@2000, tool-end a@3000 → composing starts at 3000 */ });
it('marks blocked and error outcomes', () => { /* tool-end outcome 'blocked' / 'error' carried onto the step */ });
it('closes open steps at end time', () => { /* tool-start a@1000, no end, endAt 4000 → tool a end 4000, outcome undefined */ });
```

- [ ] **Step 2: Run** `npx vitest run src/lib/chat-timeline.test.ts` → FAIL
- [ ] **Step 3: Implement `buildTimeline`**（單次掃描，記錄「進行中工具」集合與「目前非工具步驟」）
- [ ] **Step 4: Run** `npm test` → PASS
- [ ] **Step 5: Commit** `feat: build per-turn processing timeline from stream events`

---

### Task 5: 時間軸 UI 與攔截卡片

**Files:**
- Create: `src/app/components/chat/process-timeline.tsx`
- Create: `src/app/components/chat/gateway-block-card.tsx`
- Modify: `src/app/pages/chat.tsx`（`ChatMessage` 加 `timeline?: { events: TimelineEvent[]; endAt: number | null }`；串流迴圈記事件；`AssistantMessage` 用 `ProcessTimeline` 取代 `awaitingModel` 圓點區塊 `:928-935`；`ToolCallDisplay` 在 `result?.blocked === true` 時改畫 `GatewayBlockCard`）
- Modify: `src/i18n/zh-TW.json`、`src/i18n/en.json`（`chat.timeline.*`、`chat.gatewayBlock.*`、`chat.tool.failed`）

**Interfaces:**
- Consumes: `buildTimeline`, `TimelineEvent`（Task 4）；`GatewayBlock`、`GUARDRAIL_SCENARIOS`、`gatewayRuleUrl`（Task 1）；tool result 形狀（Task 2）
- Produces: `<ProcessTimeline timeline={...} streaming={boolean} toolLabel={(name: string) => string} />`、`<GatewayBlockCard block={GatewayBlock & { source: string; tool: string }} />`

- [ ] **Step 1: 串流迴圈記錄事件**：`doFetch` 開頭記 `const t0 = performance.now()`；收到 `reasoning-delta`、`text-delta`、`tool-call-start`（或 `ensureTool` 首次建立）、`tool-result`（`result?.blocked ? "blocked" : "done"`）、`tool-error` 時 push `TimelineEvent`；`flushUpdate` 一起寫入 `timeline: { events, endAt: null }`；`finally` 寫入 `endAt: performance.now() - t0`。同一種 delta 連續出現時只記第一筆（避免 events 暴增）。
- [ ] **Step 2: `ProcessTimeline`**：
  - 串流中（`endAt === null`）：每秒重算一次（沿用 `useElapsedSeconds` 的計時模式）；標題列「處理中… 共 {{s}} 秒」，下面一行列出步驟：已完成的顯示 ✓ 與耗時（秒，一位小數），進行中的顯示轉圈與目前秒數，🛡 / ✕ 標示 blocked / error。
  - 結束後：收合成一行「處理過程 · 共 {{s}} 秒 · {{n}} 個工具」，點擊展開完整列表；`timeline` 不存在時不渲染。
  - 步驟文字 key：`chat.timeline.waiting` 等待模型、`reasoning` 推理、`tool` 呼叫 {{name}}、`composing` 整理答案、`writing` 撰寫回覆。工具名稱用 `toolLabel`：MCP 工具顯示「{{serverLabel}} · {{toolName}}」（沿用 `parseMcpToolName`），其他工具用 `friendlyToolName`。
  - 移除 `AssistantMessage` 的 `awaitingModel` 圓點區塊與 `chat.thinking` 的使用（key 保留在 i18n 以免影響 prompt picker 的未 commit 改動）。
- [ ] **Step 3: `GatewayBlockCard`**：emerald/destructive 邊框卡片，🛡 標題「已被 Cloudflare Gateway 攔截」；`direction === "request"` 顯示「請求被擋下」+ 場景標題（`GUARDRAIL_SCENARIOS` 依 `scenarioId`）+ rule ID（連到 `gatewayRuleUrl`）+ request ID；`direction === "response"` 顯示「工具回應可能含敏感資料，被回應端 DLP 擋下（請到 Gateway log 確認）」。都顯示 `source · tool`。
- [ ] **Step 4: Verify** `npx tsc --noEmit`；`npm run dev` 送一般問題與一個工具問題（例如「精確計算」卡片），截圖串流中與結束後的時間軸；重新整理後舊訊息不報錯。
- [ ] **Step 5: Commit** `feat: show processing timeline and Gateway block card in chat`

---

### Task 6: 首頁可展開類別、MCP 卡控類別、`?prompt=` 帶入

**Files:**
- Create: `src/app/components/chat/suggestion-categories.tsx`
- Modify: `src/app/pages/chat.tsx:1662-1705`（各組 suggestions 陣列搬進新元件）、`:1825-1912`（首頁改渲染 `<SuggestionCategories />`）
- Modify: `src/i18n/zh-TW.json`、`src/i18n/en.json`（`chat.categories.*`、`chat.guardrailSuggestions.*`）

**Interfaces:**
- Consumes: `GUARDRAIL_SCENARIOS`（Task 1）
- Produces: `<SuggestionCategories onSend={(prompt: string, opts: { tools?: boolean; mcp?: string }) => void} />`

- [ ] **Step 1: `SuggestionCategories`**：
  - 類別依序：`basics`（原 `suggestions`）、`sandbox`、`dw`、`browser`、`safety`、`guardrails`；每個類別有 icon、`titleKey`、`descKey`、配色（sky / amber / violet / destructive / emerald；basics 用中性色）、`items`、`opts`（sandbox/dw/browser 為 `{ tools: true }`，guardrails 為 `{ tools: true, mcp: "saas" }`）。
  - 類別卡片排成 `grid-cols-2 sm:grid-cols-3`；點擊切換 `openId`（同一個再點一次收合；一次只開一個；預設 `null`）；開啟中的卡片有選取樣式與 `aria-expanded`。
  - 展開區塊在類別 grid 下方，沿用各組原本的範例卡片樣式。
  - `guardrails` 的範例：四個場景的 `blockPromptKey`，加場景 2 的 `resetPromptKey`，最後一張是「查看政策說明 →」（`router.push("/mcp-guardrails")`，不是 prompt）。
- [ ] **Step 2: `chat.tsx` 的 `onSend`**：`opts.tools` 時沿用 `handleSandboxSuggestion` 的 `toolsEnabledRef` 寫法；`opts.mcp` 且 `!connectedMcpServers.includes(opts.mcp)` 時不送出，改為 `setShowMcpPanel(true)` 並把 prompt 填進輸入框，在輸入框上方顯示 `chat.guardrailSuggestions.connectFirst`（「請先在 MCP 面板連線 SAP & Salesforce，再送出」）。
- [ ] **Step 3: `?prompt=` / `?mcp=`**：`ChatPage` mount 時讀 `useSearchParams()`；有 `prompt` 就 `setInput(prompt)`（不送出）、有 `mcp` 且未連線就 `setShowMcpPanel(true)`；讀完以 `router.replace("/")` 清掉參數。
- [ ] **Step 4: Verify** `npx tsc --noEmit`；`npm run dev`：首頁只顯示 6 張類別卡；點開 / 收合 / 切換正常；手機寬度（375）不水平捲動；`saas` 未連線時點 MCP 範例會打開面板且不送出；已連線時送出並實際呼叫 Salesforce 工具；開 `/?prompt=test&mcp=saas` 後輸入框有 `test`、網址變回 `/`，重新整理不再帶入。
- [ ] **Step 5: Commit** `feat: collapsible suggestion categories with MCP guardrails demos`

---

### Task 7: `/mcp-guardrails` 說明頁與側欄

**Files:**
- Create: `src/app/(dashboard)/mcp-guardrails/page.tsx`（同 `clef/page.tsx` 的寫法）
- Create: `src/app/pages/mcp-guardrails.tsx`
- Modify: `src/app/components/app-sidebar.tsx:381-391`（Clef 之後加一項，icon `ShieldCheck`）
- Modify: `src/i18n/zh-TW.json`、`src/i18n/en.json`（`sidebar.guardrails`、`guardrails.*`，含 Task 1 的 `guardrails.s{n}.*`）

**Interfaces:**
- Consumes: `GUARDRAIL_SCENARIOS`、`gatewayRuleUrl`（Task 1）

- [ ] **Step 1: 頁面**：
  - 頁首：標題「MCP 卡控」、一段說明（Portal → Gateway → DLP 的路徑），以及 demo 流程三步驟：先送擋下的 prompt（成功寫入）→ 在 Dashboard 開規則 → 約 15 秒後再送一次（被擋）。
  - 每個場景一張 shadcn `Card`：層級 badge（工具 / 動作 / 參數 / 回應）、標題、說明、政策表（Selector / Operator / Value / Action，regex 用等寬字）、「在 Dashboard 開啟規則」外部連結（`gatewayRuleUrl`）、放行與擋下兩個 prompt，各有「在聊天中試試」按鈕 → `router.push("/?prompt=" + encodeURIComponent(text) + "&mcp=saas")`。場景 2 另外顯示重設 prompt；場景 3 加一行「子查詢 FROM Contacts 曾經繞過，已調整 regex」；場景 4 加一行「需 upstream 回傳 JSON；SSE 串流不會被 DLP 掃描」。
- [ ] **Step 2: i18n 文字**：中英文都要；場景標題用 spec 的「工具層級：禁止寫入 CRM」等四個；prompt 照 spec 表格。
- [ ] **Step 3: Verify** `npx tsc --noEmit`；`npm run dev`：側欄出現「MCP 卡控」、頁面在桌機與 375px 正常、深色模式正常、「在聊天中試試」帶入正確 prompt、Dashboard 連結開到對應規則。
- [ ] **Step 4: Commit** `feat: MCP guardrails explainer page`

---

### Task 8: 端到端驗證與文件

**Files:**
- Modify: `agents.md`（功能需求加「### 7. MCP 卡控 Demo」：場景、rule ID、`-30403`/`-32603` 的意義、Salesforce worker 必須 `enableJsonResponse`、DLP regex 限制）

- [ ] **Step 1: 規則全關**：在本地 `npm run dev` 連線 `saas`，依序送四個場景的擋下 prompt，確認都成功（實際寫入 / 讀取 Salesforce），時間軸正常。
- [ ] **Step 2: 請使用者在 Dashboard 逐一開啟規則**（本計畫不代為開關），每開一條等約 15 秒後重送同一個 prompt，確認出現 `GatewayBlockCard`、模型沒有重試或改用其他工具、時間軸該步驟標 🛡；確認放行 prompt 仍成功。截圖四張攔截卡片。
- [ ] **Step 3: 請使用者把規則關回**，並把場景 2 的商機用重設 prompt 改回 Prospecting。
- [ ] **Step 4: Run** `npm test` → 全部 PASS；`npx tsc --noEmit` 無新錯誤。
- [ ] **Step 5: 更新 `agents.md`，Commit** `docs: record MCP guardrails demo in agents.md`
