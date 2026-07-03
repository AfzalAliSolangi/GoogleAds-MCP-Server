/**
 * Node.js HTTP server: same routes as `src/worker.ts`, MCP via Streamable HTTP transport.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { GaMcpEnv } from './shared/env.js';
import { createMcpServer, MCP_VERSION } from './shared/mcp-app.js';
import {
  bearerTokenFromAuthHeader,
  encodeAuthorizationCode,
  oauthClientIdFromEnv,
  oauthClientSecretFromEnv,
  trimStr,
  validateAuthorizationCodeGrant,
} from './shared/oauth-code.js';

const PORT = Number(process.env.PORT) || 10000;
const BASE_URL = (process.env.BASE_URL || 'http://localhost:10000').trim();

const env = process.env as GaMcpEnv;
const OAUTH_CLIENT_ID = oauthClientIdFromEnv(env);
const OAUTH_CLIENT_SECRET = oauthClientSecretFromEnv(env);

/** In-memory session store for local dev. token → expiry timestamp (ms). */
const mcpSessions = new Map<string, { expiresAt: number }>();

function issueMcpSessionTokenLocal(): string {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  mcpSessions.set(token, { expiresAt: Date.now() + 86400_000 });
  return token;
}

function validateMcpBearerLocal(authHeader: string): boolean {
  const token = bearerTokenFromAuthHeader(authHeader);
  if (!token) return false;
  const session = mcpSessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) { mcpSessions.delete(token); return false; }
  return true;
}

const mcpServerInstance = createMcpServer(env);

const sessions: Record<string, StreamableHTTPServerTransport> = {};

async function parseUrlencodedBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(new URLSearchParams(body));
      } catch {
        resolve(new URLSearchParams());
      }
    });
  });
}


async function handleMCP(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authHeader = req.headers.authorization || '';
  if (!validateMcpBearerLocal(authHeader)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="${BASE_URL}"`,
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && sessions[String(sessionId)]) {
    await sessions[String(sessionId)].handleRequest(req, res);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: id => {
      console.error('[MCP] New session:', id);
      sessions[id] = transport;
    },
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id && sessions[id]) {
      console.error('[MCP] Session closed:', id);
      delete sessions[id];
    }
  };

  await mcpServerInstance.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = createServer(async (req, res) => {
  console.error(`[HTTP] ${req.method} ${req.url}`);

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: MCP_VERSION }));
    return;
  }

  if (req.method === 'GET' && req.url === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        resource: BASE_URL,
        authorization_servers: [BASE_URL],
      }),
    );
    return;
  }

  if (req.method === 'GET' && req.url === '/.well-known/oauth-authorization-server') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        issuer: BASE_URL,
        authorization_endpoint: `${BASE_URL}/oauth/authorize`,
        token_endpoint: `${BASE_URL}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      }),
    );
    return;
  }

  if (req.url === '/oauth/register') {
    res.writeHead(405);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/oauth/authorize')) {
    const url = new URL(req.url, BASE_URL);
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const codeChallenge = url.searchParams.get('code_challenge');

    const expectedId = trimStr(OAUTH_CLIENT_ID);
    if (!expectedId) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'server_error',
          error_description:
            'OAUTH_CLIENT_ID is not set. Use the name OAUTH_CLIENT_ID (letter O), not 0AUTH_CLIENT_ID (digit zero).',
        }),
      );
      return;
    }

    if (trimStr(clientId) !== expectedId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'invalid_client',
          error_description: `client_id must match OAUTH_CLIENT_ID. Got "${trimStr(clientId) || '(empty)'}".`,
        }),
      );
      return;
    }

    if (!redirectUri) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', error_description: 'redirect_uri required' }));
      return;
    }

    const code = encodeAuthorizationCode({
      clientId,
      codeChallenge,
      redirectUri,
    });

    res.writeHead(302, {
      Location: `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || '')}`,
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/oauth/token') {
    const params = await parseUrlencodedBody(req);
    const grantType = params.get('grant_type');
    const clientId = params.get('client_id');
    const clientSecret = params.get('client_secret');
    const codeParam = params.get('code');
    const redirectUri = params.get('redirect_uri');
    const codeVerifier = params.get('code_verifier');

    if (grantType === 'authorization_code' && !codeParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request', error_description: 'code is required' }));
      return;
    }

    if (codeParam) {
      const result = await validateAuthorizationCodeGrant({
        codeParam,
        clientId,
        clientSecret,
        redirectUri,
        codeVerifier,
        expectedClientId: OAUTH_CLIENT_ID,
        expectedClientSecret: OAUTH_CLIENT_SECRET,
      });

      if (!result.ok) {
        const errBody: Record<string, string> = { error: result.error };
        if (result.description) errBody.error_description = result.description;
        res.writeHead(result.httpStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errBody));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: issueMcpSessionTokenLocal(),
          token_type: 'bearer',
          expires_in: 86400,
        }),
      );
      return;
    }

    if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'server_error',
          error_description: 'OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must both be configured.',
        }),
      );
      return;
    }

    if (
      trimStr(clientId) !== trimStr(OAUTH_CLIENT_ID) ||
      trimStr(clientSecret) !== trimStr(OAUTH_CLIENT_SECRET)
    ) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'client_id or client_secret does not match the server configuration.',
        }),
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: issueMcpSessionTokenLocal(),
        token_type: 'bearer',
        expires_in: 86400,
      }),
    );
    return;
  }

  if (req.url === '/mcp' || req.url === '/') {
    await handleMCP(req, res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

httpServer.listen(PORT, () => {
  console.error(`[MCP] Server running on port ${PORT}`);
  console.error(`[MCP] Endpoint: ${BASE_URL}/mcp`);
  console.error(`[MCP] OAuth discovery: ${BASE_URL}/.well-known/oauth-authorization-server`);
});
