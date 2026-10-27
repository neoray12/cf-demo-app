# 分析報表寄到信箱 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者在聊天說「幫我整理上個月的退貨，寄到我信箱」：Agent 寫 Python 在 Sandbox 跑分析、產生 PDF 與圖表 → 檔案存進 R2 → 寄一封帶下載連結的信到**使用者本人**的信箱（投影片第 45 張「Sandbox × R2 × Email」）。

**Architecture:** 新增 `emailReport` 工具。模型先用既有的 `executeCode` 把報表寫到 sandbox 的 `/workspace/reports/`，再呼叫 `emailReport({ title, summary, files })`。App 透過 chat-sandbox 新端點 `POST /api/files` 讀回檔案（只允許 `/workspace/reports/` 底下），存到 R2 `HISTORY_BUCKET` 的 `reports/{userHash}/{reportId}/{filename}`，產生帶 HMAC 簽章、7 天有效的下載網址 `/api/reports/{reportId}/{filename}?t=`，最後用 App 自己的 `send_email` binding（結構化 `env.EMAIL.send({...})`，不需 import `cloudflare:email`）寄給**目前登入的使用者 email**。收件人不開放給模型指定。範例資料（虛構退貨 CSV）打包進 sandbox image。

**Tech Stack:** Cloudflare Sandbox、R2、Email Sending（Workers binding 結構化 API）、Next.js API route、vitest。

**Spec:** 投影片第 45 張；Email Sending Workers API（`developers.cloudflare.com/email-service/api/send-emails/workers-api/`：`send({ from, to, subject, html, text, attachments })`）。

**前置：** 本計畫在「Sandbox 出口管控」合併之後執行（兩者都改 `workers/chat-sandbox/src/index.ts`、Dockerfile 與 `executeCode` 相關檔案）。開始前先 `git log --oneline -5` 確認出口管控的 commit 已在分支上。

## Global Constraints

- 回覆一律繁體中文；程式註解英文、照現有風格。
- **不要** `git push`、**不要**任何 `wrangler deploy`、不要 `wrangler secret put`、不要動 Dashboard / DNS / 正式 D1 / 正式 R2。只在本地實作、測試、commit 到自己的分支。
- 不要 commit `.dev.vars`；不要印出任何密鑰。
- 測試放 `src/**/*.test.ts`。
- 完成前：`npx vitest run` 全綠、root `npx tsc --noEmit -p .` 無新錯誤（既有的 `workers/openclaw-sandbox` / `openclaw-instances` / `save-to-r2` / `crawler-endpoint` 除外）、`workers/chat-sandbox` 內 `npx tsc --noEmit` 通過。
- 修改 `agents.md`（新增小節）。

## Decisions

1. **收件人只能是登入的使用者本人**（`getRequestUser` 的 email）。沒有登入 → 工具不註冊。工具參數沒有 `to`。這同時避免 prompt injection 把報表寄到外部。
2. **檔案限制**：路徑必須是 `/workspace/reports/` 底下的檔名（不含 `..`、不含子目錄跳脫），副檔名限 `.pdf .png .jpg .csv .xlsx .html`，每檔 ≤ 10 MB、最多 5 檔、總計 ≤ 20 MB。由 sandbox 端與 App 端**各驗一次**。
3. **儲存**：R2 `HISTORY_BUCKET`，key `reports/{sha256(email)[:16]}/{reportId}/{safeFilename}`，`customMetadata: { email, title, createdAt }`；`reportId = rpt_` + 10 bytes hex。不新增 bucket（`cf-demo-chat-history` 已存在、不會被 AI Search 索引）。
4. **下載連結**：`/api/reports/{reportId}/{filename}?t={exp}.{sig}`，`sig = HMAC-SHA256(REPORT_LINK_SECRET 或退回 APPROVAL_SECRET / AUTH_SECRET, "{reportId}/{filename}.{exp}")`，7 天。路由以簽章授權（信可能在手機上打開、沒有登入），回傳時設定 `Content-Disposition: attachment` 與正確 content-type、`Cache-Control: private, no-store`。可重用 `approval-token.ts` 的簽章實作（抽出一個通用 `signLink(secret, subject, exp)` / `verifyLink`，approval 的函式改成呼叫它，既有測試要繼續綠）。
5. **寄信**：App `wrangler.toml` / `wrangler.dev.toml` 新增 `[[send_email]] name = "EMAIL"`（不設收件人限制——收件人已由 Decision 1 鎖定）；寄件人 `reports@mail.neokung.work`（與審批信同一個已 onboard 的子網域）。HTML 內文：標題、模型給的摘要（**跳脫 HTML**）、每個檔案一個下載按鈕、第一張 PNG 以 inline attachment 顯示預覽（`disposition: 'inline'`, `contentId`），PDF 不附檔只給連結。本地 `wrangler.dev.toml` 若無法模擬寄信，工具回傳「本地未寄信」並附連結（ledger 記錄實際行為）。
6. **範例資料**：`workers/chat-sandbox/sample-data/returns-2026-09.csv`（虛構 300 筆：日期、門市、商品、類別、數量、單價、退貨原因），Dockerfile `COPY` 到 `/opt/sample-data/`。用一個 `scripts/` 小腳本以固定亂數種子產生，腳本與 CSV 都 commit。
7. **範例題目**（Sandbox 類別新增，雙語）：「分析 `/opt/sample-data/returns-2026-09.csv` 上個月的退貨：各類別退貨率、前五名商品、退貨原因分布，做成一份 PDF 報表（含圖），寄到我信箱」。
8. **System prompt**（Harness 的 sandbox 段落）：產生報表時把檔案寫到 `/workspace/reports/`，PDF 可用 matplotlib `PdfPages`；寄信用 `emailReport`，收件人自動是使用者本人。
9. **UI**：`emailReport` 結果卡片顯示「📧 已寄到 {email}」、每個檔案的下載連結（App 內點擊也能下載）、檔案大小。

## Review Focus

- `files` 帶 `../../etc/passwd`、絕對路徑跳脫、symlink → 兩端都拒絕。
- 摘要內含 `<script>` / `<img onerror>` → 信件 HTML 已跳脫。
- 下載連結：竄改 filename、竄改 reportId、過期 → 403；正確 → 200 且 content-type 正確。
- Sandbox 已休眠 / 檔案不存在 → 工具回傳清楚的錯誤，不寄空信。
- 寄信失敗（例如 Email Sending 拒收）→ 檔案仍在 R2，工具回傳連結與錯誤，讓模型告訴使用者。

---

### Task 1: 通用簽章連結

**Files:**
- Modify: `src/lib/approval-token.ts`（抽出 `signLink` / `verifyLink`，`signApprovalLink` / `verifyApprovalLink` 改呼叫它們）
- Test: `src/lib/approval-token.test.ts`（新增 `signLink` / `verifyLink` 測試；既有測試不改、要綠）

- [ ] 測試先失敗再通過、commit `refactor(links): generic signed link helper`。

### Task 2: 報表檔案驗證與 R2 key（純函式）

**Files:**
- Create: `src/lib/reports.ts`
- Test: `src/lib/reports.test.ts`

**Interfaces — Produces:**
- `validateReportFiles(paths: string[]): { ok: true; files: { path: string; name: string; type: string }[] } | { ok: false; error: string }`（Decision 2，content-type 由副檔名決定）
- `reportKey(userHash: string, reportId: string, name: string): string`
- `newReportId(): string`
- `reportEmail(input: { title: string; summary: string; links: { name: string; url: string; bytes: number }[]; previewCid?: string }): { subject: string; html: string; text: string }`（HTML 跳脫）

- [ ] 測試涵蓋 Review Focus 的路徑與 HTML 跳脫情境；commit `feat(reports): file validation, keys and email body`。

### Task 3: Sandbox 讀檔端點 + 範例資料

**Files:**
- Modify: `workers/chat-sandbox/src/index.ts`（`POST /api/files { sessionId, paths }` → `{ files: [{ name, type, bytes, base64 }] }`；用 SDK 的 `readFile`（base64 encoding）；路徑驗證重用 `src/lib/reports.ts` 的 `validateReportFiles`）
- Create: `workers/chat-sandbox/sample-data/returns-2026-09.csv`、產生它的 `scripts/generate-sample-returns.mjs`
- Modify: `workers/chat-sandbox/Dockerfile`（`COPY sample-data/ /opt/sample-data/`，確認 build context 是 `workers/chat-sandbox/`）

- [ ] `workers/chat-sandbox` 內 `npx tsc --noEmit`；若本機有 Docker，本地 `wrangler dev` 實測 `/api/files`（寫一個檔到 `/workspace/reports/` 再讀回），否則在 ledger 寫明。
- [ ] commit `feat(sandbox): read report files and bundle sample returns data`。

### Task 4: App 端工具、下載路由、寄信

**Files:**
- Modify: `src/lib/chat-sandbox.ts`（`readReportFiles(env, sessionId, paths)`）
- Modify: `src/lib/chat-tools.ts`（`buildEmailReportTool(env, { sessionId, user })`，Decision 1–5；只在 sandbox 已設定、使用者已驗證、`env.EMAIL` 與 `env.HISTORY_BUCKET` 都存在時註冊）
- Modify: `src/app/api/chat/route.ts`（把 user 傳給工具建構；`ToolSetConfig` 若需要擴充，維持 Code Mode 相容——不要把大型資料放進去）
- Create: `src/app/api/reports/[reportId]/[filename]/route.ts`（GET，Decision 4）
- Modify: `wrangler.toml`、`wrangler.dev.toml`（`[[send_email]] name = "EMAIL"`；`[vars]` 加 `REPORT_MAIL_FROM = "reports@mail.neokung.work"`）
- Modify: `env.d.ts` 或對應的型別宣告（`EMAIL: SendEmail`）
- Modify: `src/lib/system-prompt.ts`（Decision 8）
- Modify: 工具結果卡片（`emailReport` 的顯示，Decision 9）與 `src/i18n/{zh-TW,en}.json`、`suggestion-categories.tsx`（Decision 7）
- Test: 下載路由的授權判斷抽成純函式（例如 `authorizeReportDownload(secret, reportId, filename, t, now)`）並測試

- [ ] 測試先失敗再通過；`npx vitest run` 全綠；root `tsc` 無新錯誤。
- [ ] **本地驗證**：`npm run dev`（App）+ 本地 chat-sandbox（若有 Docker）走一次範例題；無法登入（Turnstile）時，至少用單元測試 + 直接呼叫 `/api/reports/...` 驗證簽章路由（先用 wrangler 在本地 R2 放一個測試物件），結果寫進 ledger；結束後刪掉本地測試物件。
- [ ] commit `feat(chat): emailReport tool — sandbox report to R2 and the user's inbox`。

### Task 5: 文件

- [ ] `agents.md` 新增小節：流程、限制、R2 key、下載簽章、寄件人、範例資料、**上線步驟**（部署 chat-sandbox 重建 image、App push、確認 `mail.neokung.work` 仍為 Email Sending 已 onboard）。
- [ ] commit `docs(reports): sandbox report to inbox`。

## 完成定義

- 全套 vitest 綠、兩處 tsc 無新錯誤。
- 最終回報列出：本地實測到哪一步、未驗證項目（真的寄信、正式 R2）、使用者要做的事。
