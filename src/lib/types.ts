export type ModelProvider = "workers-ai" | "openai" | "perplexity" | "anthropic";

export interface AIModel {
  id: string;
  name: string;
  provider: ModelProvider;
  workersAiModel?: string;
  providerModelId?: string;
  reasoning?: boolean;
}

export const AI_MODELS: AIModel[] = [
  // Cloudflare Workers AI
  {
    id: "gpt-oss-120b",
    name: "GPT OSS 120B",
    provider: "workers-ai",
    workersAiModel: "@cf/openai/gpt-oss-120b",
  },
  {
    id: "gpt-oss-20b",
    name: "GPT OSS 20B",
    provider: "workers-ai",
    workersAiModel: "@cf/openai/gpt-oss-20b",
  },
  // OpenAI
  {
    id: "openai-gpt35",
    name: "GPT-3.5 Turbo",
    provider: "openai",
    providerModelId: "gpt-3.5-turbo",
  },
  {
    id: "openai-gpt5",
    name: "GPT-5",
    provider: "openai",
    providerModelId: "gpt-5",
  },
  // Perplexity
  {
    id: "perplexity-sonar",
    name: "Perplexity Sonar",
    provider: "perplexity",
    providerModelId: "sonar",
  },
  // Anthropic
  {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    provider: "anthropic",
    providerModelId: "claude-sonnet-4-20250514",
  },
  {
    id: "claude-opus-4",
    name: "Claude Opus 4",
    provider: "anthropic",
    providerModelId: "claude-opus-4-20250514",
  },
  {
    id: "claude-3-haiku",
    name: "Claude 3 Haiku",
    provider: "anthropic",
    providerModelId: "claude-3-haiku-20240307",
  },
];

export const DEFAULT_MODEL_ID = "gpt-oss-20b";

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
