/**
 * Minimal OAuth2 authorization-code + PKCE (S256) helpers for MCP clients.
 */

const CODE_TTL_MS = 15 * 60 * 1000;

export function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function oauthClientIdFromEnv(env: Record<string, unknown> | undefined): string {
  const v = trimStr(env?.OAUTH_CLIENT_ID);
  if (v) return v;
  return trimStr(env?.['0AUTH_CLIENT_ID']);
}

export function oauthClientSecretFromEnv(env: Record<string, unknown> | undefined): string {
  const v = trimStr(env?.OAUTH_CLIENT_SECRET);
  if (v) return v;
  return trimStr(env?.['0AUTH_CLIENT_SECRET']);
}

export function normalizeAccessToken(env: Record<string, unknown> | undefined): string {
  return trimStr(env?.ACCESS_TOKEN);
}

export function bearerTokenFromAuthHeader(authHeader: string | null | undefined): string {
  return trimStr(String(authHeader ?? '').replace(/^Bearer\s+/i, ''));
}

export function isValidMcpBearer(
  env: Record<string, unknown> | undefined,
  authHeader: string | null | undefined,
): boolean {
  const expected = normalizeAccessToken(env);
  if (!expected) return false;
  return bearerTokenFromAuthHeader(authHeader) === expected;
}

/**
 * Issue a cryptographically random per-session bearer token and persist it in KV.
 * Two UUIDs concatenated = 256 bits of entropy. KV TTL auto-expires after 24h.
 */
export async function issueMcpSessionToken(
  kv: KVNamespace,
  clientId: string,
): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  await kv.put(
    `mcp_session:${token}`,
    JSON.stringify({ clientId, issuedAt: Date.now() }),
    { expirationTtl: 86400 },
  );
  return token;
}

/**
 * Validate a bearer token and assert it was issued for expectedClientId.
 * !expectedClientId short-circuits to allow root/admin endpoint (no per-tenant env).
 */
export async function validateSessionForClient(
  kv: KVNamespace,
  authHeader: string | null | undefined,
  expectedClientId: string,
): Promise<boolean> {
  const token = bearerTokenFromAuthHeader(authHeader);
  if (!token) return false;
  const raw = await kv.get(`mcp_session:${token}`, 'json') as { clientId?: string } | null;
  if (!raw) return false;
  return !expectedClientId || raw.clientId === expectedClientId;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64url');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function verifyPkceS256(codeVerifier: string, codeChallenge: string | null): Promise<boolean> {
  if (!codeVerifier || codeChallenge == null || codeChallenge === '') return false;
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(codeVerifier));
  const computed = base64UrlEncodeBytes(new Uint8Array(digest));
  const expected = String(codeChallenge).replace(/=+$/, '');
  return computed === expected;
}

export function encodeAuthorizationCode(payload: {
  clientId: string | null;
  codeChallenge: string | null;
  redirectUri: string;
}): string {
  const json = JSON.stringify({
    clientId: trimStr(payload.clientId),
    codeChallenge: payload.codeChallenge,
    redirectUri: trimStr(payload.redirectUri),
    issuedAt: Date.now(),
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeAuthorizationCode(codeParam: string): {
  clientId: string;
  codeChallenge: string | null;
  redirectUri: string;
  issuedAt: number;
} | null {
  try {
    const json = Buffer.from(codeParam, 'base64url').toString('utf8');
    return JSON.parse(json) as {
      clientId: string;
      codeChallenge: string | null;
      redirectUri: string;
      issuedAt: number;
    };
  } catch {
    return null;
  }
}

export type ValidateGrantResult =
  | { ok: true }
  | { ok: false; error: string; description?: string; httpStatus: number };

export async function validateAuthorizationCodeGrant(params: {
  codeParam: string | null;
  clientId: string | null;
  clientSecret: string | null;
  redirectUri: string | null;
  codeVerifier: string | null;
  expectedClientId: string | undefined;
  expectedClientSecret: string | undefined;
}): Promise<ValidateGrantResult> {
  const expId = trimStr(params.expectedClientId);
  const expSecret = trimStr(params.expectedClientSecret);

  if (!expId) {
    return {
      ok: false,
      error: 'server_error',
      description:
        'OAuth client is not configured on the server (missing OAUTH_CLIENT_ID). Add it under Worker Settings → Variables.',
      httpStatus: 503,
    };
  }

  if (!params.codeParam) {
    return { ok: false, error: 'invalid_request', description: 'code is required', httpStatus: 400 };
  }
  if (!params.redirectUri) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri is required', httpStatus: 400 };
  }
  if (!params.codeVerifier) {
    return { ok: false, error: 'invalid_request', description: 'code_verifier is required', httpStatus: 400 };
  }

  const payload = decodeAuthorizationCode(params.codeParam);
  const gotId = trimStr(params.clientId);
  const storedId = payload ? trimStr(payload.clientId) : '';
  if (!payload || storedId !== expId || gotId !== expId) {
    return { ok: false, error: 'invalid_client', httpStatus: 401 };
  }

  if (Date.now() - payload.issuedAt > CODE_TTL_MS) {
    return {
      ok: false,
      error: 'invalid_grant',
      description: 'authorization code expired',
      httpStatus: 400,
    };
  }

  if (
    payload.redirectUri &&
    params.redirectUri &&
    trimStr(payload.redirectUri) !== trimStr(params.redirectUri)
  ) {
    return { ok: false, error: 'invalid_grant', description: 'redirect_uri mismatch', httpStatus: 400 };
  }

  // OAUTH_CLIENT_SECRET is always required
  if (!expSecret) {
    return {
      ok: false,
      error: 'server_error',
      description: 'OAUTH_CLIENT_SECRET is not configured on this server.',
      httpStatus: 503,
    };
  }
  if (trimStr(params.clientSecret) !== expSecret) {
    return { ok: false, error: 'invalid_client', httpStatus: 401 };
  }

  // PKCE S256 is mandatory
  if (!payload.codeChallenge) {
    return {
      ok: false,
      error: 'invalid_request',
      description: 'code_challenge is required (PKCE S256 is mandatory)',
      httpStatus: 400,
    };
  }
  const pkceOk = await verifyPkceS256(params.codeVerifier, payload.codeChallenge);
  if (!pkceOk) {
    return { ok: false, error: 'invalid_grant', description: 'invalid code_verifier', httpStatus: 400 };
  }

  return { ok: true };
}
