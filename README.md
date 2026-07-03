# Google Ads MCP — Cloudflare Worker (TypeScript)

Remote MCP server for Google Ads using the **Google Ads REST API v23** (HTTP routes, Streamable MCP transport, optional OAuth code + PKCE facade).

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
cd "MCP Servers/ga-mcp-server-cloudflare"
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
- **Telemetry**: sets `x-goog-api-client` with `ga-mcp-server-cloudflare/<version>`.



## License

Apache-2.0. New files in this directory are provided under the same license unless noted otherwise.