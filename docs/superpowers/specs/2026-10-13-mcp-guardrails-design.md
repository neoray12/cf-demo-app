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
| 1 | 工具層級：禁止寫入 CRM | `"name"\s*:\s*"sf_(create\|update)_[a-z]+"` | 「列出 5 筆 Account」 | 「在 Salesforce 建立一筆潛在客戶：陳志明，公司『Demo 半導體』，來源 Web」 |
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

## 待 spike 驗證

1. Portal 轉給 upstream 的 JSON-RPC body：工具名稱是否已去掉 `{server_id}_` 前綴、`params.name` / `arguments` 是否在前 1KB。
2. Response 方向的 DLP 實際行為與錯誤格式（Portal 回給 client 的內容）。
3. 規則切換的傳播時間。
4. Portal 轉送的流量在 Gateway 中的規則優先序是否會被既有 Allow 規則搶先。
