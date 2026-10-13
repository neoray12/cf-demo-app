# MCP 卡控（MCP Guardrails）Demo — 設計

日期：2026-10-13
狀態：設計已口頭同意，待 spike 驗證後撰寫實作計畫

## 目標

讓客戶在 cf-demo-app 裡親眼看到：Cloudflare Gateway + DLP 能對 MCP 做**工具 / 動作 / 參數 / 回應資料**四個層級的卡控，而不只是整台 server 的開與關。

成功條件：

- 每個場景都有一個範例 prompt，**沒開規則時會真的寫入或讀取 Salesforce dev org**；開了規則後同一個 prompt 被擋下。
- 簡報者在 App 內就能開關規則、帶入 prompt、看到「被 Gateway 攔截」的結果，不需要切到 Dashboard。
- 被擋後模型不會一直重試。

不在範圍內：SAP（目前是 mockup，無法寫入）、依身分放行的例外、時段條件、稽核頁（之後可接 Log 瀏覽器）、遮罩（DLP 只能 block）。

## 前提（已確認）

- 聊天走 MCP Server Portal「SaaS MCP Portal」（`saasmcp.neokung.work`），`secure_web_gateway: true`。
- Portal 內的 `salesforce-mcp`（upstream `https://salesforce-mcp.neokung.work/mcp`，OAuth）也開了 Gateway 路由。
- Salesforce worker（`cf-demo-mcp-proxy-salesforce`）用 client credentials 連真的 dev org，`sf_create_*` / `sf_update_*` 會實際寫入。
- Gateway HTTP 政策看不到 body；只有 DLP 能掃 POST body，而且只掃**前 1,024 bytes**。DLP regex 是 Rust regex（**不支援 lookaround**）。
- 政策要比對 **upstream host**（`salesforce-mcp.neokung.work`），不是 Portal 網址。

## 場景

所有規則都是：`Host in salesforce-mcp.neokung.work` **AND** `DLP Profile in <該場景 profile>` → **Block**。
DLP profile 與 Gateway 規則名稱都以 `MCP Demo: ` 開頭，預設**停用**。

| # | 場景 | 自訂 DLP regex（草案，spike 後定稿） | 放行範例 | 擋下範例 |
|---|------|------|------|------|
| 1 | 工具層級：禁止寫入 CRM | `sf_(create\|update)_(account\|contact\|opportunity\|lead\|case)` | 「列出 5 筆 Account」 | 「在 Salesforce 建立一筆潛在客戶：陳志明，公司『Demo 半導體』，來源 Web」 |
| 2 | 動作層級：禁止結案商機 | `"stage"\s*:\s*"Closed` | 「把商機 X 的階段改成 Negotiation/Review」 | 「把商機 X 的階段改成 Closed Won」 |
| 3 | 參數層級：SOQL 不得查人員資料 | `(?i)FROM\s+(Contact\|User)\b` | 「用 SOQL 查 5 筆 Account 名稱」 | 「用 SOQL 撈出所有 Contact 的姓名、Email、電話」 |
| 4 | 回應 DLP：個資不得回到 LLM | Email：`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`（可加台灣手機 `09\d{2}-?\d{3}-?\d{3}`） | 「列出 5 筆 Account」 | 「列出 5 位 Contact 和他們的 Email」 |

注意：

- 場景 1 的範例 prompt **不放 email**，以免場景 4 同時開啟時在 request 方向誤觸。
- 場景 2 需要一筆既有商機；卡片提供「先建立一筆 Demo 商機」的 prompt（場景 1 規則關閉時）。
- 場景 3 原本想做「沒有 LIMIT 就擋」，但 Rust regex 沒有 lookahead，改為以物件名稱判斷。

## App 設計

### 1. 「MCP 卡控」子頁（`/mcp-guardrails`）

- 側欄「功能」群組新增一項，與 Clef 並列。
- 頁面頂部：設定狀態（token 是否可用、規則是否已建立）+「建立 / 同步規則」按鈕。
- 每個場景一張卡片：
  - 標題與一句話說明（雙語，i18n）
  - 政策表：Selector / Operator / Value / Action
  - 開關：呼叫 API 切換該 Gateway 規則的 `enabled`，顯示「生效中…」直到傳播時間過去（時間以 spike 實測為準）
  - 範例 prompt（放行 / 擋下各一），按鈕「在聊天中試試」→ 導向 `/?prompt=...&mcp=saas`，聊天頁**只填入輸入框、不自動送出**，並在 `saas` 已認證時自動勾選
- 場景定義放在單一檔案 `src/app/pages/mcp-guardrails-scenarios.ts`（regex、prompt、說明），API 與 UI 共用。

### 2. API：`/api/mcp-guardrails`

- `GET`：依名稱前綴 `MCP Demo: ` 找出 DLP profile 與 Gateway 規則，回傳每個場景的 `{ ruleId, enabled, exists }`。
- `POST /setup`：缺的 profile / 規則就建立（idempotent，規則建立為停用）。
- `POST /toggle { scenario, enabled }`：`PUT gateway/rules/{id}` 只改 `enabled`。
- 使用新的 secret `CF_ZT_API_TOKEN`（權限：Zero Trust Edit），不擴大既有 `CF_API_TOKEN` 的權限。本地放 `.dev.vars`，production 用 `wrangler secret put`。

### 3. 聊天中的「被攔截」呈現

- `buildMcpTools`（`src/lib/chat-tools.ts`）在工具呼叫失敗或 `isError` 時，辨識 Gateway / DLP block（判斷依據以 spike 取得的實際錯誤格式為準，預期含 DLP rule ID）。
- 被擋時回傳 `{ blocked: true, ruleId, ruleName, message }`，`message` 明確告訴模型：「此呼叫被組織政策攔截，不要重試，請告知使用者。」
- 前端工具卡片遇到 `blocked: true` 時顯示 🛡「已被 Cloudflare Gateway 攔截」，附規則名稱與 rule ID。

## 錯誤處理

- 沒有 `CF_ZT_API_TOKEN` 或權限不足：子頁顯示設定指引，卡片的開關停用，但範例 prompt 仍可使用。
- 規則被人在 Dashboard 刪掉：`GET` 回報 `exists: false`，提示重新同步。
- 被擋後模型仍重試：工具回傳訊息 + system prompt 一句規則雙重保險。

## 測試

- 單元測試：場景 regex 對真實的 Portal → upstream request / response 樣本（spike 取得）做比對，確認該擋的擋、該放的放。
- 本地 `npm run dev` 端到端：四個場景各跑「規則關 → 實際寫入/讀取成功」「規則開 → 被攔截卡片」。

## Spike 結果（2026-10-13，經 Portal 實測）

已建立的資源（全部預設停用）：

| 場景 | DLP profile | Gateway 規則 | body_phase |
|---|---|---|---|
| 1 | `7800aa22-8d08-4d80-8fd9-370044598a30` regex `sf_(create\|update)_(account\|contact\|opportunity\|lead\|case)` | `4c6f7183-708e-4fb8-abc3-3f3e18f75eaf` | upload |
| 2 | `113f67d0-6e94-4c30-adad-923420858c92` regex `"stage"\s{0,3}:\s{0,3}"Closed` | `e50d7a14-ae32-4b57-9911-ad63394a6c7f` | upload |
| 3 | `0e8c9d18-4836-4f2a-aac4-67fa35656c2c` regex `(?i)FROM\s{1,5}(Contacts?\|Users?)\b` | `5e050c10-4b80-4352-b691-79f36730d759` | upload |
| 4 | `3a4d540b-b846-419f-8b6b-70222f175e98` 有上限的 Email regex | `0b3b9c32-c2dd-4318-8467-9388df53dfee` | download |

實測結論：

- **沒開規則時寫入真的生效**：`sf_create_lead`、`sf_create_opportunity`、`sf_update_opportunity` 都寫入了 dev org。既有、已啟用的 `Neo-HTTP-MCPSalesforce-DLPPII-Block` 不會干擾（帶 email / 電話的 Contact 清單照常回傳）。
- **場景 1、2、3 有效**，讀取不受影響：Closed Won 被擋、Negotiation/Review 放行；`FROM Contact` 不分大小寫都擋、`FROM Account` 放行。
- **場景 3 的繞過**：子查詢 `(SELECT Email FROM Contacts)` 一開始沒被擋，已把 regex 改成 `Contacts?|Users?`。demo 時可以拿來講「規則要持續調校」。
- **傳播時間**：啟用後約 11 秒、停用後約 30 秒內就生效。UI 的「生效中…」提示抓 15–30 秒即可。
- **被擋時的錯誤**：MCP SDK 拋出 `McpError`，`code === -30403`，`data = { rule_id, request_id }`，message 為 `Request blocked | rule_id: … | request_id: …`。攔截卡片就用這個判斷。
- **身分**：使用者的 tool call 在 Gateway log 裡帶 `email`（背景同步沒有），所以之後可以加上依身分的規則。
- **場景 4 沒有效果**：upstream（`agents/mcp` 的 `createMcpHandler`）回應是 `text/event-stream`，Gateway DLP 不掃 SSE 串流回應。要讓場景 4 生效，Salesforce worker 必須設定 `enableJsonResponse: true`，改回傳 `application/json`。此修改需要部署 `cf-demo-mcp-proxy-salesforce`。
- **限制**：DLP regex 不能有無上限的量詞（`+`、`*`），否則回 `3305 pattern matches more than 1024 bytes`。word_list 每個帳號只能有 1 個，已被 SAP 規則佔用。
- **測試資料**：dev org 留下 Lead `00Qhg000003VgCXEA0` 與商機 `006hg000001fNCzAAM`（階段 Negotiation/Review），可以直接當作場景 2 的 demo 商機。

App 的 `/api/mcp-guardrails` 改為依名稱前綴 `MCP Demo: ` 找到上述資源；「建立 / 同步規則」只在資源遺失時重建。
