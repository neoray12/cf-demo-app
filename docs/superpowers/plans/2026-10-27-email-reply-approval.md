# Email 回信核准 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主管直接回覆審批信「核准」或「拒絕」就能讓 Workflow 繼續，不必點連結開網頁（投影片第 27–28 張「回信放行」）。

**Architecture:** 審批信的 `Reply-To` 改成帶簽章的子地址 `approvals+{approvalId}.{sig}@mail.neokung.work`。Email Routing（子網域 `mail.neokung.work`、開啟 subaddressing）把寄到 `approvals@mail.neokung.work` 的信交給 `workers/approval-workflow` 的 `email()` handler：驗證子地址簽章、寄件人在主管名單、審批還是 pending，解析回信第一段文字判斷核准 / 拒絕，然後**直接**在 Worker 裡更新 D1 並 `instance.sendEvent()`（Worker 自己就有 Workflow binding），最後回一封確認信。原本的「點連結核准」照常可用，兩條路共用同一個決定函式，誰先到誰算。

**Tech Stack:** Cloudflare Email Routing（inbound + subaddressing）、Email Sending（`send_email` binding）、Workflows、D1、`postal-mime`（解析回信 MIME）、vitest。

**Spec:** `docs/superpowers/specs/2026-10-26-human-in-the-loop-approvals-design.md`（審批整體設計）；本計畫是它的延伸，決策記錄在本檔「Decisions」。

## Global Constraints

- 回覆一律繁體中文；程式註解英文、照現有風格。
- **不要** `git push`、**不要**任何 `wrangler deploy`、**不要**動正式 D1 / Dashboard / DNS。只在本地實作、測試、commit 到自己的分支。
- 不要 commit `.dev.vars`；不要把任何密鑰印出來。
- 測試放 `src/**/*.test.ts`（vitest 只收這裡），Worker 共用的純函式放 `src/lib/`，Worker 以相對路徑 import（`workers/approval-workflow` 已經這樣用 `../../../src/lib/...`）。
- 完成前執行：`npx vitest run`（全綠）、`npx tsc --noEmit -p .`（只允許既有的 `workers/openclaw-sandbox` / `openclaw-instances` / `save-to-r2` / `crawler-endpoint` 錯誤）。
- 修改 `agents.md` 第 12 節（git 追蹤的是小寫 `agents.md`）。

## Decisions

1. **簽章放在子地址**，不是靠 `In-Reply-To`：`sig = HMAC-SHA256(APPROVAL_SECRET, "reply." + approvalId)` 取前 16 個 hex。郵件客戶端一定會保留 Reply-To 地址，簽章讓別人無法偽造其他審批的回信地址。
2. **寄件人必須在 `APPROVER_EMAIL` 名單**（不分大小寫），且 Email Routing 本身已要求 SPF 或 DKIM 通過（2025-07 起）。不在名單 → 不處理、時間軸記一筆「收到非主管的回信（x@y），已忽略」，不回信（避免被當成跳板）。
3. **判斷文字**：只看回信最上面、引用內容之前的文字（去掉 `>` 開頭的行，以及 `On ... wrote:`、`寄件者:`、`From:`、`-----Original Message-----`、`在 ... 寫道：` 之後的全部內容）。第一個非空行比對：核准 = `核准|同意|准|approve|approved|yes|ok`；拒絕 = `拒絕|不同意|駁回|reject|rejected|no`（整行 trim 後、不分大小寫、可帶標點）。兩者都不符 → 回信提示「請回覆『核准』或『拒絕』」，時間軸記一筆，狀態不變。
4. **只處理高風險、pending 的審批**；已決定 / 逾時 → 回信告知目前狀態。
5. 決定者記為 `主管（Email 回信：{寄件人}）`。
6. 確認信用 `env.APPROVAL_EMAIL.send({...})` 結構化 API 寄給寄件人（寄件人已在 `allowed_destination_addresses`），主旨 `Re: {原主旨}`，帶 `In-Reply-To` / `References` 讓它串在同一串。

## Review Focus

- Outlook / Gmail 中文回信的 MIME（quoted-printable、base64、`text/html` only）→ `postal-mime` 解析後取 `text`，沒有就把 `html` 去標籤。
- 主管回「核准，謝謝」或「OK!」→ 要判斷成核准；「不核准」不可判成核准（拒絕規則先比對，或核准規則要求整行以核准詞開頭且不含「不」）。
- 同一封信被 Email Routing 重送 / 主管回兩次 → 第二次 `transition` 失敗，回信「已經處理過」。
- 點連結和回信幾乎同時 → D1 的條件式 `transition` 只讓一個成功。
- 子地址簽章錯、或 approvalId 不存在 → 靜默忽略（不回信）。

---

### Task 1: 回信地址與內容解析（純函式）

**Files:**
- Create: `src/lib/approval-reply.ts`
- Test: `src/lib/approval-reply.test.ts`

**Interfaces — Produces:**
- `replyAddress(secret: string, approvalId: string, domain = 'mail.neokung.work'): Promise<string>` → `approvals+{approvalId}.{sig16}@{domain}`
- `parseReplyAddress(secret: string, to: string): Promise<string | null>` → approvalId（簽章不符或格式錯 → null；`to` 可能帶顯示名稱 `"x" <...>`、大小寫不同）
- `isApprover(from: string, approverList: string): boolean`（用 `parseRecipients`）
- `replyDecision(text: string): 'approve' | 'reject' | null`
- `stripQuoted(text: string): string`

- [ ] **Step 1: 寫失敗測試** — 至少：地址往返（`parseReplyAddress(replyAddress(id)) === id`）、改一個字元的簽章 → null、別的 approvalId 配舊簽章 → null；`isApprover` 大小寫、顯示名稱；`replyDecision`：`'核准'`、`'核准，謝謝'`、`'OK!'`、`'Approve'` → approve；`'拒絕'`、`'不同意'`、`'不核准'`、`'reject'` → reject；`'我再想想'`、`''` → null；`stripQuoted` 去掉 Gmail（`On Mon, ... wrote:`）、Outlook（`寄件者:` / `From:`）、`>` 引用、`-----Original Message-----`。
- [ ] **Step 2:** `npx vitest run src/lib/approval-reply.test.ts` → FAIL（模組不存在）。
- [ ] **Step 3: 實作**（HMAC 用 Web Crypto，同 `approval-token.ts` 寫法）。
- [ ] **Step 4:** 測試 PASS。
- [ ] **Step 5: Commit** `feat(approvals): signed reply-to address and reply parsing`

### Task 2: 共用的「記錄決定」函式

**Files:**
- Modify: `src/lib/approvals.ts`（新增 `recordDecision`）
- Modify: `src/app/api/approvals/[id]/decision/route.ts`（改用它，行為不變）
- Test: `src/lib/approvals.test.ts`

**Interfaces — Produces:** `recordDecision(db: D1Database, id: string, approve: boolean, by: string): Promise<boolean>` — 包裝現有 `transition`（approved / rejected，label `${by} 已核准|已拒絕`，`decidedBy: by`），回傳是否成功。

- [ ] 測試：用最小的 fake D1（只實作本函式用到的 `prepare().bind().first()/run()`）或直接測 label 組成的純函式 `decisionLabel(approve, by)`；擇一，寫在 ledger。
- [ ] 實作、改 decision route 呼叫它、`npx vitest run` 全綠、commit。

### Task 3: 審批信加上 Reply-To 與說明

**Files:**
- Modify: `src/lib/approval-mail.ts`（`buildMime` 加選填 `replyTo`、`headers`；`approvalEmail` 內文加「也可以直接回覆這封信『核准』或『拒絕』」）
- Modify: `src/lib/approval-mail.test.ts`
- Modify: `workers/approval-workflow/src/index.ts`（寄審批信時算 `replyAddress` 帶進 `buildMime`；`Message-ID` 存下來供確認信串接——可寫進 `addEvent` 的 label 之外，或簡單地在確認信只帶 `In-Reply-To: 回信的 Message-ID`，擇一並記錄）

- [ ] 測試：`buildMime` 有 `replyTo` 時輸出 `Reply-To:` 標頭；沒給時沒有；`approvalEmail` text / html 都含回信說明。
- [ ] 實作、測試、commit。

### Task 4: Worker 的 `email()` handler

**Files:**
- Modify: `workers/approval-workflow/src/index.ts`
- Modify: `package.json`（root）加 `postal-mime` dependency（Worker 由 root 的 node_modules bundle）
- Modify: `workers/approval-workflow/wrangler.toml`：新增 `addresses = ["approvals@mail.neokung.work"]`（wrangler 會在部署時建立 Email Routing 規則；**本任務不部署**），`[vars] REPLY_DOMAIN = "mail.neokung.work"`
- Modify: `workers/approval-workflow/wrangler.dev.toml`：同樣的 vars

**行為（依 Decisions 1–6）：**
1. `parseReplyAddress(env.APPROVAL_SECRET, message.to)` → null 就 return。
2. `isApprover(message.from, env.APPROVER_EMAIL)` → 否：`addEvent` 記「收到非主管的回信（{from}），已忽略」，return。
3. 讀審批；不是 `risk === 'high'` → return；不是 `pending` → 回信告知狀態。
4. `postal-mime` 解析 → `stripQuoted` → `replyDecision`；null → 回信提示 + `addEvent`。
5. `recordDecision(...)` 成功 → `env.APPROVAL_WORKFLOW.get(workflowId).sendEvent({ type: 'decision', payload: { decision, by } })` → 回信「已收到你的核准 / 拒絕」。`recordDecision` 失敗（已被處理）→ 回信「已經處理過」。
6. 所有路徑 `console.log(JSON.stringify({ event: 'approval.reply', approvalId, from, outcome }))`（不要記錄信件全文）。

- [ ] **本地驗證**：從 repo 根目錄 `npx wrangler dev -c workers/approval-workflow/wrangler.dev.toml --persist-to .wrangler/state --port 8790`；本地 D1 插一筆 high / pending 審批並 `POST /start`（方法同 `agents.md` 第 12 節）；用 `curl -X POST 'http://localhost:8790/cdn-cgi/local/email' --url-query 'from=neo@cloudflare.com' --url-query 'to=<replyAddress>' --data-raw '<RFC822 原文>'` 送三種信：(a) 主管回「核准」→ D1 approved、Workflow 收到事件往下走（execute 會因測試 session 沒 token 而 failed，屬預期）；(b) 非主管寄件人 → 被忽略；(c) 錯簽章地址 → 無動作。把三次的結果（D1 狀態、Worker log）寫進 ledger。結束後刪掉本地測試資料、關掉 wrangler。
- [ ] `npx tsc --noEmit -p .`、`npx vitest run` 全綠；commit `feat(approvals): approve or reject by replying to the approval email`。

### Task 5: 畫面與文件

**Files:**
- Modify: `src/app/approvals/[id]/approval-page.tsx`、`src/app/components/chat/approval-card.tsx`（高風險等待中的說明加「主管也可以直接回信核准」）
- Modify: `src/i18n/zh-TW.json`、`src/i18n/en.json`（`chat.approval.waitingManager` 文案）
- Modify: `agents.md` 第 12 節：回信核准流程、子地址簽章、`addresses` 設定，以及**上線前的手動步驟**：
  1. Dashboard → Email Service → Email Routing → `neokung.work` → Settings → Subdomains 加入 `mail.neokung.work`（只在子網域加 MX，apex 不動）
  2. 同頁開啟 **Subaddressing**
  3. 部署 Worker（`npx wrangler deploy -c workers/approval-workflow/wrangler.toml`，會依 `addresses` 建規則）
- [ ] `npx vitest run` 全綠；commit `docs(approvals): reply-to-approve`。

## 完成定義

- 所有 Task 的測試先失敗再通過；全套 vitest 綠、tsc 無新錯誤。
- 本地 `/cdn-cgi/local/email` 三種情境的結果記錄在 ledger 與最終回報。
- 最終回報列出：commit 清單、需要使用者做的 Dashboard 步驟、未驗證項目（真實 Email Routing 收信需上線後驗證）。
