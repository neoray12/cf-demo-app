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
- 預設模型：GPT-3.5 Turbo（`openai-gpt35`）

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

## 技術棧

- **前端**: React 19 + Vite + Tailwind CSS 4 + shadcn (new-york style)
- **後端**: Cloudflare Workers
- **AI**: Workers AI via `workers-ai-provider` + Vercel AI SDK (`ai`) + AI Gateway
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

## 協作規範

- **不要自動 push 到 remote**：除非使用者明確說「push」，否則只做本地 commit，不執行 `git push`
- **不要直接 wrangler deploy**：部署只能透過 git push 觸發 CI/CD，禁止本地直接 `wrangler deploy` 或 `npm run deploy`
- **不要建立不必要的檔案**：避免建立 debug endpoint、臨時測試檔等，如果建了必須立即清除
- **修改後先驗證**：改完程式碼後，先在本地 `npm run dev` 測試，確認功能正常再 commit
