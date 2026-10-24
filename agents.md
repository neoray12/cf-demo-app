# CF Demo App - 專案需求與規範

## 帳號與環境

- **Cloudflare 帳號**: Neo-Cloudflare (`5efa272dc28e4e3933324c44165b6dbe`)
- **所有資源必須建立在此帳號下**
- **AI Gateway**: `nkcf-gateway-01`
  - URL: `https://gateway.ai.cloudflare.com/v1/5efa272dc28e4e3933324c44165b6dbe/nkcf-gateway-01`
  - OpenAI Compatible: `https://gateway.ai.cloudflare.com/v1/5efa272dc28e4e3933324c44165b6dbe/nkcf-gateway-01/compat/chat/completions`
  - Auth Token: 存在 `.dev.vars` 的 `CF_AIG_TOKEN`
- **R2 Bucket**: `cf-demo-crawler` (爬蟲資料存儲，供 AutoRAG 索引)
- **KV Namespace**: `SESSIONS` (`cd03af00eb9340a180014760028fbebd`)

## 功能需求

### 1. AI Agent (聊天機器人)
- 使用 **Vercel AI SDK**（`streamText` from `"ai"`）+ HTTP `/api/chat` 端點，**不使用** Cloudflare Agents SDK / WebSocket
- 透過 **AI Gateway** (`nkcf-gateway-01`) 路由所有 AI 請求（`cacheTtl: 3600`）
- 支援多個模型提供商：Workers AI、OpenAI、Anthropic、Perplexity
- 整合 **AI Search (AutoRAG)** 進行 RAG，查詢 R2 中已爬取的資料
- 聊天 UI 仿 ChatGPT 風格：串流回覆、Markdown 渲染、模型選擇器、建議卡片
- 預設模型：Claude Haiku 5.5（`claude-haiku-5-5`）。Anthropic 只保留 Sonnet 5.5 / Haiku 5.5；OpenAI 只保留 GPT-6.1 Sol（`gpt-6.1-sol`）/ GPT-6 Luna（`gpt-6-luna`）。Claude 5.5 不接受非預設的 `temperature`，不要在請求加上它

### 2. 網站爬蟲 (Browser Rendering)
- **Sidebar 子功能導航**：每個功能是獨立的子頁面，不使用 Tab
- 進入「網站爬蟲」後，先讓用戶輸入網址
- **必須包含所有 Browser Rendering REST API 端點**：
  - `/content` - 取得 HTML 原始碼
  - `/screenshot` - 擷取網頁截圖 (全頁/部分, WebP/PNG/JPEG)
  - `/pdf` - 將網頁轉為 PDF (A4/Letter, 直印/橫印)
  - `/markdown` - 將網頁轉為 Markdown
  - `/snapshot` - 同時取得 HTML 與截圖
  - `/scrape` - CSS 選取器提取特定元素
  - `/json` - AI 結構化資料提取
  - `/links` - 提取所有連結
  - `/crawl` - **整站爬取** (slash crawl，設定深度和頁面上限)
- 所有文字結果可存入 R2 供 RAG 使用
- REST API Base: `https://api.cloudflare.com/client/v4/accounts/5efa272dc28e4e3933324c44165b6dbe/browser-rendering/`
- 參考 `/Users/neokung/Desktop/CF-Demo/browser-rendering-demo` 的介接邏輯（已成功部署）

### 3. Log 瀏覽器
- 讀取帳號中所有 R2 bucket（透過 Cloudflare API）
- 樹狀結構導航：Bucket → Folder → File
- Logpush 的 `.gz` 檔案自動解壓
- JSON/NDJSON 美化顯示，可展開/摺疊
- AI Gateway 加密 logs 解密（private key 在瀏覽器端處理）
- 搜尋/過濾功能

### 4. 登入畫面
- 開發階段：UI only，任意帳密即可登入
- 未來可接入真正的認證系統

### 5. MCP (Model Context Protocol) 整合

- **架構**：無 Durable Objects，使用 `@modelcontextprotocol/sdk` Client 直接在 API route 中連線
- **OAuth 2.1 PKCE 流程**：前端 popup 處理，token 存入 KV，postMessage 通知父視窗
- **Token 儲存**：KV key `mcp-token:{sessionId}:{serverId}`
- **Tool cache**：KV key `mcp-tools:{sessionId}:{serverId}`，TTL 5 分鐘
- **MCP_SERVER_URLS 格式**：
  - 公開 server：`id=url`（例如 `cf-docs=https://docs.mcp.cloudflare.com/mcp`）
  - OAuth server：`id=url:oauth`（例如 `cf-radar=https://radar.mcp.cloudflare.com/mcp:oauth`）
- **已設定的 servers**：
  - `cf-docs` — Cloudflare Docs（公開）
  - `cf-observability` — Workers Observability（OAuth）
  - `cf-radar` — Radar（OAuth）
  - `saas` — SAP & Salesforce，走 MCP Server Portal「SaaS MCP Portal」`https://saasmcp.neokung.work/mcp`（OAuth，Access policy「Allow Neo Azure AD & MFA」）
    - **不要直連** `sap-mcp` / `salesforce-mcp.neokung.work` 或 `*.workers.dev`：Gateway 路由、DLP 與 Portal logs 只對經過 Portal 的流量生效
    - Portal 內的 server 是 `sap-mcp` / `salesforce-mcp`（AI Controls，auth_type **oauth**、Require user auth），upstream 為 Access 保護的 `sap-mcp.neokung.work/mcp`、`salesforce-mcp.neokung.work/mcp`；Access 本身就是 OAuth authorization server，Worker 驗 Access JWT
    - **不要**把 `*.workers.dev`（`sap-s4-hana-mcp` / `salesforce-crm-mcp`，unauthenticated）放進 Portal：Worker 讓 `initialize`/`tools/list` 免驗證（同步會成功），但 `tools/call` 一定要 Access JWT → 401 → Portal 回 `needsReauth`，模型會一直叫 `portal_toggle_servers`
    - Portal 工具名稱會加 server ID 前綴 `{server_id}_{tool}`，所以 tool key 形如 `tool_saas_sap-mcp_sap_list_customers`（需 ≤ 64 字元）；Gateway HTTP 政策要比對 **upstream** host（`sap-mcp.neokung.work` / `salesforce-mcp.neokung.work`），不是 Portal 網址
    - `neokung.work` 有 Zone Hold（含子網域）：在 hold 生效期間建立 Portal，custom hostname 建不起來，會回 **1014**。要重建 Portal 前先暫時解除 hold

  - `saas-cm` — 同一個 Portal 加上 `?codemode=search_and_execute`（Portal 政策 `opt_in`）：Portal 只提供 `portal_codemode_search` / `portal_codemode_execute` 兩個工具，模型寫 JS 在 Portal 端的 Dynamic Worker 一次呼叫多個工具。用它時 App 自己的 Code Mode 要關（避免巢狀執行）；首頁「Code Mode 示範」的 Portal 範例會自動關掉並只送 `saas-cm`。Gateway 在 Code Mode 下擋掉的工具呼叫包在 execute 結果裡，不會出現 🛡 攔截卡片
    - Portal Code Mode 的 search 不是語意搜尋：模型自己寫 JS 過濾 `codemode.tools()`，常猜錯名稱。`/api/chat` 會在連著 Portal Code Mode server 時，先用 `portal_codemode_search` 抓一次工具清單（KV `mcp-catalog:{sessionId}:{serverId}`，TTL 5 分鐘），把 `codemode.<name>(args)` 清單放進 system prompt（`src/lib/portal-catalog.ts`）
    - Salesforce MCP worker 回傳 `structuredContent`（`{ summary, totalSize, records }` / `{ summary, record }`，同一份 JSON 也放在 text）；App 端 MCP 工具結果優先回傳 structuredContent，Code Mode 腳本可直接計算。Portal 的工具說明來自**管理員授權的背景同步**（約 2 小時一次），worker 改了說明後要在 Dashboard 對 `salesforce-mcp` 重新授權 / Sync，否則 search 看到的是舊說明

#### MCP 相關檔案

| 檔案 | 說明 |
|------|------|
| `src/lib/mcp-auth.ts` | PKCE 生成、OAuth metadata discovery、token exchange、KV key helpers |
| `src/lib/mcp-client.ts` | MCP Client wrapper，`connectAndListTools()`、`callMcpTool()` |
| `src/app/api/mcp/servers/route.ts` | 回傳所有 server 清單及 auth 狀態 |
| `src/app/api/mcp/auth/start/route.ts` | 啟動 OAuth 流程（PKCE + dynamic client registration） |
| `src/app/api/mcp/auth/callback/route.ts` | OAuth callback，exchange code，存入 KV |
| `src/app/api/mcp/connect/route.ts` | 連線 server，discover tools，cache 到 KV |
| `src/app/api/mcp/tools/route.ts` | 彙總所有已連線 server 的工具 |
| `src/app/api/mcp/call/route.ts` | 執行指定 MCP tool |
| `src/app/api/mcp/disconnect/route.ts` | 刪除 KV token 和 tool cache |
| `src/app/components/chat/mcp-panel.tsx` | MCP 面板 UI（OAuth 認證、連線、展開工具詳情） |
| `src/app/components/icons/mcp-icon.tsx` | MCP 官方 logo SVG 元件 |

#### Chat API 整合
- `/api/chat` 接受 `mcpServers: string[]` 參數
- `buildMcpTools()` 動態從 KV cache 或即時連線取得工具，轉換為 Vercel AI SDK tool 格式
- Tool key 格式：`tool_{serverId}_{toolName}`（例如 `tool_cf-docs_search_cloudflare_documentation`）

### 6. Birthday Week 2026 功能

全部走 REST API + `CF_API_TOKEN`（不依賴 `env.AI` binding，本地 `npm run dev` 可測），並經過 `nkcf-gateway-01`。

- **Web Search**（`webSearch` chat 工具，「工具」開啟即註冊）：`POST /accounts/{id}/ai/websearch/`，provider `ceramic`（預設）/`exa`/`linkup`，前端在「工具」旁的下拉選單切換（localStorage `cf-demo-websearch-provider`），body 帶 `webSearchProvider`。需要 AI Gateway credits 或 BYOK，否則回 `web_search_payment_required` (402)
- **Clef Playground**（`/clef`）：`/api/clef` 並行呼叫 `@cf/cloudflare/clef`（27B，$0.24/M，64K）、`clef-flash`（9B，$0.038/M，**24K**）、`clef-omni`（30B MoE，$0.15/M，64K，支援 `audio`/`videos`），走 `gateway.ai.cloudflare.com/.../workers-ai/@cf/cloudflare/{model}`（帶 `cf-aig-skip-cache` 以免快取扭曲延遲比較），失敗退回 `/ai/run`。音訊/影片只送給 Clef-omni，其他模型回傳 `ignoredMedia`。Clef 是決策模型（noul/choice/score 機率），不產生文字，所以不放進模型選單
- **Clef 範例素材**：`public/clef-samples/`（來源與授權見 `CREDITS.md`；圖片/影片取自 Wikimedia Commons CC BY-SA / CC0，音訊為 macOS 台灣國語 TTS 合成的虛構劇本，詐騙簡訊截圖為自製）。情境與素材清單在 `src/app/pages/clef-presets.ts`（雙語），點情境會自動載入對應素材；音訊/影片情境只跑 Clef-omni。**帶圖片/音訊/影片的請求一律直接打 REST、不經 AI Gateway**——實測 Gateway 對大型 base64 body 會多花 20–35 秒（關 log 仍約 7 秒），Workers AI 本身不到 1.5 秒
- **Sandbox / Dynamic Worker 穩定性**（2026-10 實測後的修正）：
  - `max_instances` 曾被 5 個「存活數天到數月、沒有依 `sleepAfter` 休眠」的 container 佔滿，新 session 全部卡住直到逾時。現在 `workers/chat-sandbox` 每次請求會在 KV 記錄最後使用時間，cron 每 5 分鐘把閒置超過 25 分鐘的 sandbox `destroy()`（`reapIdleSandboxes`），並一次性清掉先前遺留的 `LEGACY_SANDBOX_IDS`；`max_instances` 提高到 10
  - `/api/chat` 一開始就用 `ctx.waitUntil(warmSandbox())` 呼叫 sandbox 的 `/api/warmup` 預先開機，冷啟動與模型思考時間重疊；工具逾時 55s、串流 idle 90s（工具逾時必須小於 idle 視窗）；colo 重擲上限 3→2
  - `executeJs`（`normalizeCode`）改用括號配對判斷程式形狀：以 `function fib(){}` 宣告開頭、後面接 `console.log(...)` 的腳本以前會被當成函式運算式包起來而 SyntaxError（"Unexpected identifier 'console'"），幾乎每個 DW 範例前 1–2 次都失敗
  - 預設模型改為 `claude-haiku-4-5`，2026-10-14 再換成 `claude-haiku-5-5`（Sandbox/DW 範例實測 6–10 秒；GLM 5.3 因推理過程不串流，同樣範例要 12–88 秒且變異大；gpt-oss-120b 約 8–20 秒，是不想用外部 provider 時的替代）
  - sandbox worker 的 `resolveSandboxId` 做 single-flight，app 端工具呼叫會等同 session 進行中的 warmup，避免兩邊同時 probe/re-roll 互相銷毀 container
  - **建議卡片第一次點擊會送出 `toolsEnabled:false`**（`setToolsEnabled(true)` 與送出在同一個 tick，closure 還是舊值），模型於是心算、完全不呼叫 sandbox——這就是「有時候沒有正確計算」的主因之一。現在用 `toolsEnabledRef` 同步更新
  - warmup 只在提示詞像是需要 sandbox（`SANDBOX_HINT`）或有附件時才觸發，並順便暖起 Python interpreter；`/api/warmup` 會記錄各階段耗時
  - 聊天訊息改用有序 `parts`（文字/推理/工具依實際發生順序顯示）；等待中顯示計時，工具執行中顯示秒數
- **介面語言**：預設繁體中文（不偵測瀏覽器語言），只記住使用者手動切換的語言，localStorage key `cf-demo-lang-v2`
- **Auto Router**：模型 `cf-auto`（provider `auto` → compat `cloudflare/auto`），送 `cf-aig-session-id`（session cookie + conversationId）與 `cf-aig-allowed-providers`（`[vars] AUTO_ROUTER_ALLOWED_PROVIDERS`，只列 gateway 有金鑰/額度的 provider）。回應 header `cf-aig-routed-model` 以 NDJSON `routed-model` 事件推給前端顯示 badge
- **AI Search 多模態**：instance `cf-demo-ai-search-mm`（嵌入 `@cf/qwen/qwen3-vl-embedding-2b`、`use_ocr: true`，R2 `cf-demo-crawler`），舊的 `cf-demo-ai-search` 保留作 fallback。`searchKnowledge` 改用 `/ai-search/namespaces/default/instances/{name}/search`；有貼圖時另外註冊 `searchKnowledgeByImage`（圖片不放進 `ToolSetConfig`，以免撐大 Code Mode token）

| 檔案 | 說明 |
|------|------|
| `src/lib/chat-tools.ts` | `buildWebSearchTool`、`aiSearchQuery`、`buildSearchKnowledgeByImageTool` |
| `src/app/api/clef/route.ts` | Clef / Clef-flash 並行呼叫、schema 驗證 |
| `src/app/pages/clef-playground.tsx` | Playground UI（預設情境、問題建構器、機率視覺化） |
| `src/app/(dashboard)/clef/page.tsx` | `/clef` 路由 |

### 7. MCP 卡控 Demo（Gateway + DLP 對 MCP tool call 卡控）

設計與實測紀錄：`docs/superpowers/specs/2026-10-13-mcp-guardrails-design.md`。

- 四條 Gateway HTTP 規則（名稱前綴 `MCP Demo:`，**預設停用、由簡報者在 Dashboard 開關**，App 不呼叫管理 API）都比對 upstream host `salesforce-mcp.neokung.work` + 自訂 DLP profile + `http.body_phase`：
  1. 工具層級：`sf_(create|update)_*` 寫入工具（upload）— rule `4c6f7183-708e-4fb8-abc3-3f3e18f75eaf`
  2. 動作層級：`"stage":"Closed…"` 結案商機（upload）— rule `e50d7a14-ae32-4b57-9911-ad63394a6c7f`；demo 商機 `006hg000001fNCzAAM`「MCP Demo 商機 (Spike)」
  3. 參數層級：SOQL `FROM Contact(s)/User(s)`（upload）— rule `5e050c10-4b80-4352-b691-79f36730d759`
  4. 回應 DLP：工具回應含 Email（download）— rule `0b3b9c32-c2dd-4318-8467-9388df53dfee`
- **Salesforce MCP worker 必須 `enableJsonResponse: true`**：Gateway DLP 不掃 SSE（`text/event-stream`）回應，否則場景 4 無效
- 被擋時 MCP client 收到：request 方向 `McpError -30403`（`data.rule_id` / `request_id`）；response 方向 `McpError -32603 Internal Error`（無 rule ID，只在 `saas` Portal 上解讀為「可能被攔截」）。`classifyMcpError()` 把它轉成 `{ blocked: true, … }` 工具結果，前端畫 🛡 卡片，system prompt 要求模型不要重試或繞過
- DLP regex 限制：Rust regex、無 lookaround、不能有無上限量詞（`+`/`*` 會回 3305）；word_list 每帳號只能 1 個（已被 SAP 規則使用）
- 規則啟用約 11 秒、停用約 30 秒生效
- 首頁建議改為可展開類別（含「MCP 卡控示範」）；聊天訊息下方顯示處理過程時間軸（`buildTimeline`）

| 檔案 | 說明 |
|------|------|
| `src/lib/mcp-guardrails.ts` | 場景資料、rule ID、`classifyMcpError`、`gatewayRuleUrl` |
| `src/lib/chat-timeline.ts` | 串流事件 → 處理過程步驟 |
| `src/app/components/chat/suggestion-categories.tsx` | 首頁可展開類別 |
| `src/app/components/chat/process-timeline.tsx` / `gateway-block-card.tsx` | 時間軸、攔截卡片 |
| `src/app/pages/mcp-guardrails.tsx` | `/mcp-guardrails` 政策說明頁 |

### 8. Agents Demo（通用型 Agent + Agent Tracing）

設計：`docs/superpowers/specs/2026-10-23-agents-tracing-demo-design.md`；計畫：`docs/superpowers/plans/2026-10-23-agents-tracing.md`；裁決紀錄：`.superpowers/sdd/2026-10-23-agents-tracing/progress.md`（R1–R32）。

同樣走 Vercel AI SDK v6 `streamText` + HTTP（不是 Agents SDK / Durable Objects），模型經 `nkcf-gateway-01` compat 呼叫 Workers AI（帶 `cf-aig-skip-cache: true`，延遲數字不被快取扭曲）。每次執行以 NDJSON 串流 span 事件（`src/lib/agents/trace-events.ts`），右側 Trace 面板即時畫 waterfall；同一組 span 也透過 Cloudflare Agents tracing 送到 Dashboard 的 Agents 分頁（`https://dash.cloudflare.com/5efa272dc28e4e3933324c44165b6dbe/agents`，官方文件連結格式為 `dash.cloudflare.com/?to=/:account/agents`；聊天頁的「在 Cloudflare 查看 Trace」按鈕即指向此處，常數 `AGENTS_DASHBOARD_URL` 在 `src/lib/agents/catalog.ts`）。

- **三個 Agent**（路由 `/agents/{agentId}`，sidebar「Agents ▸」）：

  | agentId | 模式 | 資料源 | Trace 形狀 |
  |---------|------|--------|-----------|
  | `knowledge-base`（企業知識庫） | RAG + 引用驗證 | AI Search instance `cf-demo-kb`（R2 bucket `cf-demo-kb`，資料夾 = 工作區） | `kb-agent` → 預先 `search_kb`（t=0）→ 答案（必要時再查一次）→ subagent `grounding-checker` |
  | `cloudflare-docs`（Cloudflare 文件專家） | Orchestrator + 並行研究 | Cloudflare Docs MCP（`search_docs`，每次搜尋各自一個無狀態請求 + KV 快取 1 h）＋ Browser Rendering `/markdown`（`read_doc_page`，僅 `developers.cloudflare.com`） | `docs-agent` → 預先 `translate_query` → `search_docs` → `rerank_results`（t=0）→ `research` → 並行 `docs-researcher` ×2–3（各自〔中文才 `translate_query`〕→ `search_docs` → `rerank_results` → 一次摘要）／或 `overview` |
  | `threat-intel`（資安情資） | 多位分析師並行 | Cloudflare Radar API（白名單工具、KV 快取 10 分鐘、span 屬性 `cache.hit`） | `threat-intel-agent` → `dispatch`（純程式關鍵字規則）→ 並行 Radar `prefetch` ＋ `brief` → `attack-analyst` / `network-analyst` / `bot-analyst` → root 一次模型呼叫 |

- **API**：`POST /api/agents/{agentId}`（NDJSON；body `messages`、`model`、`conversationId`、`workspace`、`storeContent`）。輸入上限：≤ 20 則訊息、每則 ≤ 8000 字、合計 ≤ 32000 字、role 只能 user/assistant 且最後一則是 user、`conversationId` ≤ 100 字且符合 `[\w-]+`，違反回 400。知識庫：`/api/agents/kb/{docs,upload,upload/presign,upload/complete,import-site,status}`。
- **知識庫**：`default/` 是唯讀範例工作區（虛構「雲朵科技」8 份文件，來源 `scripts/seed-kb/`，API 寫入回 `agents.kb.errors.readOnlyWorkspace`）；使用者工作區 `ws-xxxxxxxx/`（id 存 localStorage）。R29 上限語意：每工作區 20 檔只計頂層上傳（不含 `site/`），單檔 ≤ 10 MB；匯入網站每次 ≤ 30 頁，存到 `{ws}/site/{hostSlug}/{slug}.md`（重匯同一 host 只覆蓋該 host），import job 綁定工作區（KV `kb-import:{jobId}`，TTL 1 h），完成後重複查詢為冪等。
  - **上傳走 presigned URL 直傳 R2**（2026-10）：production 的 zone WAF（managed/OWASP body inspection）會對含二進位 stream 的 multipart PDF 回 **Managed Challenge（403 HTML）**，根本到不了 Worker（400 B 純文字 PDF 200、64 KB 含 binary stream 的 PDF 403、3 MB markdown 200），前端解析 JSON 失敗就顯示「伺服器發生錯誤」。zone WAF 不能改 → UI 改成 `POST /upload/presign {workspace,name,size,type}`（沿用 `requireWritableWorkspace` / `validateUpload` / `safeUploadName` + 撞名後綴，content-type 由副檔名決定，不信任 client）→ 瀏覽器 `PUT` 到 `https://{account}.r2.cloudflarestorage.com/cf-demo-kb/{key}`（`presignPut`，`src/lib/r2-s3.ts`，SigV4 query 簽章、`UNSIGNED-PAYLOAD`，簽 `content-length;content-type;host`，5 分鐘）→ `POST /upload/complete {workspace,key}`（key 必須在 `{ws}/` 頂層、不在 `site/`、不含 `..`；以 R2 REST list 確認物件存在後觸發 sync，回 `{key,size,indexJobId,syncPending}`）。順便繞過 Next middleware 的 10 MB body 緩衝。bucket `cf-demo-kb` 的 CORS 允許 `https://demo.neokung.work`、`http://localhost:3000`、`http://localhost:3100` 的 `PUT`（header `content-type`，expose `ETag`）——**換網域或本地 port 要同步改 bucket CORS**。舊的 multipart `/upload` 仍可用但 UI 不再呼叫。前端把非 JSON / HTML 回應（WAF challenge）顯示為 `agents.kb.errors.blockedByWaf`，R2 PUT 失敗為 `agents.kb.errors.storage`（`readKbResponse` / `kbFailureKey`，`ui-helpers.ts`）。
  - **Sync cooldown 重試**：AI Search 在上一次 sync 後短時間內 `POST …/jobs` 會回 `7020 sync_in_cooldown`，而 instance 的排程 sync 間隔是 6 小時 → cooldown 期間上傳的檔案會好幾個小時沒被索引。`kbTriggerSync` 回 `{ jobId, cooldown }`（7020 視為 cooldown，不是錯誤）；`GET /status?workspace=` 在使用者工作區有檔案不是 `completed`（或還不在 items 清單）且上次嘗試（KV `kb-sync-attempt:{ws}`，TTL 600 s）超過 60 秒時再觸發一次，回 `syncPending` / `syncTriggered`。UI 本來就會退避輪詢 status，所以會自動重試到 sync 被接受為止。`default` 工作區不會觸發。
  - AI Search 設定：`query_rewrite` **關閉**（R24：中文查詢被改寫成英文後分數低於 0.4，0 筆）；instance 結果快取 **關閉**（R25：避免上傳未索引完時的空結果被快取兩天）。
  - 索引實測 86–573 秒、偶發 `workers_ai_timeout_error`，每檔狀態「僅供參考」（R26，item 可能卡 `running` 但已可搜尋）→ UI 文案以「會前準備工作區」為主。狀態輪詢：空工作區不輪詢；有未完成檔案時 10 → 20 → 40 → 60 秒退避；上傳 / 匯入完成後重新開始。
  - 引用驗證（R30）：`grounding-checker` 只檢查**最後一個有文字的 root 步驟**（`AgentDef.after` 的 `finalText`），不含開頭的計畫句。
- **模型**（`src/lib/agents/models.ts`；選單選擇套用到 root，subagent 一律用 `noThink()` 版本：`kimi-k2.6-thinking` → `kimi-k2.6`、`glm-5.3` → `glm-5.3-flash`，其他不變）：預設一律 **GLM 5.3 Flash**（`glm-5.3-flash`，三個 agent 的 `defaultModel` 與所有 subagent 的 `model` 預設；2026-10 使用者要求，取代 R14/R20 的 Kimi K2.6 no-think 預設）；主 agent 先寫一句計畫再呼叫工具（R16）。選單另有 Kimi K2.6（no-think，`reasoning_effort: "none"`）、「Kimi K2.6（顯示思考過程）」（思考 token 0.6–1 s 開始串流，但正文要多等約 40 秒）、GLM 5.3（推理無法關閉且不串流）。選單每項（與 trigger、Trace 面板的模型 badge）只顯示 provider logo + 模型名稱（`AgentModel.iconUrl`：GLM `/zai.svg`、Kimi `/moonshotai.svg`，與主聊天的模型選單相同），不顯示首字延遲提示。Kimi 只能用 `reasoning_effort: "none"` 關思考（`enable_thinking=false` 無效）。
- **Radar `location` 語意**（工具回傳都帶 `scope`，system prompt 要求照 `scope` 描述）：

  | 端點 | `location=TW` 的意思 |
  |------|---------------------|
  | `attacks/layer7/summary/*`、`attacks/layer7/timeseries` | 攻擊**來源**是台灣（源自台灣、被擋下的應用層攻擊） |
  | `attacks/layer7/top/locations/origin` | 攻擊**台灣**的請求來自哪些國家 |
  | `attacks/layer7/top/locations/target` | 源自台灣的攻擊打向哪些國家 |
  | `attacks/layer3/*` | 在**台灣資料中心**緩解的網路層攻擊 |
  | `attacks/*/top/industry` | 被攻擊客戶的產業；工具一律不帶 `location`，只回全球排名 |

  陷阱：`attacks/layer7/summary/...?industry=` 會被靜默忽略（工具不提供 industry 參數）；數字都是占比或 0–1 正規化值，不是次數。
- **Tracing 設定**：
  - `wrangler.toml` `[observability.traces] enabled = true`、`head_sampling_rate = 1`。
  - `agents/observability/ai` 在模組頂層 import `cloudflare:workers`，`next dev` / `next build` / OpenNext esbuild 都解析不了 → `getTracedAI()`（`src/lib/agents/tracing.ts`）先用**變數路徑動態 import** `cloudflare:workers` 存到 `globalThis.__CF_WORKERS__`，再動態 import `wrapAISDK`；`next.config.mjs` 的 server webpack externals 把 `cloudflare:workers` 對應到 `var (globalThis.__CF_WORKERS__ || {})`。任何一步失敗就退回原生 `ai`，並 `console.warn("agents tracing disabled: …")`（每個 isolate 一次）。
  - 本地 tracing：`next dev`（Node）沒有 `cloudflare:workers`，tracing 為 noop；wrangler 升到 4.152 後，本地 workerd（`opennextjs-cloudflare preview`）已有 `tracing` export（`traced: true`），但 span 只有 production 才會送進 Dashboard Agents 分頁。`run-start` 事件帶 `traced`，Trace 面板顯示「Cloudflare tracing：已啟用 / 未啟用（本地）」。
  - `experimental_telemetry`：`functionId`（`kb-agent`、`docs-researcher`…）、`metadata.agentId = {functionId}-demo`、`conversationId`（同一對話 = 一個 session）、`model`、`workspace`（有時）。「記錄內容」開關關閉時 `storeMessages/storeTools: false`。使用者按停止不記成 span exception（idle timeout 與真正錯誤才記）。
  - Traces 保留 7 天；**2026-12-01 起計入 Cloudflare Observability 的 ingestion / storage 計費**。
- **TTFT 定義**（不要混用）：
  - chat span 的 `ttftMs`：從該步驟**送出模型請求**（`prepareStep`，R22）到第一個 delta，包含上游排隊時間。
  - run 的 `ttftMs`（伺服器首字）：從 run 開始到 **root agent** 第一個可見 token（含推理 token；subagent 的輸出不算）。
  - 前端指標：「首個事件」（送出 → 第一個 NDJSON 事件）、「首個思考 token」（任何 span 的第一個 reasoning-delta）、「首字」（第一個 root 答案文字）。
- **即時進度設計**：伺服器把 text/reasoning delta 依（span, 類型）合併、每 75 ms 送一次（其他事件前會先 flush，順序不變）；`execute_tool` span 在 `tool-input-start`（模型還在寫參數）就開始，工具晶片立即出現；chat span 在請求送出時就開（沒有 delta 前顯示「等待 Workers AI 模型回應 Ns」）；聊天中每輪有 activity timeline（思考中秒數、工具晶片與參數預覽、subagent 卡片串流其思考 / 文字尾巴）。
- **精簡流程（2026-10 速度修正）**：
  - **Prefetch**（`AgentDef.prefetch`，runAgent 在 root span-start 後立刻同步呼叫）：用使用者問題跑一次確定性搜尋，以 `runTracedTool` 產生 `{root}/prefetch` 工具 span（~0.3 s 內出現晶片、發出 citations），工具從 `ctx.prefetched` 取用。文件專家是 `background`（不擋 root 第一次模型呼叫，`overview()` 會等它）；知識庫是 `await`（AI Search 約 1–3 s，結果與 [1..n] 編號放進 root 第一次呼叫的 system prompt，通常一步就答；後續 `search_kb` 的編號接續，計數器放在 `ctx.scope`；`after` 收到的 toolResults 會先放 prefetch，所以 grounding-checker 看得到）。資安情資的 Radar prefetch（現在屬於 dispatcher 流程、整體 `await`，見下方「資安情資 dispatcher」）：依問題關鍵字挑**一個** Radar 工具（攻擊/DDoS/WAF/駭客 → `attackers_of`，有「上週/比較/變化」就加 `compareLastWeek`；機器人/爬蟲 → `bot_vs_human`；斷網/中斷/BGP/劫持/網速/品質 → `outages`；其他 → `attackers_of`；地區預設 TW，認得日本/美國/新加坡/香港/韓國/中國等，`src/lib/agents/tools/radar-prefetch.ts`），在 t≈0 以 `{root}/prefetch` 工具 span 執行（晶片與圖表約 2 秒內出現，圖表事件的 `spanId` 就是該工具 span）；分析師在 `prepare` 等它（≤ 5 s），並把結果摘要（`prefetchSummary`）放進 prompt，告知「已預先取得，相同工具與參數不要再呼叫」。分析師 `maxSteps: 3`：第一步一次並行呼叫所有需要的 Radar 工具，再寫 ≤ 150 字的發現；root 最終答案 ≤ 350 字文字 + 至多一個精簡表格 + Radar 來源連結（輸出長度是延遲大宗）。
  - **資安情資 dispatcher（2026-10，取代 root 規劃步驟）**：以前 root step 0 要先寫計畫句再呼叫 `brief` 挑分析師（一整輪模型 + 排隊）。現在 `planDispatch(question)`（`src/lib/agents/tools/threat-dispatch.ts`，純函式）用關鍵字決定分析師：attack = 攻擊/DDoS/WAF/駭客/威脅/來源國家；network = 斷網/中斷/outage/BGP/劫持/網速/品質/ISP；bot = 機器人/爬蟲/bot/AI crawler/郵件/email/釣魚/網域排名/domain rank；問題中出現網域（`^[a-z0-9.-]+\.[a-z]{2,}$`）→ bot（domain_rank）；都沒有 → attack；可多選，`location` / `compareLastWeek` 沿用 `prefetchLocation` / `COMPARE_RE`。`prefetchMode: "await"`：t=0 `dispatch` 工具 span → 並行跑單一 Radar prefetch（`{root}/prefetch`）與確定性的 `brief` 工具 span（`{root}/brief`，底下是分析師 invoke_agent span）。分析師立刻開始，在自己的 `prepare` 裡最多等 5 秒（`PREFETCH_WAIT_MS`）拿 prefetch 摘要，超過就自己查。分析師報告（含 failed）＋ Radar 摘要放進 root 的 system prompt；root `maxSteps: 1`、沒有工具，只寫最終答案（不寫計畫句）。root 只有一個 chat span。
  - **文件專家**：root step 0 寫一句計畫（R16）＋呼叫 `research({questions: 2–3})`（比較 / 多面向）或 `overview()`（簡單問題，回傳 prefetch 結果）；`read_doc_page` 保留但不鼓勵；root 不再有 `search_docs`，`maxSteps` 3。`docs-researcher` = `SubagentDef.prepare` 在自己的 invoke_agent span 裡跑一次 `search_docs`（`…/search` 工具 span）→ 一次無工具的模型摘要（maxSteps 1）。`research` 結果也附上 overview。依序等待約 3 次模型呼叫（以前 10+ 次）。
  - **文件查詢翻譯 + 結果壓縮（2026-10）**：`src/lib/agents/tools/docs-query.ts`。`translateDocsQuery(text)`（純程式、無 LLM）用詞彙表把中文詞對到官方產品名稱 / 英文關鍵字（邊緣運算/無伺服器→Workers、物件儲存→R2、資料庫→D1、鍵值→Workers KV、零信任→Zero Trust、隧道→Cloudflare Tunnel、限制→limits、價格→pricing、如何→how to…），保留原有的拉丁字詞，回 `{query, products}`；兩個以上產品的比較會寫成 `A vs B`——docs 搜尋是有門檻的語意搜尋，`Workers Pages comparison vs which to choose new project` 0 筆、`Workers vs Pages for a new project` 20 筆（2026-10-24 實測），翻譯後 0 筆就在同一個 search span 內用原文再查一次（`fallbackQuery`）。prefetch 一律翻譯（`{root}/translate` span），研究員只有子問題含 CJK 才翻譯；root prompt 要求子問題用英文 + 官方產品名稱。`compressDocsHits(ctx, query, hits, topK=3)` 用 Workers AI `@cf/baai/bge-reranker-base`（REST `/ai/run`，`CF_API_TOKEN`，逾時 10 s）重新排序，留前 3 筆、snippet ≤ 700 字（以第一個查詢關鍵字為中心），`rerank_results` span 輸出 `{kept, dropped, topScores, reranked, urls}`；reranker 失敗就退回前 3 筆（`fallback`），不會讓 run 失敗。**引用只送保留下來的 3 筆**（citation 的 `spanId` 是 rerank span），被丟掉的不出現在 UI 引用清單。為了讓壓縮器有完整文字可取窗，`parseDocsSearchResult` 的 snippet 上限 600 → 2000，KV 快取 key 改 `docs-search:v2:`；模型可呼叫的 `search_docs` 工具仍截 600。實測 docs-researcher 每次輸入約 0.7k token（以前約 6.5k）。
  - **R15 已推翻**：以前整個 run 共用一條 MCP session，並行研究員的呼叫在同一 session 上排隊，後面的撞 20 s 逾時。現在每次搜尋是一個獨立的無狀態 JSON-RPC `tools/call` POST（server 接受、不需 initialize；4xx 時退回自己的短命 MCP client），逾時 25 s 並綁 `ctx.signal`，網路錯誤 / 5xx 重試一次；結果存 KV `docs-search:v2:{正規化查詢}`（TTL 3600 s，太長的 key 用 SHA-256），KV 失敗就直接查，span 屬性 `cache.hit`。
  - **`runTracedTool`**：確定性工具的 NDJSON span（start + input 同步送出、end 帶 input/output 或 error），同時用 `tracing.enterSpan`（沒有就 `startActiveSpan`）開 Cloudflare 自訂 span `execute_tool {name}`，屬性 `gen_ai.operation.name/tool.name/tool.call.id`，記錄內容時加 `gen_ai.tool.call.arguments/result`（≤ 8 KB）。注意：研究員的 search span 在 Cloudflare 端位於 research 工具 span 底下、研究員 agent span 之前（wrapAISDK 在 streamText 時才開 agent span）。
  - **Kimi 工具呼叫標記外洩**：`toolChoice: "none"` 時 Kimi 有時把 `<|tool_calls_section_begin|>…` 當文字寫出來。`markup-filter.ts` 的串流過濾器（只暫存不完整的 `<|` 前綴）套用在每個 text / reasoning delta，所以 UI、subagent 輸出與 `finalText` 都不含標記；subagent 的最後強迫步驟（R23，有過工具回合時）另外附一則 user 訊息「tools are disabled… write your finding now」。
  - **Hedged requests**（`gateway.ts` `hedgedFetch`，只用在串流 chat completions）：送 A；2.5 s（`HEDGE_AFTER_MS`）內沒有第一個 body chunk 就送一模一樣的 B（同一個 init：`cf-aig-*` header 與 `reasoning_effort` body），先送出 chunk 的勝、另一個 abort；4xx 立即回傳不 hedge；A 在計時前失敗就立刻送 B；都失敗回最後一個錯誤；呼叫端 abort 兩個都取消。回應 header `x-agents-hedge: a|b`、`x-agents-hedge-fired: 0|1` → chat span-end `detail.hedge`；span 屬性 `hedge.fired` / `hedge.winner`；觸發時 `console.log("[agents] hedge fired …")`。
  - **UI**：chat span 開著但還沒有任何 delta 時顯示「等待 Workers AI 模型回應 Ns」（取代「規劃中」）；研究員卡片先顯示搜尋晶片，再「等待…」→「模型摘要中」。
  - **實測瓶頸（2026-10-23）**：`nkcf-gateway-01` 開了 Guardrails（prompt S1–S13、P1 FLAG）與 DLP（PII，REQUEST）。同一個 Kimi 請求直連 Workers AI REST 首字 0.5–1.5 s，經 Gateway（compat 或 workers-ai 端點）2–44 s，且串流有時只有每秒數個 token；hedge 幾乎每次都觸發，因為兩個請求都要過 Guardrails。文件專家整體仍約 100–130 s，大部分是 Gateway 等待。
- **回答語言一致**：`userLanguage(text)`（`src/lib/agents/language.ts`，含任何 CJK 字元 → `zh-TW`，否則 `en`）由 `runAgent` 存成 `ctx.userText`，研究員（`docs-researcher`）與分析師依此用使用者的語言寫發現（翻譯英文文件）；三個 root 的 system prompt 都要求完全用使用者語言作答、翻譯發現、不貼未翻譯段落，產品名稱 / 程式碼 / 網址保持原樣。
- **引用驗證的略過規則**：`AgentDef.after` 多了 `finalFinishReason`（最後一個 root 步驟的 finish reason）。`kbAgent.after` 在 `finalFinishReason === "tool-calls"`（撞到 step 上限、`finalText` 只是計畫句）或 `finalText` 不含 `[n]` 且短於 60 字時不跑 `grounding-checker`（`shouldCheckGrounding`），避免誤報。
- **子代理重試不重複顯示**：R32 重試後，失敗那次（span `status: "error"`，不含 root）底下工具發出的圖表與引用不再顯示（`visibleOutputs` / `failedAttemptSpanIds`，`ui-helpers.ts`；`trace.citations` 現在帶 `spanId`）。
- **逾時與重試**：模型串流 idle：root 60 s、subagent 45 s（步驟第一個 part 前 150 s，工具執行中暫停，R13）；最後一個允許的步驟關閉工具，強迫作答（R23）。subagent 在 idle / 串流錯誤時**自動重試一次**（新 span `…:{index}r`，失敗的 span 保留 error；R32），root agent 不自動重試；失敗或中止的回合在 UI 有「重試」按鈕（同問題、同設定），歷史只帶成功回合的最終步驟並去掉 `[n]` 引用標記。
- **安全**：Agent 回答用 `MarkdownRenderer allowHtml={false}`（不渲染 raw HTML；markdown 圖片不載入，http(s) 圖片改成 🖼 連結，其他只顯示文字，防止透過圖片 URL 外洩資料）。
- **`enable_request_signal` 相容性旗標**（`wrangler.toml` / `wrangler.dev.toml`）：讓 workerd 在用戶端斷線時觸發 `request.signal`，route 把它接到 run 的 AbortController → 按「停止」或關掉頁面會在伺服器端取消模型呼叫與工具（另外 response stream 的 `cancel()` 也會中止）。旗標名稱已在 workerd 與官方文件確認；OpenNext 是否把它傳到 `NextRequest.signal` 需在 production 確認（本地 `next dev` 跑在 Node，本來就會觸發）。
- **OpenNext 與 Next 15 支援期限**：`@opennextjs/cloudflare@1.18.0` 依日期判斷支援（Next 15 發布滿 2 年後，自 2026-10-21 起）拒絕 build `next@15.5.14`（`Next.js version 15.5.14 is not supported`），只有 CLI 旗標 `--dangerouslyUseUnsupportedNextVersion` 能繞過（沒有環境變數 / 設定檔選項）。CI 是 Workers Builds，build 指令在 Dashboard 設定（`CF_API_TOKEN` 沒有 Builds 權限，無法用 API 改）→ 需在 Dashboard 的 build 指令加上此旗標，或另外升級 Next 16。這會影響**每一次** push 到 main。

| 檔案 | 說明 |
|------|------|
| `src/lib/agents/runtime.ts` | `runAgent` / `runSubagent`（含重試）/ `runParallel`、`pipeStepStream`（stream → span 事件、idle 計時）、emit wrapper（delta 合併、span 樹維護）、`toolSpanId` |
| `src/lib/agents/tracing.ts` | `getTracedAI()`、`isTracingActive()`、`setActiveSpanAttributes` / `recordActiveSpanException` |
| `src/lib/agents/trace-events.ts` / `trace-tree.ts` | NDJSON 事件型別與解析、前端 reducer（span 樹、waterfall rows） |
| `src/lib/agents/models.ts` / `gateway.ts` | 模型清單（client-safe）、AI Gateway compat provider |
| `src/lib/agents/request.ts` | `/api/agents/{agentId}` 輸入上限檢查 |
| `src/lib/agents/kb.ts` / `kb-route.ts` | 工作區、上傳驗證、AI Search 搜尋 / 狀態、R2 列表（`per_page=1000` + cursor，最多 5 頁） |
| `src/lib/agents/defs/{knowledge-base,docs,threat-intel}.ts` | 三個 agent 與其 subagent 設定 |
| `src/lib/agents/tools/{kb,cf-docs,radar}.ts` | 真實資料源工具（Radar 為白名單包裝） |
| `src/lib/agents/ui-helpers.ts` | 索引狀態、輪詢退避、引用分組、Radar 圖表資料 |
| `src/app/api/agents/[agentId]/route.ts`、`src/app/api/agents/kb/*` | 執行 agent、知識庫 API |
| `src/app/(dashboard)/agents/[agentId]/page.tsx`、`src/app/pages/agent-chat.tsx` | 路由與共用聊天頁 |
| `src/app/components/agents/*` | `use-agent-run`（串流 + 重試）、`agent-message`、`activity-timeline`、`trace-panel`、`span-detail`、`kb-workspace`、`radar-chart` |
| `src/i18n/agents.{zh-TW,en}.json` | Agents 專用字串（`agents.*`，R28；不要改 `src/i18n/{zh-TW,en}.json`） |
| `scripts/seed-kb/` | `default/` 範例文件與上傳腳本 |

## 技術棧

- **前端**: React 19 + Vite + Tailwind CSS 4 + shadcn (new-york style)
- **後端**: Cloudflare Workers
- **AI**: Workers AI via `workers-ai-provider` + Vercel AI SDK (`ai`) + AI Gateway
- **MCP**: `@modelcontextprotocol/sdk` v1.32.1
- **RAG**: AI Search (AutoRAG) 索引 R2 爬蟲資料
- **路由**: React Router v7
- **框架整合**: OpenNext for Cloudflare (`@opennextjs/cloudflare`)
- **部署**: Git push 觸發 CI/CD（見「部署注意事項」）

## UI/UX 規範

- 使用 shadcn 元件庫
- Sidebar 導航：AI Agent、網站爬蟲（含子功能）、Log 瀏覽器
- **Responsive 設計**：桌機完整 Sidebar、手機 Sheet 側滑
- 支援 Dark Mode（Header 切換）
- 繁體中文為主要語言

## 參考專案

- **AI 聊天 UI**: `/Users/neokung/Documents/tce-app/src/app/(dashboard)/tcegpt/chat-interface.tsx`
- **Browser Rendering 介接**: `/Users/neokung/Desktop/CF-Demo/browser-rendering-demo/workers-browser-rendering/src/index.ts`
- **Sidebar 模式**: `/Users/neokung/Documents/tce-app/src/components/app-sidebar.tsx`

## 部署注意事項

### 部署流程
- **正確部署方式**：`git commit` → `git push`，由 CI/CD 自動執行 `opennextjs-cloudflare build && opennextjs-cloudflare deploy`
- **絕對不要**直接執行 `npx wrangler deploy` 或 `npm run deploy`，這會用本地舊的 `.open-next/` 產物覆蓋 CI/CD 部署的最新版本
- 本地 `npm run build` 只是 `next build`，不會產生 `.open-next/` 產物；`opennextjs-cloudflare build` 才會

### Secrets 管理
- `.dev.vars` 中存放本地開發用的 secrets（`CF_API_TOKEN`, `CF_AIG_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`）
- Production secrets 透過 `wrangler secret put <NAME>` 設定，與 `.dev.vars` 的值必須一致
- 如果 production 出現 `Authentication error` (code 10000)，優先檢查 Worker secret 是否與 `.dev.vars` 一致，用 `wrangler secret put` 重新設定
- `wrangler secret list` 可查看已設定的 secrets 清單

### 環境設定
- 確保 `account_id` 設定為 `5efa272dc28e4e3933324c44165b6dbe` (Neo-Cloudflare)
- `wrangler.toml` 的 `[vars]` 放非敏感環境變數，secrets 絕不放在 `[vars]`
- `wrangler.dev.toml` 用於本地開發，不含 `[ai]` binding（會影響 edge-preview proxy）
- `wrangler.toml` 設了 `[placement] region = "aws:ap-northeast-1"`（東京）：中華電信行動（AS17421）等 ISP 有時會把台灣使用者路由到 **HKG**，Worker 與 AI Gateway 就從香港呼叫 Anthropic，而香港不在 Anthropic 支援地區 → `403 forbidden: Request not allowed`（2026-10-14 實測：HKG 0/6 成功、TPE 75/76 成功；Workers AI 模型不受影響）。不要拿掉 placement，也不要改成 `aws:ap-east-1`（香港）

## 協作規範

- **不要自動 push 到 remote**：除非使用者明確說「push」，否則只做本地 commit，不執行 `git push`
- **不要直接 wrangler deploy**：部署只能透過 git push 觸發 CI/CD，禁止本地直接 `wrangler deploy` 或 `npm run deploy`
- **不要建立不必要的檔案**：避免建立 debug endpoint、臨時測試檔等，如果建了必須立即清除
- **修改後先驗證**：改完程式碼後，先在本地 `npm run dev` 測試，確認功能正常再 commit
