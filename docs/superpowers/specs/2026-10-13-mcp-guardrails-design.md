# MCP 卡控（MCP Guardrails）Demo 與聊天處理過程顯示 — 設計

日期：2026-10-13
狀態：spike 完成、使用者已同意方向，待實作計畫審閱

## 目標

**A. MCP 卡控 demo**：讓客戶在 cf-demo-app 裡親眼看到，Cloudflare Gateway + DLP 能對 MCP 做**工具 / 動作 / 參數 / 回應資料**四個層級的卡控，而不只是整台 server 的開與關。

**B. 聊天處理過程**：修正「思考中… N 秒」計時器的問題，並把一個回合的處理過程（等模型、推理、呼叫工具、整理答案）連同各段耗時顯示出來，讓使用者看得懂現在在做什麼。

成功條件：

- 每個場景都有範例 prompt，**沒開規則時會真的寫入或讀取 Salesforce dev org**；規則開啟後，同一個 prompt 會被擋下。
- 規則由簡報者在 Cloudflare Dashboard 自己開關。App 負責說明政策、帶入 prompt，並把被擋的工具呼叫畫成清楚的「被 Gateway 攔截」卡片。
- 被擋後模型不會一直重試。
- 串流中不會出現「看起來像當掉」的空白；工具失敗時不會一直顯示執行中。

不在範圍內：SAP（mockup，無法寫入）、App 內開關規則（使用者決定自己在 Dashboard 操作，所以不需要 Zero Trust token）、依身分的例外、稽核頁、遮罩（DLP 只能 block）。

## 前提（已實測確認）

- 聊天走 MCP Server Portal「SaaS MCP Portal」（`saasmcp.neokung.work`），`secure_web_gateway: true`；Portal 內的 `salesforce-mcp`（upstream `https://salesforce-mcp.neokung.work/mcp`）也開了 Gateway 路由。
- Salesforce worker 用 client credentials 連真的 dev org，`sf_create_*` / `sf_update_*` 會實際寫入。
- Gateway HTTP 政策看不到 body，只有 DLP 能掃。政策要比對 **upstream host**，不是 Portal 網址。
- DLP regex 是 Rust regex：不支援 lookaround，且不能有無上限的量詞（`+`、`*`），否則回 `3305 pattern matches more than 1024 bytes`。word_list 每個帳號只能有 1 個，已被既有的 SAP 規則佔用。
- Gateway DLP **不掃 SSE 串流回應**。Salesforce worker 已加上 `enableJsonResponse: true`（`cf-demo-mcp-proxy-salesforce` commit `8ec03e0`，已部署版本 `baf0f7a1`），改回傳 `application/json`。

## 場景與已建立的資源

所有規則都是 `http.request.host == "salesforce-mcp.neokung.work" and any(dlp.profiles[*] in {<profile>}) and http.body_phase == <phase>` → **Block**。
名稱都以 `MCP Demo: ` 開頭，**預設停用**，由簡報者在 Dashboard 開關。

| # | 場景 | DLP profile / regex | Gateway 規則 | phase | 放行範例 | 擋下範例 |
|---|---|---|---|---|---|---|
| 1 | 工具層級：禁止寫入 CRM | `7800aa22-8d08-4d80-8fd9-370044598a30` `sf_(create\|update)_(account\|contact\|opportunity\|lead\|case)` | `4c6f7183-708e-4fb8-abc3-3f3e18f75eaf` | upload | 「列出 Salesforce 的 Account」 | 「在 Salesforce 建立一筆潛在客戶：陳志明，公司『Demo 半導體』，來源 Web」 |
| 2 | 動作層級：禁止結案商機 | `113f67d0-6e94-4c30-adad-923420858c92` `"stage"\s{0,3}:\s{0,3}"Closed` | `e50d7a14-ae32-4b57-9911-ad63394a6c7f` | upload | 「把商機 MCP Demo 商機 (Spike) 的階段改成 Negotiation/Review」 | 「把商機 MCP Demo 商機 (Spike) 的階段改成 Closed Won」 |
| 3 | 參數層級：SOQL 不得查人員資料 | `0e8c9d18-4836-4f2a-aac4-67fa35656c2c` `(?i)FROM\s{1,5}(Contacts?\|Users?)\b` | `5e050c10-4b80-4352-b691-79f36730d759` | upload | 「用 SOQL 查 5 筆 Account 名稱」 | 「用 SOQL 撈出所有 Contact 的姓名、Email、電話」 |
| 4 | 回應 DLP：個資不得回到 LLM | `3a4d540b-b846-419f-8b6b-70222f175e98`（有上限的 Email regex） | `0b3b9c32-c2dd-4318-8467-9388df53dfee` | download | 「列出 Salesforce 的 Account」 | 「列出 Salesforce 的 Contact 和他們的 Email」 |

注意：

- 場景 1 的範例 prompt **不放 email**，以免場景 4 同時開啟時誤觸。
- 場景 2 使用 spike 留下的商機 `006hg000001fNCzAAM`（「MCP Demo 商機 (Spike)」）。卡片另外提供「重設為 Prospecting」的 prompt，讓 demo 可以重複跑。
- 場景 3 原本想做「沒有 LIMIT 就擋」，但 Rust regex 沒有 lookahead。子查詢 `FROM Contacts` 曾經繞過，已修正；這段可以在 demo 時拿來講「規則要持續調校」。

## 實測結果

| 場景 | 規則關閉 | 規則開啟 | Client 收到的錯誤 |
|---|---|---|---|
| 1 | ✅ 建立 Lead `00Qhg000003VgCXEA0` | 🛡 寫入被擋、讀取照常 | `McpError` `-30403`，`data.rule_id` |
| 2 | ✅ 改成 Negotiation/Review | 🛡 改成 Closed Won 被擋 | `McpError` `-30403`，`data.rule_id` |
| 3 | ✅ `FROM Account` | 🛡 `FROM Contact`（不分大小寫）被擋 | `McpError` `-30403`，`data.rule_id` |
| 4 | ✅ Contact 清單帶 email | 🛡 含 email 的回應被擋；不含 email 的工具照常 | `McpError` `-32603 Internal Error`，**沒有 rule ID** |

- 生效時間：啟用約 11 秒、停用約 30 秒。
- 既有、已啟用的 `Neo-HTTP-MCPSalesforce-DLPPII-Block` 不會干擾。
- 身分：使用者的 tool call 在 Gateway log 帶 `email`，之後可以加依身分的規則。

## 設計 A：MCP 卡控

### A1. 「MCP 卡控」子頁 `/mcp-guardrails`

- 側欄「功能」群組新增一項，與 Clef 並列；路由 `src/app/(dashboard)/mcp-guardrails/page.tsx`，頁面 `src/app/pages/mcp-guardrails.tsx`。
- 場景定義集中在 `src/app/pages/mcp-guardrails-scenarios.ts`：標題 / 說明（雙語）、政策表、rule ID、Dashboard 連結、放行與擋下的 prompt。
- 每張卡片：
  - 層級標籤（工具 / 動作 / 參數 / 回應）、標題、一句話說明
  - 政策表：Selector / Operator / Value / Action（顯示實際的 regex 與 phase）
  - 「在 Dashboard 開啟規則」連結（直接到該規則的編輯頁）
  - 放行 / 擋下兩個 prompt，各有「在聊天中試試」按鈕
- 頁首說明 demo 流程：先跑擋下的 prompt（成功寫入）→ 到 Dashboard 開規則 → 等約 15 秒 → 再跑一次（被擋）。

### A2. 帶 prompt 進聊天

- 「在聊天中試試」導向 `/?prompt=<encoded>&mcp=saas`。
- 聊天頁讀到參數後：**只填入輸入框、不自動送出**；如果 `saas` 已認證就自動勾選，否則提示先在 MCP 面板完成認證。讀完後清掉 URL 參數，避免重新整理時重複帶入。

### A3. 聊天中的「被攔截」呈現

- `callMcpTool` 拋出 `McpError` 時，`buildMcpTools`（`src/lib/chat-tools.ts`）依錯誤分類：
  - `code === -30403`：確定是 Gateway 擋下 request。回傳 `{ blocked: true, direction: "request", ruleId, requestId, message }`。
  - `code === -32603`，且 server 是開了 Gateway 路由的 Portal（`saas`）：可能是 response DLP 擋下。回傳 `{ blocked: true, direction: "response", message }`；UI 用「可能」的語氣，並提示到 Gateway log 確認。
  - 其他錯誤維持現狀。
- `message` 明確告訴模型：「此工具呼叫被組織的資安政策（Cloudflare Gateway）攔截。不要重試，也不要改用其他工具繞過；請告知使用者被攔截的動作。」
- 規則名稱用場景定義檔的 rule ID 對照表查（`ruleId → 場景標題`），查不到時只顯示 ID。
- 前端 `ToolCallDisplay` 遇到 `blocked: true` 時，顯示 🛡「已被 Cloudflare Gateway 攔截」卡片：方向（請求 / 回應）、規則名稱、rule ID、request ID。

## 設計 B：聊天處理過程

### B1. 修正

1. **`tool-error` 沒有轉送**：`/api/chat` 轉送 AI SDK 的 `tool-error`（兩條串流路徑都要處理），前端把該工具標成 `status: "error"` 並顯示錯誤訊息。`ToolCallInfo.status` 增加 `"error"`；計時與「等待中」的判斷改用「已結束」（done 或 error）。
2. **空字串 delta**：後端不送出空的 `text-delta` / `reasoning-delta`，前端 `appendPart` 也略過空字串。
3. **多工具並行**：「等待中」的判斷改成「沒有任何工具還在執行」，而不是只看最後一個 part。

### B2. 處理過程時間軸

前端在串流時，替每個事件記下時間戳記（`performance.now()` 相對於送出時間），把一個回合拆成以下階段：

| 階段 | 開始 | 結束 |
|---|---|---|
| 等待模型回應 | 送出 | 第一個 reasoning / text / tool 事件 |
| 推理 | 第一個 reasoning-delta | 下一個不同類型的事件 |
| 呼叫工具 ⟨名稱⟩ | tool-call-start | tool-result / tool-error |
| 整理答案 | 工具結束後 | 下一個 text 事件或另一個工具開始 |
| 撰寫回覆 | text 開始 | 下一個工具或串流結束 |

- **串流中**：取代現在的三個圓點，在訊息下方顯示精簡的時間軸，例如「✓ 等待模型 3.1s · ✓ 呼叫 Salesforce · sf_create_lead 2.3s · ⟳ 整理答案中… 4s」，標題列顯示「處理中… 共 N 秒」。
- **結束後**：收合成一行「處理過程 · 共 14.6 秒 · 2 個工具」，可點開看完整時間軸。
- 工具名稱用易讀格式：`tool_saas_salesforce-mcp_sf_create_lead` 顯示為「Salesforce · sf_create_lead」；內建工具沿用現有的 i18n 名稱。
- 被 Gateway 攔截的工具，在時間軸上標 🛡。
- 時間軸只存在前端訊息狀態（`ChatMessage.timeline`），不送回後端，也不影響模型 context。

## 錯誤處理

- 被擋後模型仍重試：工具回傳訊息加上 system prompt 一句規則，雙重保險。
- `saas` 未認證就點「在聊天中試試」：填入 prompt，並提示先認證。
- 舊訊息沒有 `timeline`：不顯示時間軸，其餘照舊。

## 測試

- 單元測試（vitest）：
  - `McpError` → blocked 物件的分類（`-30403` 帶 rule ID、`-32603` 在 Portal、其他錯誤）。
  - 時間軸建構函式：給定事件序列（含並行工具、tool-error、空 delta），產生正確的階段與耗時。
  - 場景 regex：對 spike 取得的 request 樣本，確認該擋的擋、該放的放。
- 本地 `npm run dev` 端到端：四個場景各跑「規則關 → 實際寫入 / 讀取成功」「規則開 → 攔截卡片」，並截圖時間軸。
