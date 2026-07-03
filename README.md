# Google Ads MCP — Cloudflare Worker (TypeScript) — Multi-Tenant (`ga-mcp-clients`)

Remote MCP server for Google Ads using the **Google Ads REST API v23** (HTTP routes, Streamable MCP transport, OAuth code + PKCE facade). Multi-tenant: each client gets a scoped endpoint `/{client_name}/mcp` with its own OAuth credentials and a `allowedCustomerIds` allowlist that restricts which Google Ads accounts they can query. Google Ads API credentials are shared (one MCC + one developer token).

## Tools


| Tool                        | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `search`                    | GAQL `searchStream` against `customers/{id}/googleAds:searchStream`     |
| `list_accessible_customers` | `GET .../v23/customers:listAccessibleCustomers`                         |
| `get_resource_metadata`     | `POST .../v23/googleAdsFields:search` (LIKE filter, full-scan fallback) |


## Resources


| URI                             | Content                            |
| ------------------------------- | ---------------------------------- |
| `resource://discovery-document` | Google Ads v23 REST discovery JSON |
| `resource://metrics`            | Metrics field reference (HTML)     |
| `resource://segments`           | Segments reference (HTML)          |
| `resource://release-notes`      | API release notes (HTML)           |




## Google Ads API auth (choose one)

**Always required:** `GOOGLE_ADS_DEVELOPER_TOKEN` plus the MCP secret `ACCESS_TOKEN` (see below).

### A) OAuth refresh token (Airbyte-style)

Set `GOOGLE_ADS_OAUTH_CLIENT_ID`, `GOOGLE_ADS_OAUTH_CLIENT_SECRET`, and `GOOGLE_ADS_REFRESH_TOKEN` (same values you use in the Google Ads source connector: OAuth client + refresh token obtained with scope `https://www.googleapis.com/auth/adwords`). The worker exchanges the refresh token for short-lived access tokens and caches them until shortly before expiry.

If all three are set, this mode is used and **service account variables are ignored** for Google Ads calls.

### B) Service account + Workspace delegation

`GCP_SERVICE_ACCOUNT_BASE64` (JSON key, base64) and `GOOGLE_ADS_IMPERSONATE_USER` (user email to impersonate), with domain-wide delegation and scope `https://www.googleapis.com/auth/adwords` per [Google Ads API service account auth](https://developers.google.com/google-ads/api/docs/oauth/service-accounts).

Use this only when you **do not** set the three OAuth refresh variables above.

## Environment variables


| Variable                                  | Required | Purpose                                                                               |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `GOOGLE_ADS_DEVELOPER_TOKEN`              | Yes      | Ads developer token (header `developer-token`)                                        |
| `ACCESS_TOKEN`                            | Yes      | Static bearer for `/mcp` (trimmed; no newline paste issues)                           |
| `GOOGLE_ADS_OAUTH_CLIENT_ID`              | Mode A   | OAuth client ID for refresh-token exchange                                            |
| `GOOGLE_ADS_OAUTH_CLIENT_SECRET`          | Mode A   | OAuth client secret                                                                   |
| `GOOGLE_ADS_REFRESH_TOKEN`                | Mode A   | Long-lived refresh token (`grant_type=refresh_token`)                                 |
| `GCP_SERVICE_ACCOUNT_BASE64`              | Mode B   | Base64-encoded service account JSON                                                   |
| `GOOGLE_ADS_IMPERSONATE_USER`             | Mode B   | User email to impersonate (`subject`)                                                 |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID`            | No       | Manager CID (digits only; hyphens stripped)                                           |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | Optional | OAuth façade for clients that expect authorization code + PKCE (not Google Ads OAuth) |
| `BASE_URL`                                | No       | Public origin for OAuth metadata (defaults to request origin on Workers)              |
| `PORT`                                    | No       | Node only; default `10000`                                                            |




### Wrangler secrets

**Mode A (refresh token):**

```bash
cd "MCP Servers/Client MCPs/ga-mcp"
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_REFRESH_TOKEN
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
npx wrangler secret put ACCESS_TOKEN
```

**Mode B (service account):**

```bash
npx wrangler secret put GCP_SERVICE_ACCOUNT_BASE64
npx wrangler secret put GOOGLE_ADS_IMPERSONATE_USER
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
npx wrangler secret put ACCESS_TOKEN
```

Optional for either mode:

```bash
npx wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID
npx wrangler secret put OAUTH_CLIENT_ID
npx wrangler secret put OAUTH_CLIENT_SECRET
```



## Multi-tenant setup

### 1. Create a new KV namespace (one-time, first deploy only)

```bash
npx wrangler kv namespace create GA_MCP_KV
```

Copy both returned `id` and `preview_id` into `wrangler.toml` (replace the `REPLACE_WITH_NEW_KV_*` placeholders). **Do not reuse the old `ga-mcp-server-cloudflare` namespace.**

### 2. Set shared Google Ads secrets on the new worker

Secrets are per-worker and don't carry over. Set them fresh on `ga-mcp-clients`:

```bash
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
# Mode A (refresh token):
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_ADS_OAUTH_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_REFRESH_TOKEN
# Optional:
npx wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID   # MCC manager account ID
```

### 3. Provision a client

```bash
# Write client config (allowedCustomerIds = digits-only; hyphens tolerated but normalized)
npx wrangler kv key put --binding GA_MCP_KV --preview false --remote \
  "client:acme" \
  '{"oauthClientId":"your-mcp-client-id","oauthClientSecret":"your-mcp-client-secret","allowedCustomerIds":["1234567890"]}'

# Write reverse-lookup index (so root-level /oauth/authorize can find this client)
npx wrangler kv key put --binding GA_MCP_KV --preview false --remote \
  "oauth_client_index:your-mcp-client-id" "acme"
```

Client endpoint: `https://ga-mcp-clients.<account>.workers.dev/acme/mcp`

**Rules:**
- `allowedCustomerIds`: digits-only IDs (hyphens tolerated). Empty array `[]` = all tool calls denied (fail-safe). Undefined (missing) = unrestricted (don't use for clients).
- Exact-ID matching only — MCC child accounts not listed are excluded even if shared creds can reach them. List every child account explicitly.
- Client names cannot collide with built-in roots: `health`, `.well-known`, `oauth`, `mcp`.
- Deprovision: delete both `client:{name}` and `oauth_client_index:{oauthClientId}` keys.

### 4. Root `/mcp` (admin/unrestricted)

Root `/mcp` (no client prefix) is admin-only and unrestricted — no `ALLOWED_CUSTOMER_IDS` filter. Auth uses global `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` secrets. To disable it: remove those two secrets from the worker.

### Local dev with allowlist

```bash
ALLOWED_CUSTOMER_IDS=1234567890 npm start   # restricts to that account
# unset = unrestricted (current single-tenant behavior preserved)
```

## Scripts


| Command              | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| `npm run dev`        | `wrangler dev` (Worker)                                                         |
| `npm run deploy`     | `wrangler deploy`                                                               |
| `npm start`          | Node HTTP server (`index.ts` via `tsx`)                                         |
| `npm test`           | Vitest                                                                          |
| `npm run embed-gaql` | Regenerate `shared/gaql_resources_embed.ts` from the GAQL resources source file |




## HTTP routes

Same pattern as `ca-mcp-server-cloudflare`: `GET /health`, `/.well-known/oauth-*`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, and MCP on `/mcp` or `/` with `Authorization: Bearer <ACCESS_TOKEN>`.

## Implementation notes

- **REST only** (no gRPC): compatible with Cloudflare Workers + `fetch`.
- **Search rows** are flattened using `fieldMask` paths from each `searchStream` chunk so dotted GAQL-style keys remain consistent in responses.
- **Telemetry**: sets `x-goog-api-client` with `ga-mcp-clients/<version>`.



## License

Apache-2.0. New files in this directory are provided under the same license unless noted otherwise.