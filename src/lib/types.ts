export interface AIModel {
  id: string;
  name: string;
  workersAiModel: string;
  reasoning?: boolean;
}

export const AI_MODELS: AIModel[] = [
  {
    id: "llama-3.3-70b",
    name: "Llama 3.3 70B",
    workersAiModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  },
  {
    id: "deepseek-r1-32b",
    name: "DeepSeek R1 32B",
    workersAiModel: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    reasoning: true,
  },
  {
    id: "qwq-32b",
    name: "QwQ 32B",
    workersAiModel: "@cf/qwen/qwq-32b",
    reasoning: true,
  },
  {
    id: "gpt-oss-20b",
    name: "GPT OSS 20B",
    workersAiModel: "@cf/openai/gpt-oss-20b",
  },
];

export const DEFAULT_MODEL_ID = "llama-3.3-70b";

export interface BrowserRenderingEndpoint {
  id: string;
  name: string;
  description: string;
  method: "GET" | "POST";
}

export const BR_ENDPOINTS: BrowserRenderingEndpoint[] = [
  { id: "content", name: "Content", description: "取得網頁 HTML 原始碼", method: "POST" },
  { id: "screenshot", name: "Screenshot", description: "擷取網頁截圖", method: "POST" },
  { id: "pdf", name: "PDF", description: "將網頁轉為 PDF", method: "POST" },
  { id: "markdown", name: "Markdown", description: "將網頁轉為 Markdown", method: "POST" },
  { id: "snapshot", name: "Snapshot", description: "同時取得 HTML 與截圖", method: "POST" },
  { id: "scrape", name: "Scrape", description: "使用 CSS 選取器提取元素", method: "POST" },
  { id: "json", name: "JSON", description: "AI 結構化資料提取", method: "POST" },
  { id: "links", name: "Links", description: "提取所有連結", method: "POST" },
  { id: "crawl", name: "Crawl", description: "整站爬取", method: "POST" },
];
