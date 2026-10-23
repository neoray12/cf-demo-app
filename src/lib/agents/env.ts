export interface AgentEnv {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  CF_AIG_TOKEN?: string;
  AI_GATEWAY_ID: string;
  KB_AI_SEARCH: string;
  KB_BUCKET_NAME: string;
  MCP_SERVER_URLS: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** Hedge delay for model requests in ms (default 2500; `0` turns hedging off). */
  AGENTS_HEDGE_AFTER_MS?: string;
  KV: KVNamespace;
}
