import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GaMcpEnv } from './env.js';
import { isCustomerAllowed, normalizeCustomerId, parseAllowedCustomerIds } from './allowlist.js';
import { buildGaqlQuery } from './ga-query.js';
import {
  ADS_API_VERSION,
  adsFetch,
  adsReadJson,
  MCP_PACKAGE_VERSION,
} from './google-ads-client.js';
import {
  flattenGoogleAdsRow,
  parseFieldMaskPaths,
  parseSearchStreamJsonBody,
} from './row-flatten.js';
import { buildSearchToolDescription } from './search-description.js';

export const MCP_VERSION = MCP_PACKAGE_VERSION;

type GoogleAdsFieldRow = {
  name?: string;
  selectable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
};

function toolJsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ result: data }, null, 2) }],
  };
}

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

async function searchGoogleAdsFieldsAll(env: GaMcpEnv, query: string): Promise<GoogleAdsFieldRow[]> {
  const all: GoogleAdsFieldRow[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const body: Record<string, unknown> = { query };
    if (pageToken) body.pageToken = pageToken;
    const res = await adsFetch(env, `${ADS_API_VERSION}/googleAdsFields:search`, {
      method: 'POST',
      jsonBody: body,
    });
    const data = await adsReadJson<{ results?: GoogleAdsFieldRow[]; nextPageToken?: string }>(res);
    if (data.results?.length) all.push(...data.results);
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return all;
}

async function fetchExternalDoc(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export function createMcpServer(env: GaMcpEnv) {
  const server = new McpServer({
    name: 'ga-mcp-clients',
    version: MCP_VERSION,
  });

  // parsed once per server instance; undefined = unrestricted (admin/local), [] = deny all
  const allowed = parseAllowedCustomerIds(env);

  server.registerTool(
    'get_resource_metadata',
    {
      description: `Retrieves the selectable, filterable, and sortable fields for a specific Google Ads resource.

Use this tool to find out which fields you can select, filter by, or sort by
when querying a specific resource (e.g., 'campaign', 'ad_group').
Do not guess fields, you MUST use this tool to discover them.

The responses of this tool should be cached, as they don't change frequently.

Args:
    resource_name: The name of the Google Ads resource (e.g., 'campaign', 'ad_group').`,
      inputSchema: {
        resource_name: z.string().describe('Google Ads resource name, e.g. campaign, ad_group'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ resource_name }) => {
      try {
        const likeQuery = `SELECT name, selectable, filterable, sortable WHERE name LIKE '${resource_name}.%'`;
        let rows: GoogleAdsFieldRow[];
        try {
          rows = await searchGoogleAdsFieldsAll(env, likeQuery);
        } catch (e) {
          console.error('[get_resource_metadata] LIKE query failed, falling back:', e);
          rows = await searchGoogleAdsFieldsAll(env, 'SELECT name, selectable, filterable, sortable');
        }

        const selectable: string[] = [];
        const filterable: string[] = [];
        const sortable: string[] = [];
        const prefix = `${resource_name}.`;

        for (const f of rows) {
          const fieldName = f.name;
          if (!fieldName || !fieldName.startsWith(prefix)) continue;
          if (f.selectable) selectable.push(fieldName);
          if (f.filterable) filterable.push(fieldName);
          if (f.sortable) sortable.push(fieldName);
        }

        return toolJsonResult({
          resource: resource_name,
          selectable: selectable.sort(),
          filterable: filterable.sort(),
          sortable: sortable.sort(),
        });
      } catch (err) {
        return toolError(
          `get_resource_metadata failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  server.registerTool(
    'list_accessible_customers',
    {
      description:
        'Returns ids of customers directly accessible by the user authenticating the call.',
      inputSchema: {},
    },
    async () => {
      try {
        // When a client allowlist is configured, return it directly.
        // listAccessibleCustomers only returns top-level MCC accounts, not child accounts,
        // so filtering its response would always exclude MCC-child customer IDs.
        if (allowed !== undefined) {
          return toolJsonResult(allowed);
        }
        const res = await adsFetch(env, `${ADS_API_VERSION}/customers:listAccessibleCustomers`, {
          method: 'GET',
        });
        const data = await adsReadJson<{ resourceNames?: string[] }>(res);
        const ids = (data.resourceNames ?? []).map(rn => rn.replace(/^customers\//, ''));
        return toolJsonResult(ids);
      } catch (err) {
        return toolError(
          `list_accessible_customers failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  const searchDescription = buildSearchToolDescription(new Date().toISOString().slice(0, 10));

  server.registerTool(
    'search',
    {
      title: 'Fetches data from the Google Ads API using the search method',
      description: searchDescription,
      inputSchema: {
        customer_id: z.string().describe('Numeric customer id without punctuation'),
        fields: z.array(z.string()).describe('GAQL field names to SELECT'),
        resource: z.string().describe('GAQL FROM resource'),
        conditions: z.array(z.string()).optional().nullable().describe('WHERE clauses combined with AND'),
        orderings: z.array(z.string()).optional().nullable().describe('ORDER BY expressions'),
        limit: z.union([z.number(), z.string()]).optional().nullable().describe('LIMIT value'),
        date_range: z
          .enum([
            'TODAY', 'YESTERDAY',
            'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS',
            'LAST_BUSINESS_WEEK', 'THIS_MONTH', 'LAST_MONTH',
            'THIS_WEEK_SUN_TODAY', 'THIS_WEEK_MON_TODAY',
            'CUSTOM',
          ])
          .optional()
          .nullable()
          .describe(
            'GAQL date range literal. Server injects segments.date DURING <literal> automatically. ' +
            'Pass CUSTOM and put the exact date condition in conditions[]. ' +
            'Omit only when this query genuinely needs no date filter.',
          ),
      },
    },
    async ({ customer_id, fields, resource, conditions, orderings, limit, date_range }) => {
      try {
        const query = buildGaqlQuery({ fields, resource, conditions, orderings, limit, date_range });
        console.error('[search] GAQL', query);
        const cid = normalizeCustomerId(customer_id);
        if (allowed !== undefined && allowed.length === 0) {
          return toolError('search failed: no customer IDs are configured for this client (access denied).');
        }
        if (!isCustomerAllowed(allowed, cid)) {
          return toolError(`search failed: customer_id ${cid} is not in this client's allowed accounts.`);
        }
        const res = await adsFetch(env, `${ADS_API_VERSION}/customers/${cid}/googleAds:searchStream`, {
          method: 'POST',
          jsonBody: { query },
        });
        const text = await res.text();
        if (!res.ok) {
          return toolError(`search failed: Google Ads API ${res.status}: ${text.slice(0, 2000)}`);
        }
        const chunks = parseSearchStreamJsonBody(text);
        const out: Record<string, unknown>[] = [];
        for (const ch of chunks) {
          const paths = parseFieldMaskPaths(ch.fieldMask);
          if ((ch.results?.length ?? 0) > 0 && paths.length === 0) {
            return toolError(
              'search: searchStream response missing fieldMask; cannot flatten rows for MCP parity.',
            );
          }
          for (const row of ch.results ?? []) {
            out.push(flattenGoogleAdsRow(row, paths));
          }
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              queried_customer_id: cid,
              row_count: out.length,
              may_be_truncated: limit == null || limit === '',
              cost_fields_are_in_micros: true,
              result: out,
            }, null, 2),
          }],
        };
      } catch (err) {
        return toolError(`search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.registerResource(
    'get_discovery_document',
    'resource://discovery-document',
    {
      description: `Retrieve the Google Ads API discovery document.

Provides the discovery document for the Google Ads API v23, which
describes the API surface, including resources, methods, and
schemas.
Host LLMs should access this resource to understand the structure of
the Google Ads API and discover available features.

Returns:
    str: The discovery document in JSON format.`,
      mimeType: 'application/json',
    },
    async (_uri: URL) => {
      const json = await fetchExternalDoc(
        'https://googleads.googleapis.com/$discovery/rest?version=v23',
      );
      return {
        contents: [
          {
            uri: 'resource://discovery-document',
            mimeType: 'application/json',
            text: json,
          },
        ],
      };
    },
  );

  server.registerResource(
    'get_metrics',
    'resource://metrics',
    {
      description: `Retrieve the Google Ads API metrics documentation.

Provides the official documentation for metrics in the Google Ads API,
listing all available metrics that can be queried to analyze performance
data.
Host LLMs should access this resource to identify which metrics are
available and how they are calculated.

Returns:
    str: The metrics documentation in HTML format.`,
      mimeType: 'text/html',
    },
    async (_uri: URL) => {
      const html = await fetchExternalDoc('https://developers.google.com/google-ads/api/fields/latest/metrics');
      return {
        contents: [{ uri: 'resource://metrics', mimeType: 'text/html', text: html }],
      };
    },
  );

  server.registerResource(
    'get_release_notes',
    'resource://release-notes',
    {
      description: `Retrieve the Google Ads API release notes.

Provides the official release notes for the Google Ads API, detailing new
features, changes, deprecations, and bug fixes across all API versions.
Host LLMs should access this resource to check for breaking changes,
determine if a specific feature is supported in a given API version, or
troubleshoot issues by consulting recent API updates.

Returns:
    str: The release notes in HTML format.`,
      mimeType: 'text/html',
    },
    async (_uri: URL) => {
      const html = await fetchExternalDoc('https://developers.google.com/google-ads/api/docs/release-notes');
      return {
        contents: [{ uri: 'resource://release-notes', mimeType: 'text/html', text: html }],
      };
    },
  );

  server.registerResource(
    'get_segments',
    'resource://segments',
    {
      description: `Retrieve the Google Ads API segments documentation.

Provides the official documentation for segments in the Google Ads API,
detailing the available segments that can be used in GAQL queries to
partition metrics.
Host LLMs should access this resource to understand which segments
can be used with specific resources and metrics.

Returns:
    str: The segments documentation in HTML format.`,
      mimeType: 'text/html',
    },
    async (_uri: URL) => {
      const html = await fetchExternalDoc('https://developers.google.com/google-ads/api/fields/latest/segments');
      return {
        contents: [{ uri: 'resource://segments', mimeType: 'text/html', text: html }],
      };
    },
  );

  return server;
}
