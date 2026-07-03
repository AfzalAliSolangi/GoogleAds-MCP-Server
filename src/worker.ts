/**
 * Cloudflare Worker: MCP over Web Standard streamable HTTP + OAuth façade (same routes as `index.ts`).
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
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
  validateMcpBearerFromKv,
} from '../shared/oauth-code.js';

function publicBaseUrl(env: GaMcpEnv, request: Request): string {
  const override = typeof env.BASE_URL === 'string' ? env.BASE_URL.trim() : '';
  return override || new URL(request.url).origin;
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

async function handleMcp(request: Request, env: GaMcpEnv): Promise<Response> {
  const base = publicBaseUrl(env, request);
  const kv = env.MCP_SESSIONS_KV;
  const authed = kv
    ? await validateMcpBearerFromKv(kv, request.headers.get('authorization'))
    : isValidMcpBearer(env, request.headers.get('authorization')); // wrangler dev fallback

  if (!authed) {
    return json(
      { error: 'Unauthorized' },
      401,
      {
        'WWW-Authenticate': `Bearer realm="${base}"`,
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
    const base = publicBaseUrl(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method === 'GET' && path === '/health') {
      return json({ status: 'ok', version: MCP_VERSION }, 200, {}, request);
    }

    if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource') {
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

    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
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

    if (path === '/oauth/register') {
      return new Response(null, { status: 405 });
    }

    if (request.method === 'GET' && path.startsWith('/oauth/authorize')) {
      const clientId = url.searchParams.get('client_id');
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
            error_description: `client_id must match the Worker's OAUTH_CLIENT_ID. Got "${trimStr(clientId) || '(empty)'}".`,
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

      const code = encodeAuthorizationCode({
        clientId,
        codeChallenge,
        redirectUri,
      });

      return Response.redirect(
        `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || '')}`,
        302,
      );
    }

    if (request.method === 'POST' && path === '/oauth/token') {
      const params = new URLSearchParams(await request.text());
      const grantType = params.get('grant_type');
      const clientId = params.get('client_id');
      const clientSecret = params.get('client_secret');
      const codeParam = params.get('code');
      const redirectUri = params.get('redirect_uri');
      const codeVerifier = params.get('code_verifier');

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

        if (!env.MCP_SESSIONS_KV) {
          return json(
            { error: 'server_error', error_description: 'KV namespace is not bound.' },
            503,
            {},
            request,
          );
        }
        const token = await issueMcpSessionToken(env.MCP_SESSIONS_KV, trimStr(clientId));
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
            error_description:
              'client_id or client_secret does not match OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET on this Worker.',
          },
          401,
          {},
          request,
        );
      }

      if (!env.MCP_SESSIONS_KV) {
        return json(
          { error: 'server_error', error_description: 'KV namespace is not bound.' },
          503,
          {},
          request,
        );
      }
      const token = await issueMcpSessionToken(env.MCP_SESSIONS_KV, trimStr(clientId));
      return json(
        { access_token: token, token_type: 'bearer', expires_in: 86400 },
        200,
        {},
        request,
      );
    }

    if (
      (path === '/mcp' || path === '/') &&
      (request.method === 'GET' || request.method === 'POST' || request.method === 'DELETE')
    ) {
      return handleMcp(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};
