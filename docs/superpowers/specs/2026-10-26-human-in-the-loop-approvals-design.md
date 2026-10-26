# Human-in-the-loop 審批（對話內核准 + Cloudflare Workflows）

日期：2026-10-26。使用者已確認：兩種都做、依風險分級；高風險由 Workflow 寄 Email 給固定主管信箱核准；Workflow 放在獨立 Worker。

## 目標

展示 Agent 寫入企業系統（SAP / Salesforce，經 MCP Portal）前要有人核准：

- **低風險（A）**：聊天裡出現「核准 / 拒絕」卡片，送出者自己按，App 立即執行。
- **高風險（B）**：建立 Cloudflare Workflow instance → 寄信給主管 → `step.waitForEvent` 等待（24 小時）→ 主管點信裡的簽章連結核准 → Workflow 回呼 App 執行寫入 → 寄結果通知。送出者關掉頁面也不影響；聊天卡片即時顯示 Workflow 進度。

與「MCP 卡控 Demo」的關係：Gateway 是硬性禁止，HITL 是軟性審批；審批通過後的寫入仍經過 Portal 與 Gateway 政策。

## 風險分級（`classifyCall`，`src/lib/approvals.ts`）

工具名稱去掉前綴（`tool_{serverId}_`、`salesforce-mcp_`、`sap-mcp_`、Code Mode 的 `salesforce_mcp_` / `sap_mcp_`）後判斷：

| 等級 | 規則 |
|------|------|
| 高 | `sf_update_opportunity` 的 stage 含 `Closed`；`sf_create_opportunity` / `sf_update_opportunity` 金額 ≥ 1,000,000；`sap_create_sales_order`、`sap_release_production_order`、`sap_teco_production_order`、`sap_close_production_order` |
| 低 | 其他 `sf_create_*` / `sf_update_*` |
| 無（照常執行） | 其他（讀取） |

Code Mode：`portal_codemode_execute` 的 `code` 裡找 `codemode.<name>(`，任一個是寫入就整段腳本送審批，等級取最高（腳本文字含 `Closed` 視為結案）。

## 資料

- D1 `cf-demo-chat-history` 新表 `approvals`（migration `0003_approvals.sql`）：id、email、session_id、conversation_id、server_id、tool_name、args_json、code_mode、risk、summary、writes_json、status（pending / approved / rejected / executing / done / failed / expired）、workflow_id、created_at、decided_at、decided_by、executed_at、result_json、error、events_json（時間軸）。
- 寫入一律用**送出者自己的** MCP token（`session_id` 找 KV）。OAuth callback 另外把 refresh token 存到 `mcp-refresh:{session}:{server}`（TTL 14 天）；執行時 access token 過期就自動續期。原本 token 過期時 refresh token 會一起被刪。
- Workflow 參數只放 `approvalId`（Dashboard 看得到參數）。

## 元件

| 元件 | 說明 |
|------|------|
| `src/lib/approvals.ts` | 分級、摘要、狀態轉換、D1 存取 |
| `src/lib/approval-token.ts` | 審批連結簽章（HMAC-SHA256，`APPROVAL_SECRET`，24 小時）；App 與 Worker 共用 |
| `src/lib/approval-exec.ts` | 執行審批通過的工具呼叫（refresh token、Gateway 攔截分類） |
| `mcp-subagent.ts` | 包住寫入工具：不直接寫，建立審批後回 `{ pendingApproval, approvalId }`；結果帶 `approvals` 給前端 |
| `GET /api/approvals/{id}` | 送出者（登入 email）或持有連結簽章者可讀 |
| `POST /api/approvals/{id}/decision` | 低風險：送出者本人，核准後立即執行；高風險：需要信裡的簽章，轉給 Worker `sendEvent` |
| `POST /api/approvals/{id}/execute` | 內部 API（`x-approval-secret`），由 Workflow 呼叫 |
| `workers/approval-workflow` | `ApprovalWorkflow`（load → email → waitForEvent → execute → notify），HTTP `/start`、`/event`（`x-approval-secret`） |
| `ApprovalCard`（聊天） | 輪詢狀態；低風險有按鈕；高風險顯示 Workflow 時間軸與 Dashboard 連結 |
| `/approvals/{id}`（審批頁） | 不需登入，靠連結簽章；顯示請求內容（Code Mode 時顯示腳本）與核准 / 拒絕 |

App ↔ Worker 用 HTTPS + 共用密鑰（`APPROVAL_WORKER_URL` / `APP_URL`），本地兩邊都能跑（Worker `wrangler dev --persist-to` 共用 App 的本地 D1）。

## 不做

- AI SDK 原生 `needsApproval`：寫入在 subagent 內，原生做法要中斷串流、新請求接續，subagent context 會遺失。
- Agents SDK `AgentWorkflow`：需要 Durable Object，與專案原則衝突。
- 審批後自動讓模型接續回答：卡片直接顯示結果。
