/**
 * Cloudflare Worker: multi-tenant MCP over Web Standard streamable HTTP + OAuth façade.
 * Tenants are identified by URL path prefix: /{client_name}/mcp, /{client_name}/oauth/*
 * Root /mcp is admin/unrestricted (no ALLOWED_CUSTOMER_IDS) — disable by removing global OAUTH_CLIENT_ID/SECRET secrets.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { normalizeCustomerId } from '../shared/allowlist.js';
import type { GaMcpEnv } from '../shared/env.js';
import { createMcpServer, MCP_VERSION } from '../shared/mcp-app.js';
import {
  encodeAuthorizationCode,
  issueMcpSessionToken,
  isValidMcpBearer,
  oauthClientIdFromEnv,
  oauthClientSecretFromEnv,
  trimStr,
  validateAuthorizationCodeGrant,
  validateSessionForClient,
} from '../shared/oauth-code.js';

// Path segments that are root routes, not client names.
const KNOWN_ROOTS = new Set(['health', '.well-known', 'oauth', 'mcp']);

interface ClientConfig {
  oauthClientId: string;
  oauthClientSecret: string;
  allowedCustomerIds: string[];
}

async function loadClientConfig(kv: KVNamespace, name: string): Promise<ClientConfig | null> {
  const raw = await kv.get(`client:${name}`, 'json');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== null) console.error(`[loadClientConfig] Invalid config shape for client:${name}`);
    return null;
  }
  const cfg = raw as Record<string, unknown>;
  if (typeof cfg.oauthClientId !== 'string' ||
      typeof cfg.oauthClientSecret !== 'string' ||
      !Array.isArray(cfg.allowedCustomerIds)) {
    console.error(`[loadClientConfig] Missing or invalid fields in client:${name}`);
    return null; // malformed config → 404, not crash
  }
  return {
    oauthClientId: cfg.oauthClientId,
    oauthClientSecret: cfg.oauthClientSecret,
    allowedCustomerIds: (cfg.allowedCustomerIds as unknown[]).map(String),
  };
}

function makeClientEnv(base: GaMcpEnv, cfg: ClientConfig): GaMcpEnv {
  return {
    ...base,
    OAUTH_CLIENT_ID: cfg.oauthClientId,
    OAUTH_CLIENT_SECRET: cfg.oauthClientSecret,
    // ?? [] so malformed config (missing field) fails CLOSED (deny all), not open
    ALLOWED_CUSTOMER_IDS: (cfg.allowedCustomerIds ?? []).map(normalizeCustomerId).join(','),
  };
}

async function resolveEnvFromOauthClientId(
  env: GaMcpEnv,
  kv: KVNamespace,
  oauthClientId: string | null,
): Promise<GaMcpEnv> {
  if (!oauthClientId) return env;
  const clientName = await kv.get(`oauth_client_index:${oauthClientId}`);
  if (!clientName) return env;
  const cfg = await loadClientConfig(kv, clientName);
  if (!cfg) return env;
  return makeClientEnv(env, cfg);
}

/** Origin + optional per-tenant path prefix. BASE_URL must be origin-only when set. */
function publicBaseUrl(env: GaMcpEnv, request: Request, prefix = ''): string {
  const override = typeof env.BASE_URL === 'string' ? env.BASE_URL.trim() : '';
  return (override || new URL(request.url).origin) + prefix;
}

function corsHeaders(request: Request): Record<string, string> {
  const requested = request.headers.get('Access-Control-Request-Headers');
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      requested ||
      'Authorization, Content-Type, Accept, mcp-session-id, Mcp-Session-Id, Last-Event-ID, mcp-protocol-version',
    'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
  };
}

function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
  request: Request | null = null,
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (request) Object.assign(headers, corsHeaders(request));
  return new Response(JSON.stringify(data), { status, headers });
}

async function handleMcp(request: Request, env: GaMcpEnv, base: string): Promise<Response> {
  const kv = env.GA_MCP_KV;
  const authed = kv
    ? await validateSessionForClient(kv, request.headers.get('authorization'), oauthClientIdFromEnv(env))
    : isValidMcpBearer(env, request.headers.get('authorization')); // wrangler dev fallback

  if (!authed) {
    return json(
      { error: 'Unauthorized' },
      401,
      {
        'WWW-Authenticate': `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      },
      request,
    );
  }

  const mcpServer = createMcpServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport();
  await mcpServer.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(request))) {
      if (!headers.has(k)) headers.set(k, v);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (err) {
    console.error('[MCP]', err);
    return json(
      { error: 'Internal Error', message: err instanceof Error ? err.message : String(err) },
      500,
      {},
      request,
    );
  }
}

export default {
  async fetch(request: Request, env: GaMcpEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Health is always root-only.
    if (request.method === 'GET' && path === '/health') {
      return json({ status: 'ok', version: MCP_VERSION }, 200, {}, request);
    }

    // Resolve tenant from path prefix: /{client_name}/...
    const segments = path.split('/').filter(Boolean);
    const hasClientPrefix = segments.length >= 2 && !KNOWN_ROOTS.has(segments[0]!);
    const clientName = hasClientPrefix ? segments[0]! : null;
    const subPath = hasClientPrefix ? '/' + segments.slice(1).join('/') : path;

    if (clientName) {
      if (!env.GA_MCP_KV) {
        return new Response('Server misconfigured: KV not bound', { status: 503 });
      }
      const cfg = await loadClientConfig(env.GA_MCP_KV, clientName);
      if (!cfg) {
        return new Response('Not found', { status: 404 });
      }
      env = makeClientEnv(env, cfg);
    }

    const prefix = clientName ? `/${clientName}` : '';
    const base = publicBaseUrl(env, request, prefix);

    if (request.method === 'GET' && subPath === '/.well-known/oauth-protected-resource') {
      return json(
        {
          resource: base,
          authorization_servers: [base],
        },
        200,
        {},
        request,
      );
    }

    if (request.method === 'GET' && subPath === '/.well-known/oauth-authorization-server') {
      return json(
        {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        },
        200,
        {},
        request,
      );
    }

    if (subPath === '/oauth/register') {
      return new Response(null, { status: 405 });
    }

    if (request.method === 'GET' && (subPath.startsWith('/oauth/authorize') || subPath.startsWith('/authorize'))) {
      const clientId = url.searchParams.get('client_id');

      // Root-path fallback: resolve env from oauth_client_index or resource param.
      if (!clientName && env.GA_MCP_KV) {
        env = await resolveEnvFromOauthClientId(env, env.GA_MCP_KV, clientId);
        if (!oauthClientIdFromEnv(env)) {
          const resource = url.searchParams.get('resource');
          if (resource) {
            try {
              const resourceClientName = new URL(resource).pathname.split('/').filter(Boolean)[0];
              if (resourceClientName && !KNOWN_ROOTS.has(resourceClientName) && env.GA_MCP_KV) {
                const cfg = await loadClientConfig(env.GA_MCP_KV, resourceClientName);
                if (cfg) env = makeClientEnv(env, cfg);
              }
            } catch { /* invalid URL, ignore */ }
          }
        }
      }

      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      const codeChallenge = url.searchParams.get('code_challenge');

      const expectedClientId = oauthClientIdFromEnv(env);
      if (!expectedClientId) {
        return json(
          {
            error: 'server_error',
            error_description:
              'OAUTH_CLIENT_ID is not set on this Worker. Add variable OAUTH_CLIENT_ID (letter O), not 0AUTH_CLIENT_ID (digit zero).',
          },
          503,
          {},
          request,
        );
      }

      if (trimStr(clientId) !== expectedClientId) {
        return json(
          {
            error: 'invalid_client',
            error_description: `client_id must match the configured OAUTH_CLIENT_ID. Got "${trimStr(clientId) || '(empty)'}".`,
          },
          401,
          {},
          request,
        );
      }

      if (!redirectUri) {
        return json(
          { error: 'invalid_request', error_description: 'redirect_uri required' },
          400,
          {},
          request,
        );
      }

      const code = encodeAuthorizationCode({ clientId, codeChallenge, redirectUri });
      return Response.redirect(
        `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || '')}`,
        302,
      );
    }

    if (request.method === 'POST' && (subPath === '/oauth/token' || subPath === '/token')) {
      const params = new URLSearchParams(await request.text());
      const grantType = params.get('grant_type');
      const clientId = params.get('client_id');
      const clientSecret = params.get('client_secret');
      const codeParam = params.get('code');
      const redirectUri = params.get('redirect_uri');
      const codeVerifier = params.get('code_verifier');

      // Root-path fallback: resolve env from oauth_client_index.
      if (!clientName && env.GA_MCP_KV) {
        env = await resolveEnvFromOauthClientId(env, env.GA_MCP_KV, clientId);
      }

      if (grantType === 'authorization_code' && !codeParam) {
        return json(
          { error: 'invalid_request', error_description: 'code is required' },
          400,
          {},
          request,
        );
      }

      if (codeParam) {
        const result = await validateAuthorizationCodeGrant({
          codeParam,
          clientId,
          clientSecret,
          redirectUri,
          codeVerifier,
          expectedClientId: oauthClientIdFromEnv(env),
          expectedClientSecret: oauthClientSecretFromEnv(env),
        });

        if (!result.ok) {
          const errBody: Record<string, string> = { error: result.error };
          if (result.description) errBody.error_description = result.description;
          return json(errBody, result.httpStatus, {}, request);
        }

        if (!env.GA_MCP_KV) {
          return json(
            { error: 'server_error', error_description: 'KV namespace is not bound.' },
            503,
            {},
            request,
          );
        }
        const token = await issueMcpSessionToken(env.GA_MCP_KV, trimStr(clientId));
        return json(
          { access_token: token, token_type: 'bearer', expires_in: 86400 },
          200,
          {},
          request,
        );
      }

      const expectedId = oauthClientIdFromEnv(env);
      const expectedSecret = oauthClientSecretFromEnv(env);
      if (!expectedId || !expectedSecret) {
        return json(
          {
            error: 'server_error',
            error_description: 'OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must both be configured.',
          },
          503,
          {},
          request,
        );
      }

      if (trimStr(clientId) !== expectedId || trimStr(clientSecret) !== expectedSecret) {
        return json(
          {
            error: 'invalid_client',
            error_description: 'client_id or client_secret does not match configured OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET.',
          },
          401,
          {},
          request,
        );
      }

      if (!env.GA_MCP_KV) {
        return json(
          { error: 'server_error', error_description: 'KV namespace is not bound.' },
          503,
          {},
          request,
        );
      }
      const token = await issueMcpSessionToken(env.GA_MCP_KV, trimStr(clientId));
      return json(
        { access_token: token, token_type: 'bearer', expires_in: 86400 },
        200,
        {},
        request,
      );
    }

    if (
      (subPath === '/mcp' || subPath === '/') &&
      (request.method === 'GET' || request.method === 'POST' || request.method === 'DELETE')
    ) {
      return handleMcp(request, env, base);
    }

    return new Response('Not found', { status: 404 });
  },
};
