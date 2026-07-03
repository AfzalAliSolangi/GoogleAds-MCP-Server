/**
 * Bindings for Cloudflare Worker (`env`) and Node (`process.env`) — same keys.
 * Index signature allows `oauth-code` helpers and Wrangler extras without casts.
 */
export interface GaMcpEnv {
  /** OAuth desktop/web app — use with GOOGLE_ADS_OAUTH_CLIENT_SECRET + GOOGLE_ADS_REFRESH_TOKEN (Airbyte-style). */
  GOOGLE_ADS_OAUTH_CLIENT_ID?: string;
  GOOGLE_ADS_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GCP_SERVICE_ACCOUNT_BASE64?: string;
  GOOGLE_ADS_IMPERSONATE_USER?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  /** Static bearer — only used as fallback when MCP_SESSIONS_KV is not bound (local wrangler dev). */
  ACCESS_TOKEN?: string;
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  /** Typo fallback: digit zero instead of letter O */
  '0AUTH_CLIENT_ID'?: string;
  '0AUTH_CLIENT_SECRET'?: string;
  BASE_URL?: string;
  PORT?: string;
  /** KV namespace for per-session MCP bearer tokens (Cloudflare Worker only). */
  MCP_SESSIONS_KV?: KVNamespace;
  [key: string]: string | KVNamespace | undefined;
}
