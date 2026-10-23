# Agents Demo（通用型 Agent + Agent Tracing）設計

狀態：**v3，待審 spec**（尚未實作）
日期：2026-10-23
變更紀錄：
- v1：三個產業情境（電商 / 保險 / 製造），用寫死的假資料 → 捨棄（客戶一問劇本外的問題就破功）。
- v2：改成接真實資料源的通用型 agent。
- v3：第三個 agent 由「網站健檢」改為「資安情資（Radar）」；記錄已決定事項。

## 1. 目標（使用者需求）

| # | 需求 | 本設計如何滿足 |
|---|------|----------------|
| 1 | Sidebar「MCP 卡控」下方新增 **Agents**，內含三個 agent | 「功能」群組新增可展開的「Agents」項目，三個子頁面 |
| 2 | 所有 log 都要能在 **Agent tracing** 看到 | 開啟 `observability.traces`，用 `wrapAISDK()` + custom spans，Agents 分頁可看到 session / turn / tool / subagent |
| 3 | 一律呼叫 **Workers AI**（GLM 5.3、Kimi K2.6 等） | 只用 `workers-ai/@cf/...`，經 `nkcf-gateway-01` compat 端點 |
| 4 | 回應要快，**TTFT 與完整 end-to-end trace 要顯示在畫面上** | 伺服器在串流中送出 span 事件，前端即時畫出 waterfall + TTFT 指標；並附「在 Cloudflare Dashboard 查看」連結 |
| 5 | UI 全用 **shadcn**，仿一般 agent 聊天模式 | 左聊天 / 右 Trace 面板，手機版 Trace 收進 Sheet |
| 6 | **通用**：不用為每個客戶調整 | 每個 agent 都接**真實資料源**；客戶自己的資料可以現場帶進來（上傳檔案 / 匯入網站） |

## 2. 已決定事項

| 項目 | 決定 |
|------|------|
| 三個 agent | 企業知識庫、Cloudflare 文件專家、資安情資（Radar） |
| 架構 | 方案 A：沿用 Next.js API route + AI SDK v6 + `wrapAISDK`，不用 Agents SDK / DO / WebSocket |
| 知識庫儲存 | 新建 R2 bucket `cf-demo-kb` + AI Search instance `cf-demo-kb`（不沿用 `cf-demo-crawler`） |
| 範例工作區 | 虛構台灣公司「雲朵科技」的內部文件 |
| 分支 | 建在 `feat/mcp-guardrails` 之上（新分支 `feat/agents-tracing`） |
| 取樣 | Tracing 100% 取樣（`head_sampling_rate = 1`） |

## 3. 研究結果（已實測 / 已查證）

### 3.1 Agent tracing（[官方文件](https://developers.cloudflare.com/agents/runtime/operations/observability/tracing/)）

- 開啟方式：wrangler 加 `[observability.traces] enabled = true`。
- 每個 turn 的 span 結構：`invoke_agent` → `chat {model}` / `execute_tool {tool}` → `tool_approval`；**subagent 會自動掛在呼叫它的 span 底下**（依 async context）。
- 直接用 AI SDK 的專案：`wrapAISDK(ai)`（`agents/observability/ai`），支援 **AI SDK v6**（本專案 `ai@6.0.141`），自動 instrument `streamText` / `generateText`。v6 身分透過 `experimental_telemetry: { functionId, metadata: { agentId, conversationId } }` 傳入。
- `wrapAISDK(ai, { storeMessages: true, storeTools: true })` 才會記錄訊息與工具參數 / 結果（預設不記）。
- Dashboard **Agents** 分頁：agent 清單（model、session 數、runs、tokens）、**Session replay**、**Trace waterfall**，可「View in Observability」看完整 Worker trace。
- 自訂 span：`import { tracing } from "cloudflare:workers"`，`tracing.enterSpan(name, cb)`、`startActiveSpan()`（串流用，需手動 `span.end()`）、`setAttribute(s)`、`recordException`。每個 span 約 64 KB 屬性上限；**目前無法取得 trace/span ID（`spanContext()` 尚未提供）**→ 無法從畫面直接 deep-link 到某一筆 trace。
- 保留 7 天；**2026-12-01 起計入 Cloudflare Observability 的 ingestion/storage 計費**。
- `agents@0.30.0` 有 `./observability/ai` export（專案尚未安裝 `agents`）。

### 3.2 模型實測（REST 串流，提示詞「三句話說明悠遊卡怎麼加值」）

| 模型 | 設定 | 首字 (TTFT) | 總耗時 | 備註 |
|------|------|-------------|--------|------|
| `@cf/zai-org/glm-5.3-flash` | `reasoning_effort: "low"` | **0.8–2.8 s** | **1.9–4.6 s** | 最穩、最便宜（$0.15 / $0.50 per M） |
| `@cf/moonshotai/kimi-k2.6` | `reasoning_effort: "none"` | 0.7–8.8 s | 4.1–11.7 s | 多數 < 3 s，偶有排隊 |
| `@cf/moonshotai/kimi-k2.6` | 預設（思考開啟） | 思考 token 0.6–1 s；正文 16–25 s | 19–29 s | 思考過程**會串流** |
| `@cf/zai-org/glm-5.3` | `reasoning_effort: "low"` | 1.0–36 s（變異極大） | 2.6–38 s | 推理**無法關閉且不串流** |
| `@cf/zai-org/glm-5.3` | 預設 (`max`) | 26–101 s | 31–107 s | 不適合即時 demo |

- Kimi 要用 `reasoning_effort: "none"` 才關得掉思考（`chat_template_kwargs.enable_thinking=false` 無效）。
- 經 **AI Gateway compat** 時 `reasoning_effort` 正確傳遞；**工具呼叫正常**（Kimi K2.6 約 2.7–4.1 s、GLM-5.3-flash 約 3.5–4.7 s 吐出 `tool_calls`）。
- `max_tokens` 太小時推理模型會把額度用光在思考 → 每個 agent `max_tokens` ≥ 2000。

**模型策略**：互動回覆與 subagent 用 GLM-5.3-flash；orchestrator（拆題、彙整）用 Kimi K2.6 no-think；GLM-5.3 / Kimi 思考模式只放在模型選單當「推理模型對照」，標示「首字較慢」。

### 3.3 資料源盤點

| 資料源 | 現況 |
|--------|------|
| AI Search `cf-demo-ai-search-mm`（R2 `cf-demo-crawler`） | 只有約 10 筆零散爬蟲結果（旅行社、iThome、Wikipedia），且含導覽列雜訊 → 不適合當知識庫，改新建 `cf-demo-kb` |
| Cloudflare Docs MCP `https://docs.mcp.cloudflare.com/mcp` | 公開、免認證；工具 `search_cloudflare_documentation`、`migrate_pages_to_workers_guide`；專案已有 `src/lib/mcp-client.ts` |
| Browser Rendering REST | 爬蟲功能已在用 |
| AI Search 同步 | `src/app/api/crawler/save-to-r2/route.ts` 已會呼叫 `.../ai-search/instances/{name}/jobs`，可沿用 |
| Radar API | 現有 `CF_API_TOKEN` 可讀，實測見 3.4 |

### 3.4 Radar API 實測（2026-10-23，`location=TW`）

| 端點 | 耗時 | 實測內容 |
|------|------|----------|
| `attacks/layer7/summary/mitigation_product` | 0.9–1.0 s | WAF 88.4% / DDoS 8.6%；加 `dateRange=7d&dateRange=7dControl` 可**週對週比較**（上週 DDoS 32.1%） |
| `attacks/layer7/top/industry` | 0.9 s | 電腦軟體 26.2%、IT 服務 12.8%、零售 10.8% … |
| `attacks/layer7/top/locations/origin` | 0.6 s | 美 22.6%、中 5.8%、新加坡 5.8%、荷蘭 5.1% … |
| `attacks/layer7/summary/http_method` | 1.2 s | GET 85.6% / POST 11.4% |
| `attacks/layer7/timeseries` | 1.1 s | 每日序列，**值為 0–1 正規化**，不是次數 |
| `attacks/layer3/summary/vector` | 0.7 s | GRE Flood 87.2%、SSDP 4.1%、Mirai 4.0% … |
| `annotations/outages` | 0.5 s | 台灣歷史事件（例：2024-04-03 花蓮地震影響行動網路）；**不帶 `dateRange`** 才查得到舊事件 |
| `traffic_anomalies` | 0.6 s | 近 28 天台灣無異常（回傳空陣列，agent 要能說「無」） |
| `bgp/hijacks/events?involvedCountry=TW` | **4.2 s** | 有台灣 ASN 相關事件 |
| `http/summary/bot_class` | 1.4 s | 人類 66.9% / 機器人 33.1% |
| `ai/bots/summary/user_agent` | 1.8 s | ClaudeBot 14.8%、Googlebot 10.6%、Bingbot 5.1% … |
| `quality/speed/summary` | 0.6 s | 下載 112 Mbps、上傳 36 Mbps、閒置延遲 34 ms |
| `email/security/summary/malicious` | 0.5 s | 惡意郵件 7.7%（全球） |
| `ranking/domain/{domain}` | 0.5–0.7 s | 例：`cloudflare.com` 第 4 名；小網域只回 bucket（如 top 50,000） |

**陷阱（必須在工具層防範）**：
1. `attacks/layer7/summary/...?industry=Banking` **會被靜默忽略**，回傳的是全台數字 → 不能宣稱「台灣金融業被攻擊 X%」。產業只能用 `top/industry` 的排名回答。
2. 所有數字是**占比（%）**或**正規化值**，不是絕對次數。
3. `location` 在不同端點代表「來源」或「目標」的語意不同（例：`top/attacks?location=TW` 回傳的是「從台灣發出」的攻擊）→ 工具包裝層要用明確的參數名稱（`targetLocation` / `originLocation`），Spike 時逐一確認。

## 4. 三個 Agent

設計原則：
- **資料一定是真的**；問到資料裡沒有的東西，明確說「查無資料」，trace 裡看得到「檢索 0 筆」或「API 回傳空陣列」。
- **客戶的資料可以現場帶進來**（Agent 1），或**根本不需要客戶資料**（Agent 2、3）——都不用為客戶改程式。
- 三種不同的 agent 模式，trace waterfall 長得明顯不同。
- subagent 可重用（見第 5 節）。

### Agent 1 —「企業知識庫」Agent（RAG + 引用驗證）

**能幫客戶做什麼**：員工問 HR / IT / 報帳 / 產品規格問題，agent 從公司文件找答案並附出處；找不到就說找不到，不亂編。

**資料從哪來**（R2 `cf-demo-kb` + AI Search `cf-demo-kb`，以資料夾區分工作區）：
1. **預設工作區 `default/`**：虛構台灣公司「雲朵科技」內部文件約 8 份——員工手冊（特休 / 請假 / 加班）、差旅與報帳辦法、IT 支援 FAQ（VPN、密碼重設、WARP）、資安政策、產品規格書、客服 SOP。
2. **上傳檔案**：拖拉 PDF / DOCX / MD / TXT → R2 `ws-{id}/` → 觸發 AI Search 同步。
3. **匯入網站**：輸入客戶官網 → 沿用 Browser Rendering `/crawl` → markdown 存到 `ws-{id}/`。

→ 拜訪客戶前先匯入對方官網，或會議中請客戶丟一份公開文件，就能用客戶自己的資料 demo。

**流程 / Trace 形狀**：
```
invoke_agent kb-agent
├── chat (改寫查詢：中英關鍵字、同義詞)
├── execute_tool search_kb          ← AI Search，folder 過濾工作區，回傳 top-k + 分數
├── chat (依檢索結果回答，每句附 [來源])
└── invoke_agent grounding-checker   ← subagent：逐句檢查是否有來源支持
```

**查無資料時**：回覆「目前知識庫中找不到相關資料」並列出最接近的文件；Trace 面板顯示「檢索 0 筆 / 最高分 0.21」。

**建議提示詞**：「今年特休有幾天？沒休完會怎樣？」「出差住宿上限多少？」「WARP 連不上公司內網怎麼辦？」

**模型**：GLM-5.3-flash（全程）。

### Agent 2 —「Cloudflare 文件專家」Agent（Orchestrator + 並行研究 subagent）

**能幫客戶做什麼**：用中文問 Cloudflare 產品 / 架構 / 設定問題，agent 讀英文官方文件後用繁中回答，附原文連結。

**資料從哪來**：Cloudflare Docs MCP（`search_cloudflare_documentation`）＋ `web-reader`（Browser Rendering `/markdown`，限定 `developers.cloudflare.com`）讀完整頁面。

**流程 / Trace 形狀**：
```
invoke_agent docs-agent
├── chat (簡單題走快速路徑；複雜題拆成 2–4 個子問題)
├── execute_tool research ──┬── invoke_agent docs-researcher #1 ─ execute_tool search_cloudflare_documentation (MCP)
│   （並行）                ├── invoke_agent docs-researcher #2 ─ execute_tool read_doc_page (web-reader)
│                           └── invoke_agent docs-researcher #3 ─ ...
└── chat (彙整成繁中答案 + 原文連結 + 比較表)
```

**建議提示詞**：「Workers 和 Pages 差在哪？新專案該選哪個？」「怎麼用 Zero Trust 取代公司 VPN？」「Durable Objects、KV、D1 各適合什麼情境？」「AI Gateway 能幫我省哪些成本？」

**模型**：orchestrator Kimi K2.6（no-think）；`docs-researcher` GLM-5.3-flash。

### Agent 3 —「資安情資」Agent（Radar，多位分析師 subagent 並行）

**能幫客戶做什麼**：用一句中文問「台灣現在的網路威脅情勢」，agent 從 Cloudflare Radar 拉即時數據，產出附數字、圖表與來源的情資簡報，並建議對應的 Cloudflare 防護產品。不需要任何客戶資料，各產業都關心；客戶可以加上自己的網域，看全球排名與分類。

**資料從哪來**：Radar API（`CF_API_TOKEN`，3.4 已驗證）。工具是**白名單包裝**（每個工具對應固定端點、參數具名且有列舉值），模型不能自由組 URL。

**工具**（每個分析師只拿得到自己的工具）：

| 分析師 subagent | 工具 | 對應端點 |
|-----------------|------|----------|
| `attack-analyst` | `l7_attack_breakdown(dimension: mitigation_product \| http_method, compareLastWeek)`、`l7_top_industries()`、`l7_top_origins()`、`l3_attack_vectors(compareLastWeek)`、`attack_trend(layer, range)` | `attacks/layer7/*`、`attacks/layer3/*` |
| `network-analyst` | `outages(recentOnly)`、`traffic_anomalies()`、`bgp_hijacks()`、`internet_quality()` | `annotations/outages`、`traffic_anomalies`、`bgp/hijacks/events`、`quality/speed/summary` |
| `bot-analyst` | `bot_vs_human()`、`ai_crawlers()`、`email_threats()`、`domain_rank(domain)` | `http/summary/bot_class`、`ai/bots/*`、`email/security/*`、`ranking/domain/*` |

位置預設台灣（`TW`），可指定其他國家（ISO alpha-2 列舉）。

**流程 / Trace 形狀**：
```
invoke_agent threat-intel-agent
├── chat (判斷要派哪幾位分析師，1–3 位)
├── execute_tool brief ─┬── invoke_agent attack-analyst  ─ execute_tool ×2–3 (Radar)
│   （並行）            ├── invoke_agent network-analyst ─ execute_tool ×1–3 (BGP 那支約 4 s，waterfall 會明顯較長)
│                       └── invoke_agent bot-analyst     ─ execute_tool ×1–2
└── chat (彙整：3 點重點摘要 → 數據表 → 建議的 Cloudflare 產品 → Radar 來源連結)
```
（選配：彙整前呼叫 Agent 2 的 `docs-researcher`，替建議產品附上官方文件連結——示範跨 agent 重用 subagent。）

**防止亂講數字**（system prompt + 工具回傳格式共同保證）：
- 只能引用工具回傳的數字；每個工具回傳都帶 `unit`（`percent` / `normalized` / `mbps` / `ms`）與 `period`，模型照抄。
- 不支援的問題（例如「台灣金融業被攻擊幾次」）要說明 Radar 只提供產業排名與占比，不提供單一產業絕對次數。
- API 回空陣列 → 明確說「此期間無紀錄」。

**畫面**：工具結果在聊天中以小圖表呈現（沿用已安裝的 `recharts`）——占比 → 橫條圖、時序 → 折線圖；每張圖下方附 Radar 原始頁面連結（`https://radar.cloudflare.com/{country}`）。

**建議提示詞**：「台灣這週的網路攻擊狀況如何？跟上週比？」「最近有沒有影響台灣的斷網或 BGP 劫持事件？」「台灣的流量有多少是機器人？哪些 AI 爬蟲最活躍？」「哪些產業在台灣最常被攻擊？零售業該注意什麼？」「幫我看 example.com.tw 的全球排名」

**模型**：orchestrator Kimi K2.6（no-think）；分析師 GLM-5.3-flash。

### 其他通用型候選（之後可再加）

| 候選 | 能幫客戶做什麼 | 資料源 |
|------|----------------|--------|
| 網站健檢 | 輸入任何網址 → 內容 / SEO、資安標頭、效能並行診斷 → 對應 Cloudflare 產品 | Browser Rendering + fetch |
| 文件審閱 | 上傳 RFP / 合約 → 需求清單、風險條款、待確認事項 | 上傳檔案（Workers AI toMarkdown） |
| 會議記錄 | 上傳錄音 → 逐字稿、摘要、待辦 | Workers AI Whisper |
| 深度研究 | 任意主題 → 多個 subagent 搜網路 → 報告 | Web Search API（需 Gateway credits，否則 402） |

## 5. 可重用的 subagent

每個 agent = 一份設定（system prompt、模型、工具、可呼叫的 subagent）；subagent 也是設定，可被任何 agent 掛上：

| Subagent | 做什麼 | 被誰用 |
|----------|--------|--------|
| `kb-retriever` | AI Search 檢索 + 查詢改寫 | Agent 1（未來：文件審閱） |
| `grounding-checker` | 檢查答案每句是否有來源支持 | Agent 1、Agent 2（可選） |
| `docs-researcher` | 查 Cloudflare 文件並摘要 | Agent 2、Agent 3（產品建議） |
| `web-reader` | 讀網址成 markdown（Browser Rendering） | Agent 2、Agent 1 匯入網站（未來：網站健檢） |
| `attack-analyst` / `network-analyst` / `bot-analyst` | Radar 各面向分析 | Agent 3 |

新增 agent 只要加一份設定檔 + i18n 字串，不用改 API route 或 UI。

## 6. 架構（方案 A）

- `/api/agents/[agentId]`：`streamText`（經 `wrapAISDK` 包裝）→ Gateway compat → Workers AI。
- subagent = 一個 AI SDK tool，`execute` 內呼叫 `tracedAI.generateText`（不同 `functionId`）；多個 subagent 用 `Promise.all` 並行 → 自動形成巢狀、並行的 `invoke_agent`。
- MCP 呼叫沿用 `src/lib/mcp-client.ts`（`cf-docs` 公開，不需 OAuth）。
- 與 AGENTS.md 一致（Vercel AI SDK + HTTP），部署流程不變。
- 若 Spike 發現 `wrapAISDK` 在 OpenNext 下無法運作，退到「同樣邏輯搬到獨立 plain Worker + service binding」。

### 6.1 檔案

| 檔案 | 說明 |
|------|------|
| `wrangler.toml` | `[observability.traces] enabled = true`、`head_sampling_rate = 1`；R2 binding `KB_BUCKET`（`cf-demo-kb`）；`[vars] KB_AI_SEARCH = "cf-demo-kb"` |
| `package.json` | 新增 `agents`（只用 `agents/observability/ai`） |
| `src/lib/agents/models.ts` | 模型清單與各自 `reasoning_effort`、`max_tokens` |
| `src/lib/agents/tracing.ts` | `getTracedAI()`（本地 dev 無 `cloudflare:workers` 時 fallback 成原生 `ai`）、`withSpan()` |
| `src/lib/agents/trace-events.ts` | 串流事件型別（前後端共用） |
| `src/lib/agents/runtime.ts` | 依設定組裝 agent、把 subagent 包成 tool、送出 span 事件 |
| `src/lib/agents/tools/{kb,cf-docs,web-reader,radar}.ts` | 真實資料源工具（Radar 為白名單包裝） |
| `src/lib/agents/defs/{kb,docs,threat-intel}.ts`、`src/lib/agents/subagents/*.ts` | agent / subagent 設定 |
| `src/app/api/agents/[agentId]/route.ts` | 執行 agent、串流 NDJSON |
| `src/app/api/agents/kb/{upload,import-site,status}/route.ts` | 上傳檔案、匯入網站、查同步狀態 |
| `scripts/seed-kb/*.md` | 「雲朵科技」範例文件（一次性上傳到 R2 `default/`） |
| `src/app/(dashboard)/agents/[agentId]/page.tsx`、`src/app/pages/agent-chat.tsx` | 路由與共用聊天頁 |
| `src/app/components/agents/{trace-panel,span-detail,kb-workspace,radar-chart}.tsx` | Waterfall、span 細節、知識庫工作區、Radar 小圖表 |
| `src/app/components/app-sidebar.tsx` | 「MCP 卡控」下方加可展開「Agents」 |
| `src/i18n/{zh-TW,en}.json` | `sidebar.agents`、`agents.*` |

### 6.2 串流協定（NDJSON，一行一事件）

```ts
type TraceEvent =
  | { type: "run-start"; runId: string; agent: string; model: string; t: number }
  | { type: "span-start"; id: string; parentId?: string; kind: "invoke_agent" | "chat" | "execute_tool"; name: string; t: number }
  | { type: "span-end"; id: string; t: number; status: "ok" | "error"; usage?: { input: number; output: number }; ttftMs?: number; detail?: unknown }
  | { type: "reasoning-delta"; spanId: string; text: string }
  | { type: "text-delta"; spanId: string; text: string }
  | { type: "citation"; spanId: string; source: { title: string; url?: string; snippet: string; score?: number } }
  | { type: "chart"; spanId: string; chart: { kind: "bar" | "line"; title: string; unit: string; period: string; data: { label: string; value: number }[]; sourceUrl: string } }
  | { type: "run-end"; t: number; totalMs: number; ttftMs: number; usage: { input: number; output: number } };
```

- `t` 為相對 run 開始的毫秒；前端另記錄**使用者感受的 TTFT**（按下送出 → 第一個字出現）。
- 畫面上的 span 與送到 Cloudflare 的 span 同名、同層級，所以畫面 waterfall ≈ Dashboard Trace view。

### 6.3 畫面（shadcn）

```
┌ Header：Agent 名稱 + 一句話說明 ┬ 模型選單(Select) ┬ 「在 Cloudflare 查看 Trace」(Button) ┐
├──────────── 聊天 (ScrollArea) ─────────────┬──────── Trace 面板 (Card) ────────────┤
│ 空狀態：建議卡片 (Card)                     │ 指標 (Badge)：首字 0.9s｜總 3.8s｜     │
│ [Agent 1] 工作區選擇 + 上傳 / 匯入網站       │  tokens 1.2k→310｜工具 2｜subagent 3   │
│ 使用者訊息 / Agent 回覆 (Markdown + 來源)   │ Waterfall：每列 span 名稱 + 時間條      │
│ [Agent 3] Radar 小圖表 (Card + recharts)    │  invoke_agent ████████████             │
│ 工具 / subagent 呼叫 (Collapsible)          │   chat        ██ ▲TTFT                 │
│ 推理 (Collapsible，思考模式時)              │   └ subagent ×3  ═══ ═══ ═════ (並行)   │
│ 輸入框 (Textarea + Button)                 │ 點 span → 細節 (Tabs: 輸入/輸出/tokens) │
└────────────────────────────────────────────┴───────────────────────────────────────┘
手機：Trace 面板收進 Sheet；每輪回覆下方顯示小指標列。
```

Sidebar：「功能」→ AI Agent / Clef 決策模型 / MCP 卡控 / **Agents ▸（企業知識庫 / Cloudflare 文件專家 / 資安情資）**。

### 6.4 Tracing 身分欄位

| 屬性 | 值 |
|------|----|
| `functionId` → `gen_ai.agent.name` | `kb-agent`、`docs-agent`、`threat-intel-agent`、`docs-researcher`、`grounding-checker`、`attack-analyst` …（固定名稱） |
| `metadata.agentId` → `gen_ai.agent.id` | `{agent}-demo` |
| `metadata.conversationId` → `gen_ai.conversation.id` | 前端產生的對話 ID（同一對話多輪 = Dashboard 一個 session） |
| `metadata.workspace`、`metadata.model` | 額外篩選用 |

payload：`storeMessages: true, storeTools: true`。⚠️ Agent 1 客戶上傳的文件內容會進 trace（保留 7 天）——上傳區註明，並提供「不記錄內容」開關（關掉時該次請求 `storeMessages: false`）。

### 6.5 速度目標

| 項目 | 目標 |
|------|------|
| Agent 1 首字 | p50 < 3 s（含檢索） |
| Agent 2 簡單題 E2E | p50 < 8 s；複雜題（3 個並行 subagent）< 20 s |
| Agent 3 E2E（3 位分析師並行） | p50 < 15 s（Radar 單次 0.5–1.8 s，BGP 約 4 s） |

- Gateway 加 `cf-aig-skip-cache: true`（避免快取扭曲延遲數字）。
- subagent 一律並行，`max_tokens` 限制；Agent 2 簡單題走快速路徑不拆題。
- Radar 回應在 Worker 內以 KV 快取 10 分鐘（key 含端點與參數）——Radar 本身每 15 分鐘到 1 小時更新；trace 上工具 span 加屬性 `cache.hit` 讓觀眾看得出差別。

### 6.6 錯誤處理

- 模型 / Gateway / MCP / Browser Rendering / Radar 錯誤 → `span-end status:error` + `recordException`，聊天中顯示錯誤卡片；單一 subagent 失敗不拖垮整體，彙整時註明「某面向資料取得失敗」。
- 檢索 0 筆或 API 回空陣列 → 明確回覆「查無資料 / 此期間無紀錄」。
- 串流 idle 60 s 中止；工具逾時 20 s（Browser Rendering 30 s）。
- 上傳限制：單檔 ≤ 10 MB、每工作區 ≤ 20 檔；匯入網站 ≤ 30 頁。

## 7. 實作前 Spike（第一步）

1. OpenNext build 下 `wrapAISDK` 能否 import（`cloudflare:workers` 是否被 external）；本地 `next dev` 的 fallback。
2. production 上 Agents 分頁：agent / subagent 巢狀、並行 subagent 的呈現、payload replay。
3. `@ai-sdk/openai` 經 Gateway 帶 `reasoning_effort`（`providerOptions` 或自訂 body）。
4. AI Search 新文件從上傳到可查詢要多久（決定「會議中現場上傳」是否可行；太久就以「會前準備工作區」為主）。
5. Radar 各端點 `location` 是來源還是目標，逐一確認後寫進工具說明。

> Agents 分頁只能在 **production**（git push 部署後）驗證；本地只能驗證畫面 waterfall。依 AGENTS.md，push 需你明確同意。

## 8. 測試

- 單元測試（vitest）：事件序列化、TTFT 計算、subagent 組裝、URL 白名單（`read_doc_page` 只允許 `developers.cloudflare.com`）、Radar 工具參數驗證與回傳格式（帶 `unit` / `period`）。
- 本地 `npm run dev`：三個 agent 各跑建議提示詞 + 一題「資料裡沒有的問題」（Agent 3 例：「台灣金融業上週被攻擊幾次？」應說明 Radar 不提供）；上傳 / 匯入流程；手機 Sheet、深色模式。
- Production：push 後在 Dashboard Agents 分頁確認三個 agent、session replay、subagent 巢狀。
