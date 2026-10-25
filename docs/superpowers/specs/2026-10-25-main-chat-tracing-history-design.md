# 主聊天：Agent Tracing + 對話歷史 設計

日期：2026-10-25

## 目標

1. 主聊天（`/api/chat`）接上 Cloudflare Agents tracing，Dashboard「Agents」分頁可以 Session replay（訊息、推理、工具參數與結果全記錄）。
2. 每次對話完整保存（越詳細越好），使用者可在聊天頁看到自己的歷史對話、打開後接著聊、搜尋、改名、刪除、匯出原始 JSON。
3. 對話歸屬「登入的 email」。身分必須由伺服器驗證，不信任前端帶上來的 email。

不做：長期記憶（Agent Memory）、檔案工作區、跨使用者分享。

## 身分

伺服器依序判斷（`getRequestUser()`，`src/lib/auth.ts`）：

1. **Cloudflare Access**：請求帶 `Cf-Access-Jwt-Assertion`，且設定了 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`（`[vars]`）→ 以 `https://{team}/cdn-cgi/access/certs` 驗 RS256 簽章、`aud`、`iss`、`exp`，用 JWT 的 `email`。JWKS 快取 1 小時。兩個 vars 沒設就不走這條（目前網站沒有 Access）。
2. **App 登入 cookie**：`/api/auth/login` 成功後發 httpOnly、`SameSite=Lax`、HMAC-SHA256 簽章的 `cf_demo_user` cookie（`{email, name, exp}`，30 天）。密鑰 `AUTH_SECRET`，沒設時退回 `CHAT_SANDBOX_SECRET`。

帳號：

- 帳密從程式碼移到 Worker secret `LOGIN_USERS`（JSON：`[{"email":"neo@cloudflare.com","name":"Neo","password":"…"}]`）。帳號欄可輸入 email 或 email 的 `@` 前段（`neo`）。密碼以 HMAC 比對（固定時間）。舊的 `demo/demo`、`password = username` 規則移除。
- 沒設 `LOGIN_USERS` 時登入回 500「LOGIN_USERS 未設定」。
- 新增 `GET /api/auth/me`（回 `{email, name, source}` 或 401）、`POST /api/auth/logout`（清 cookie）。
- Dashboard layout 改成以 `/api/auth/me` 判斷是否登入（localStorage 只當顯示用快取）。所以舊的 localStorage 登入狀態要重新登入一次；有 Access 身分時直接進入。
- `/api/chat` 的 AI Gateway metadata（`email`、`usertier`、`department`）改用驗證過的 email；沒有時才用前端帶的值。

## Tracing

- `/api/chat` 的主要呼叫與 smart retry 都改用 `getTracedAI({ storeContent: true })` 的 `streamText`。
- `experimental_telemetry`：`functionId: "main-chat"`（= `gen_ai.agent.name`）、`metadata.agentId: "main-chat-demo"`、`metadata.conversationId`（同對話 = Dashboard 同一個 session）、`model`、`turnIndex`、`email`（有時）。
- 工具由 `wrapAISDK` 自動產生 `execute_tool` span。本地 `next dev` 為 noop。

## 儲存

- **D1** `cf-demo-chat-history`（binding `HISTORY_DB`，migration `migrations/chat-history/`）：
  - `conversations(id, email, title, model, provider, created_at, updated_at, turn_count, input_tokens, output_tokens, last_status)`，索引 `(email, updated_at DESC)`。
  - `turns(conversation_id, turn_index, email, started_at, ended_at, duration_ms, ttft_ms, status, model, provider, compat_model, routed_model, finish_reason, input_tokens, output_tokens, reasoning_tokens, tool_calls, tool_names, error_type, user_text, assistant_text, r2_key)`，PK `(conversation_id, turn_index)`。`user_text` / `assistant_text` 存前 4000 字供搜尋與預覽。
- **R2** `cf-demo-chat-history`（binding `HISTORY_BUCKET`；刻意不用會被 AI Search 索引的 `cf-demo-crawler`）：
  - `users/{sha256(email) 前 16 hex}/{conversationId}/turn-{NNNN}.json`：完整紀錄（見下）。
  - 同資料夾 `turn-{NNNN}-image-{i}.{ext}`：使用者貼的圖片（JSON 只存 key，不重複存 base64）。

### 每一輪的完整紀錄（`TurnRecord`，`v: 1`）

- 身分與時間：`conversationId`、`turnIndex`、`email`、`userName`、`authSource`、`startedAt` / `endedAt`（ISO）、`durationMs`、`ttftMs`、`status`（`completed` / `error` / `client-aborted`）。
- 請求：`model`、`provider`、`compatModelId`、`toolsEnabled`、`codeMode`、`codeModeActive`、`mcpServers`、`edgeColo`、`country`、`userAgent`、完整 `systemPrompt`、註冊的工具（名稱 + 描述）、送給模型的 `messages`（歷史文字）、圖片 key、附件（名稱、大小、沙箱路徑）、`maxOutputTokens`。
- 回應：前端看到的同一份 `assistant`（`content`、`reasoning`、依序 `parts`、`toolCalls` 含完整參數與結果、`routedModel`、`notices`）、`timeline`（與前端 `TimelineEvent` 相同格式，伺服器端計時）、每次模型呼叫（`attempts`：stream / smart-retry / plain retry 的 finishReason、totalUsage、每步 usage 與 response id）、每個 AI Gateway 請求的 `status`、`cf-ray`、`cf-aig-log-id`、`cf-aig-cache-status`、耗時、錯誤。
- `events`：伺服器送給前端的每一個 NDJSON 事件，附相對毫秒 `t`。

### 寫入時機

- `send()` 是所有 NDJSON 事件的唯一出口，`TurnRecorder.onEvent()` 掛在這裡，所以紀錄與前端畫面一致。
- 串流結束（含錯誤）時 `ctx.waitUntil(saveTurn())`：先 R2（圖片 + JSON），再 D1 upsert turn 與 conversation。存檔失敗只記 log，不影響回覆。
- 只在有驗證身分時存；沒身分照常聊天。
- 前端每次送出帶 `turnIndex`（該輪之前的 user 訊息數）。同一位置重送（前端自動重試、按「重試」）會覆蓋同一輪，所以歷史與畫面一致。
- 用戶端斷線（`request.signal` / stream `cancel()`）時模型仍會跑完，狀態記為 `client-aborted`。

### 共用 reducer

把 `chat.tsx` 串流迴圈裡累積 `content / reasoning / toolCalls / parts / timeline` 的邏輯抽成純函式 `applyChatEvent()`（`src/lib/chat-turn.ts`），前端串流與伺服器 `TurnRecorder` 共用，所以還原的訊息跟當時畫面一樣。

## API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/chat/history?q=&limit=&before=` | 自己的對話列表（`updated_at` 新到舊，`q` 比對標題與內容） |
| GET | `/api/chat/history/{id}` | 還原用：每輪的 user 訊息（圖片為 asset URL）與 assistant 訊息 |
| GET | `/api/chat/history/{id}?raw=1` | 匯出：所有輪的完整 `TurnRecord` |
| PATCH | `/api/chat/history/{id}` | `{title}` 改名 |
| DELETE | `/api/chat/history/{id}` | 刪除 D1 列與 R2 物件 |
| GET | `/api/chat/history/asset?key=` | 圖片；key 必須在自己的 `users/{hash}/` 底下 |

全部要求驗證身分（401），只能存取自己的 email。

## UI

- 聊天區左邊的歷史欄（仿 ChatGPT），預設展開、可收合並記住狀態；手機為左側滑出。
- 面板：搜尋框；依「今天 / 昨天 / 過去 7 天 / 更早」分組；每項顯示標題、時間、模型、輪數；點擊載入；選單可改名、匯出 JSON、刪除（確認）。目前對話高亮。
- 載入後 `conversationId` 換成該對話，可以接著聊；模型選單切到該對話最後使用的模型（若還在清單內）。
- 沒有登入身分時面板顯示「登入後才會保存對話」。

## 錯誤處理

- 存檔、列表失敗不影響聊天；列表 API 失敗時面板顯示錯誤與重試。
- D1 / R2 binding 不存在（例如本地沒設定）時歷史功能停用，`/api/chat/history` 回 503。

## 測試

- `auth.test.ts`：`LOGIN_USERS` 解析、帳號比對、cookie 簽章 / 竄改 / 過期、Access JWT（自產 RSA 金鑰）驗證 aud / iss / exp。
- `chat-turn.test.ts`：reducer 的 parts 順序、工具狀態、timeline。
- `chat-history.test.ts`：`TurnRecorder` 產出的紀錄、R2 key、標題推導、還原成 UI 訊息。
- 本地 `npm run dev`：登入、聊天（含工具）、歷史列表、載入接續、刪除。

## 上線前（使用者動作）

```bash
npx wrangler secret put LOGIN_USERS
npx wrangler secret put AUTH_SECRET
npx wrangler d1 migrations apply cf-demo-chat-history --remote
```
