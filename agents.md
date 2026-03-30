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
- 使用 Cloudflare **Agents SDK** (`AIChatAgent`)，不使用 Vercel AI SDK
- 透過 **AI Gateway** (`nkcf-gateway-01`) 路由所有 AI 請求
- 使用 **Workers AI** 模型（Llama 3.3 70B, DeepSeek R1, QwQ, GPT OSS 等）
- 整合 **AI Search (AutoRAG)** 進行 RAG，查詢 R2 中已爬取的資料
- 聊天 UI 仿 ChatGPT 風格：串流回覆、Markdown 渲染、模型選擇器、建議卡片
- 參考 `/Users/neokung/Documents/tce-app` 的 UI 設計與邏輯

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
- **後端**: Cloudflare Workers + Agents SDK (Durable Objects)
- **AI**: Workers AI via `workers-ai-provider` + AI SDK v6 + AI Gateway
- **RAG**: AI Search (AutoRAG) 索引 R2 爬蟲資料
- **路由**: React Router v7
- **部署**: `wrangler deploy`

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

- `wrangler secret put CF_API_TOKEN` — Cloudflare API Token
- `.dev.vars` 中存放本地開發用的 secrets
- 確保 `account_id` 設定為 `5efa272dc28e4e3933324c44165b6dbe` (Neo-Cloudflare)

## 協作規範

- **不要自動 push 到 remote**：除非使用者明確說「push」，否則只做本地 commit，不執行 `git push`
