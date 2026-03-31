interface CloudflareEnv {
  AI: Ai;
  CRAWLER_BUCKET: R2Bucket;
  KV: KVNamespace;
  ASSETS: Fetcher;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AUTORAG_NAME: string;
  CF_API_TOKEN: string;
  CF_AIG_TOKEN: string;
  MCP_SERVER_URLS: string;
}
