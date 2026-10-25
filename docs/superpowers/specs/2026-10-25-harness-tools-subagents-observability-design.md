# 主聊天：Harness 決定工具、MCP Subagent、執行細節與完整 Tracing 設計

日期：2026-10-25
前置：`2026-10-25-main-chat-tracing-history-design.md`（tracing + 對話歷史，已上線）

## 目標

1. **不再讓使用者手動開關**：拿掉聊天工具列的「工具」與「Code Mode」按鈕。工具清單由 Harness 決定，要不要呼叫由模型決定，Code Mode 是開發者的架構設定。
2. **MCP 只留一個 SAP & Salesforce**（合併 `saas` / `saas-cm`）。
3. **Code Mode 用一個對照範例比較**：同一題各跑一次「不開 / 開」，並排顯示 token、模型呼叫次數、工具呼叫次數與時間；AI Gateway metadata 可以 filter。
4. **提問過程看得到更多細節**：每一步的呼叫、token、時間。
5. **引入 subagent**：大型 MCP 由 subagent 在獨立 context 執行。
6. **所有資料都進 Agent Tracing**：模型呼叫、工具、subagent，以及目前不在 trace 裡的確定性步驟。

不做：Web Search（已移除）、長期記憶、讓使用者自選工具。

## 設計原則（來自 2026-10-25 研究）

- 工具清單由 Harness 決定，模型決定呼叫哪個（OpenAI `tool_choice: auto`、Anthropic、AI SDK 都是這個分工）。
- 每輪可用工具保持在約 10 個以內；超過就分流（Anthropic：10 個以上考慮 tool search，30–50 個以上選錯率明顯上升；OpenAI：軟性建議少於 20 個）。
- Code Mode 適合多步驟、互相依賴、要迴圈或過濾、細碎操作很多的 MCP；簡單單次呼叫用一般 tool calling（Cloudflare Code Mode 文件）。Portal Code Mode 是 Portal 管理員設定，客戶端只用 URL 選介面。

## 1. Harness 工具政策

`resolveToolPolicy()`（新檔 `src/lib/tool-policy.ts`，純函式，可測）依下列輸入決定這一輪的工具：模型能力、環境 binding、使用者已連線的 MCP server、附件 / 圖片。

| 規則 | 結果 |
|------|------|
| 模型不支援 tool calling（Perplexity、部分 Workers AI） | 不帶任何工具（沿用 `modelSupportsTools`） |
| 核心工具（一律常駐） | `searchKnowledge`、`readWebPage`、`captureScreenshot`、`executeJs`（有 `LOADER`）、`executeCode` / `createWebPreview`（有 sandbox） |
| 有貼圖 | 加 `searchKnowledgeByImage` |
| 已連線 MCP server，工具數 ≤ `MCP_DIRECT_MAX`（預設 8） | 工具直接給主模型（例：Cloudflare Docs） |
| 已連線 MCP server，工具數 > 8，或被設定為 `:agent` | 主模型只拿到一個委派工具 `ask_<server>`，由 subagent 執行該 server 的工具（見第 2 節） |

- 「工具」開關、`toolsEnabled` 請求欄位、`toolsEnabledRef` 補丁全部移除；範例卡片的 `opts.tools` 移除。
- Sandbox 預熱沿用 `SANDBOX_HINT` / 附件判斷（不再依賴工具開關）。
- 主模型每輪工具數目標 ≤ 10；實作第一步先量實際的工具定義 token 數（見「實作第 0 步」）。
- 本版不做 tool search；之後工具繼續變多時，`resolveToolPolicy` 是唯一要改的地方。

## 2. MCP Subagent

### 合併 MCP

- `MCP_SERVER_URLS` 只留 `saas=https://saasmcp.neokung.work/mcp:oauth:agent:codemode`（新增兩個旗標，見下）。移除 `saas-cm`、`mcp-client.ts` 的 `saas-cm` 條目、`mcp-panel.tsx` 的 logo 對應、`GATEWAY_ROUTED_MCP_SERVERS` 裡的 `saas-cm`。
- 旗標語法：`id=url[:oauth][:agent][:codemode]`。
  - `:agent`：這個 server 一律走 subagent（不論工具數）。
  - `:codemode`：開發者決定這個 server 用 **Portal Code Mode**。Harness 連線時改用 `url + ?codemode=search_and_execute`，subagent 只會看到 Portal 的 search / execute 工具，並套用既有的工具目錄注入（`portal-catalog.ts`）。
- OAuth token 以 server id 儲存（`mcp-token:{session}:saas`），兩種 URL 共用同一個 token。**需先實測**同一 token 能否連 `?codemode=` 版本（實作第 0 步）；不行就分開存 token、在面板上仍只顯示一張卡。

### Subagent 執行

- 重用 Agents Demo 的 `runSubagent()`（`src/lib/agents/runtime.ts`）：每個 subagent 有自己的 `invoke_agent` span、chat span、工具 span、idle 逾時與一次自動重試（R32）。
- 委派工具：`ask_<serverId>({ task: string })`，描述寫明這個 server 能做什麼（取 server 名稱 / 說明 + 工具名稱清單，不含完整 schema）。
- Subagent 的 system prompt：只用這個 server 的工具完成 `task`，回傳精簡結果（表格 / 數字 / ID），不要貼原始 JSON；被 Gateway 攔截（`blocked: true`）就照實回報、不重試。
- Subagent 的模型：**與主模型相同**（例如 Claude Haiku 5.5），經同一個 AI Gateway compat provider、帶同樣的 metadata。需要把 runtime 的模型解析從 `ModelKey`（Workers AI 清單）一般化成「由 RunContext 提供 `languageModel(key)`」，Agents Demo 行為不變。
- 主模型看到的是 subagent 的精簡結果，大量 CRM 資料留在 subagent 的 context 裡（這也是 token 對照的重點之一）。
- `maxSteps`：subagent 8（Code Mode 時多半 2–3 步就完成），主模型 8（現狀）。

## 3. Code Mode 對照範例

- 首頁「Code Mode 示範」類別改成一張卡片：**「Code Mode 對照：跨物件彙總」**（題目沿用現有 `codeModeSuggestions.agg`：列出 Salesforce 前 5 個 Account，再分別查出每個 Account 的商機數量與總金額）。
- 點擊後前端依序送兩次同一題（同一個新對話，前一輪結果不帶進下一輪的 messages），請求帶 `experiment: { id: "sf-agg", codeMode: false }`，再帶 `codeMode: true`。
  - `experiment.codeMode` 只用來**覆蓋**這一輪 `saas` 的 `:codemode` 設定，是唯一一個「由請求決定 Code Mode」的入口，而且只給這張卡片用。
- 兩輪都完成後，在第二輪下方顯示對照表：

| | 不開 Code Mode | 開 Code Mode | 差異 |
|---|---|---|---|
| 輸入 tokens（主 + subagent） | | | |
| 輸出 tokens | | | |
| 模型呼叫次數 | | | |
| 工具呼叫次數 | | | |
| 總時間 / 首字時間 | | | |

- 舊的 App Code Mode（`codemode` 包裝工具、`src/lib/codemode.ts`、`/api/codemode-exec`、`SELF` service binding、App Code Mode 範例卡）整套移除。`LOADER` 保留給 `executeJs`。
- 首頁其他 Code Mode 卡片（App / Portal 各 2–3 張）移除。

## 4. AI Gateway metadata（最多 5 個）

`cf-aig-metadata` 改為：

| key | 值 |
|-----|-----|
| `email` | 驗證過的 email（沒有時用 `unknown`） |
| `usertier` | `VIP` / `regular`（沿用） |
| `department` | `技術` / `業務`（沿用） |
| `code_mode` | 這一輪的模式（`turnCodeMode`：有委派 server 用 Code Mode 就是 `true`），主模型與 subagent 的每個請求都標同一個值，用 `code_mode` 篩選時同一輪不會被拆開（2026-10-25 實測後由「主模型一律 false」改為此規則） |
| `test` | 實驗 ID（例如 `sf-agg`），一般聊天為 `none` |

- 拿掉 `name`、`tools_enabled`。
- Subagent 的模型請求一樣帶這 5 個 key。區分「主 / subagent」靠 tracing（見第 6 節），不佔 metadata 名額。
- Dashboard filter 範例：`test = sf-agg` 且 `code_mode = true`。

## 5. 提問過程的細節呈現

### 伺服器事件

`/api/chat` 的 NDJSON 在現有事件之外，加上 Agents Demo 的 span 協定（`src/lib/agents/trace-events.ts` 的 `span-start` / `span-input` / `span-end`）：

- 根 span：`invoke_agent main-chat`（整輪）。
- 每次模型呼叫一個 `chat` span，`span-end` 帶 `usage {input, output}`（另加 `reasoning`、`cachedInput` 若 provider 有回）、`ttftMs`、`detail.finishReason`、`detail.gateway`（`cf-aig-log-id`、`cf-ray`、快取狀態、routed model）。
- 每個工具呼叫一個 `execute_tool` span（工具開始寫參數時就開），`span-end` 帶耗時、結果大小、`blocked`。
- Subagent：`invoke_agent saas-agent`，底下有它自己的 chat / tool span。Subagent 的文字 / 推理 delta 帶 `spanId`；前端的答案 reducer（`applyChatEvent`）忽略帶 `spanId` 的 delta，只把它們顯示在 subagent 卡片裡。
- 確定性步驟也是 `execute_tool` span（`runTracedTool`）：MCP 連線與工具清單（含 KV 快取命中）、Portal 工具目錄、附件上傳 sandbox、sandbox 預熱、歷史存檔。

### 前端

- 每則 assistant 訊息下方的「處理過程」（現有 `ProcessTimeline`）改由 span 樹驅動（重用 `reduceTrace`），一行摘要：
  `共 8.4 s · 首字 1.2 s · 3 次模型呼叫 · 2 個工具 · 輸入 5,923 / 輸出 512 tokens`
- 展開後是 waterfall（重用 `waterfallRows`，從 `trace-panel.tsx` 抽出共用的 `TraceWaterfall` 元件）：每一列顯示名稱、耗時條、tokens、狀態；點選一列看細節（工具參數 / 結果摘要、模型 finish reason、Gateway log ID 連結到 AI Gateway Logs）。
- Subagent 卡片：串流中顯示它正在呼叫的工具與思考 / 文字尾巴（重用 `activity-timeline` 的 subagent 卡片樣式），結束後顯示它自己的 tokens / 時間。
- 工具卡片標題加上耗時，例如「Salesforce 查詢 · 1.8 s」。
- 費用：本版只顯示 tokens 和時間。AI Gateway 不在回應 header 回傳費用，要從 Logs API 用 `cf-aig-log-id` 事後查詢，列為後續選項（見「待確認」）。

### 歷史

- `TurnRecorder` 已經記錄每個 NDJSON 事件，span 事件會自動進 R2 的 `TurnRecord.events`；還原時用同一個 reducer 重建 span 樹，所以舊對話也看得到 waterfall。
- D1 `turns` 的 `input_tokens` / `output_tokens` 改為主 + subagent 的總和。另加 `code_mode`、`experiment` 欄位（新 migration `0002`），方便在 D1 直接比較。

## 6. Agent Tracing（全部資料）

- 主模型與 subagent 都走 `getTracedAI({ storeContent: true })`：訊息、推理、工具參數與結果都記錄（現狀，延伸到 subagent）。
- Agent 身分：主聊天 `gen_ai.agent.name = main-chat`；subagent `saas-agent`（`functionId`），`gen_ai.conversation.id` 都是同一個對話 ID，Dashboard 同一個 session 會看到主 agent 與 subagent。
- 自訂 span 與屬性（`withToolSpan` / `setActiveSpanAttributes`）：
  - 根 span：`app.code_mode`、`app.experiment`、`app.turn_index`、`app.user_email`、`app.model`、`app.routed_model`、`app.tool_policy`（這一輪實際給了哪些工具，JSON）。
  - Chat span：`aig.log_id`、`aig.cache_status`、`aig.ray`。
  - 確定性步驟：第 5 節列的每一個，含 `cache.hit`、耗時、結果大小。
- 限制照官方文件：span 有大小上限，長內容會截斷，trace 保留 7 天；完整紀錄仍以 R2 的 `TurnRecord` 為準。

## 資料流

```
瀏覽器 ── POST /api/chat {messages, model, conversationId, turnIndex, mcpServers, experiment?}
  │
  ▼
resolveToolPolicy ──► 核心工具 + 小型 MCP 直接工具 + ask_saas（委派）
  │
  ▼
main-chat streamText（traced）── tool: ask_saas ──► runSubagent(saas-agent)
  │                                                   └─ streamText（traced）── Portal 工具 / Code Mode search+execute
  ▼
NDJSON：現有事件 + span 事件 ──► 前端答案 reducer / span 樹 / 對照表
  │
  └─► TurnRecorder ──► R2 TurnRecord + D1 turns（含 code_mode / experiment）
```

## 錯誤處理

- Subagent 失敗：重試一次（runtime 既有行為）；仍失敗就把錯誤當委派工具的結果回給主模型，主模型照實告訴使用者。
- `?codemode=` 連線失敗：subagent 回報錯誤，不自動退回一般模式（避免對照實驗混入另一種模式）；一般聊天下可退回並在 span 屬性記 `app.codemode_fallback = true`。
- Gateway 攔截（`blocked: true`）：subagent 與主模型都不重試、不繞過（沿用 system prompt 規則）。
- 對照實驗中第一輪失敗：仍跑第二輪，對照表標示失敗的那一欄。

## 測試

- `tool-policy.test.ts`：模型能力、binding、MCP 工具數門檻、`:agent` / `:codemode` 旗標、實驗覆蓋。
- `mcp-client` 旗標解析測試（`id=url:oauth:agent:codemode`）。
- Runtime 一般化後，Agents Demo 現有測試全過（runtime / order / speed 測試）。
- 前端：`applyChatEvent` 忽略帶 `spanId` 的 delta；span 樹 → 摘要文字；對照表計算（純函式）。
- 本地端到端：一般聊天（無工具 / 核心工具）、連 SAP & Salesforce 後問 CRM 問題（subagent 卡片、waterfall）、對照範例（兩輪 + 對照表）、還原歷史後 waterfall 仍在。
- Production：部署後在 AI Gateway Logs 用 `test = sf-agg` filter，在 Agents 分頁看到 `main-chat` 與 `saas-agent` 同 session。

## 實作第 0 步（先實測再定細節）

1. 用 OAuth 連上 `saas` 後量：工具數、全部工具定義的 token 數、`?codemode=` 版本能否沿用同一個 token。
2. 量核心工具定義的 token 數，確認主模型每輪的固定成本。
3. 確認 `CF_API_TOKEN` 有沒有 AI Gateway Logs 讀取權限（決定費用能不能顯示）。

## 實測結果（2026-10-25）

- 核心工具（6 個）的定義 JSON 約 1,994 字元（含中文描述，約 0.5–1.5k tokens），固定成本小。
- `CF_API_TOKEN` 呼叫 AI Gateway Logs API 回 200：之後可以用 `cf-aig-log-id` 查實際費用。
- `saas`（SAP & Salesforce Portal）有 46 個工具，定義約 19,000 字元（約 5k tokens）→ 走 subagent。
- `?codemode=search_and_execute` 可以沿用同一個 OAuth token（`mcp-token:{session}:saas`），不必分開存。
- 對照範例 `sf-agg` 首次實測（Claude Haiku 5.5，本地）：不開 Code Mode 輸入 44,155 / 輸出 2,545 tokens、8 個工具、23.4 s；開 Code Mode 輸入 25,725 / 輸出 2,352 tokens、3 個工具、24.8 s（輸入 −42%、工具呼叫 −62%、時間 +6%）。

## 待確認（請在 review 時決定）

1. **小型 MCP 門檻**：`MCP_DIRECT_MAX = 8`，超過就走 subagent。Radar、Workers Observability 工具數待實測，可能也會變成 subagent。
2. **費用顯示**：要不要在對照表與處理過程加上「實際費用」（事後用 Logs API 查，約晚 1–3 秒出現）。
3. **對照範例只有一題**：之後要加題目，只要在範例清單加一筆 `experiment.id`。

## 風險

- Runtime 一般化影響 Agents Demo：靠既有測試把關，改動只在模型解析。
- `ask_saas` 多一層模型呼叫，簡單 CRM 問題會比直接給工具慢（多一次 subagent 首字時間）；這也是對照時要一起看的數字。
- 同一個 OAuth token 能否用於 `?codemode=` URL 尚未確認（第 0 步）。
- span 事件讓 NDJSON 變大；delta 仍照現狀即時送，span 事件數量與工具數成正比，影響有限。
