import { GoogleAuth } from 'google-auth-library';
import type { GaMcpEnv } from './env.js';

export const ADS_REST_BASE = 'https://googleads.googleapis.com';
export const ADS_API_VERSION = 'v23';
export const MCP_PACKAGE_VERSION = '1.0.0';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Refresh access token this many seconds before Google’s expires_in to avoid edge-of-expiry failures. */
const OAUTH_EXPIRY_MARGIN_SEC = 120;

let saAuthCache: { key: string; auth: GoogleAuth } | null = null;

type RefreshTokenCache = {
  key: string;
  accessToken: string;
  expiresAtMs: number;
};

let refreshTokenCache: RefreshTokenCache | null = null;

function nodeOrWorkerRuntime(): string {
  try {
    if (typeof process !== 'undefined' && process.versions?.node) {
      return process.versions.node;
    }
  } catch {
    /* Worker may not expose process */
  }
  return 'worker';
}

export function buildApiClientHeader(): string {
  const tag = `ga-mcp-clients/${MCP_PACKAGE_VERSION}`;
  return `rest framework/TS gl-node/${nodeOrWorkerRuntime()} ${tag}`;
}

export function getDeveloperToken(env: GaMcpEnv): string {
  const t = env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim();
  if (!t) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN environment variable not set.');
  return t;
}

export function usesGoogleAdsRefreshTokenAuth(env: GaMcpEnv): boolean {
  const id = env.GOOGLE_ADS_OAUTH_CLIENT_ID?.trim();
  const secret = env.GOOGLE_ADS_OAUTH_CLIENT_SECRET?.trim();
  const rt = env.GOOGLE_ADS_REFRESH_TOKEN?.trim();
  return Boolean(id && secret && rt);
}

function assertGoogleAdsAuthConfig(env: GaMcpEnv): void {
  const id = env.GOOGLE_ADS_OAUTH_CLIENT_ID?.trim();
  const secret = env.GOOGLE_ADS_OAUTH_CLIENT_SECRET?.trim();
  const rt = env.GOOGLE_ADS_REFRESH_TOKEN?.trim();
  const parts = [id, secret, rt].filter(Boolean).length;
  if (parts > 0 && parts < 3) {
    throw new Error(
      'Incomplete Google Ads OAuth env: set GOOGLE_ADS_OAUTH_CLIENT_ID, GOOGLE_ADS_OAUTH_CLIENT_SECRET, and GOOGLE_ADS_REFRESH_TOKEN together, or omit all three to use service account auth (GCP_SERVICE_ACCOUNT_BASE64 + GOOGLE_ADS_IMPERSONATE_USER).',
    );
  }
}

function refreshTokenAuthCacheKey(env: GaMcpEnv): string {
  return [
    env.GOOGLE_ADS_OAUTH_CLIENT_ID?.trim(),
    env.GOOGLE_ADS_OAUTH_CLIENT_SECRET?.trim(),
    env.GOOGLE_ADS_REFRESH_TOKEN?.trim(),
  ].join('\0');
}

async function getAdsAccessTokenViaRefresh(env: GaMcpEnv): Promise<string> {
  const key = refreshTokenAuthCacheKey(env);
  const now = Date.now();
  const marginMs = OAUTH_EXPIRY_MARGIN_SEC * 1000;
  if (
    refreshTokenCache &&
    refreshTokenCache.key === key &&
    refreshTokenCache.expiresAtMs > now + marginMs
  ) {
    return refreshTokenCache.accessToken;
  }

  const clientId = env.GOOGLE_ADS_OAUTH_CLIENT_ID!.trim();
  const clientSecret = env.GOOGLE_ADS_OAUTH_CLIENT_SECRET!.trim();
  const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN!.trim();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google OAuth token refresh failed (${res.status}): ${text.slice(0, 800)}`);
  }
  let data: { access_token?: string; expires_in?: number };
  try {
    data = JSON.parse(text) as { access_token?: string; expires_in?: number };
  } catch {
    throw new Error(`Google OAuth token refresh: expected JSON, got: ${text.slice(0, 300)}`);
  }
  if (!data.access_token) {
    throw new Error('Google OAuth token refresh: response missing access_token');
  }
  const expiresInSec =
    typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
  refreshTokenCache = {
    key,
    accessToken: data.access_token,
    expiresAtMs: now + expiresInSec * 1000,
  };
  return data.access_token;
}

export function getGoogleAuth(env: GaMcpEnv): GoogleAuth {
  const b64 = env.GCP_SERVICE_ACCOUNT_BASE64?.trim();
  if (!b64) throw new Error('Missing GCP_SERVICE_ACCOUNT_BASE64');
  const subject = env.GOOGLE_ADS_IMPERSONATE_USER?.trim();
  if (!subject) throw new Error('Missing GOOGLE_ADS_IMPERSONATE_USER (delegated user email for service account impersonation)');
  const key = `${b64}|${subject}`;
  if (!saAuthCache || saAuthCache.key !== key) {
    const credentials = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
    saAuthCache = {
      key,
      auth: new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/adwords'],
        clientOptions: { subject },
      }),
    };
  }
  return saAuthCache.auth;
}

export async function getAdsAccessToken(env: GaMcpEnv): Promise<string> {
  assertGoogleAdsAuthConfig(env);
  if (usesGoogleAdsRefreshTokenAuth(env)) {
    return getAdsAccessTokenViaRefresh(env);
  }
  const client = await getGoogleAuth(env).getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error('Failed to obtain Google Ads access token');
  return token.token;
}

export function adsHeaders(env: GaMcpEnv, token: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'developer-token': getDeveloperToken(env),
    'x-goog-api-client': buildApiClientHeader(),
  };
  const login = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim().replace(/-/g, '');
  if (login) {
    h['login-customer-id'] = login;
  }
  return h;
}

export async function adsFetch(
  env: GaMcpEnv,
  path: string,
  init: RequestInit & { jsonBody?: unknown } = {},
): Promise<Response> {
  const token = await getAdsAccessToken(env);
  const url = `${ADS_REST_BASE}/${path}`;
  const { jsonBody, headers: extra, ...rest } = init;
  const headers = new Headers(extra);
  const base = adsHeaders(env, token);
  for (const [k, v] of Object.entries(base)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  if (jsonBody !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, {
    ...rest,
    headers,
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
  });
}

export async function adsReadJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google Ads API ${res.status}: ${text.slice(0, 2000)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Google Ads API: expected JSON, got: ${text.slice(0, 500)}`);
  }
}
