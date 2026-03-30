export interface Env {
  AI: Ai;
  CRAWLER_BUCKET: R2Bucket;
  KV: KVNamespace;
  ChatAgent: DurableObjectNamespace;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AUTORAG_NAME: string;
  CF_API_TOKEN: string;
  CF_AIG_TOKEN: string;
  MCP_SERVER_URLS?: string;
}
