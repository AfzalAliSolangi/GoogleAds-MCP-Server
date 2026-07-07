import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../shared/mcp-app.js';
import { buildSearchToolDescription } from '../shared/search-description.js';

describe('MCP server registration', () => {
  it('lists three tools and four resources (parity with google-ads-mcp surface)', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({});
    await server.connect(serverTransport);

    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(['get_resource_metadata', 'list_accessible_customers', 'search'].sort());

    const { resources } = await client.listResources();
    const uris = resources.map(r => r.uri).sort();
    expect(uris).toEqual(
      [
        'resource://discovery-document',
        'resource://metrics',
        'resource://release-notes',
        'resource://segments',
      ].sort(),
    );

    const search = tools.find(t => t.name === 'search');
    expect(search?.description).toContain('### Hints');
    expect(search?.description).toContain('get_resource_metadata');
    expect(search?.description).toContain('ad_group_criterion.negative = FALSE');
    expect(buildSearchToolDescription('2026-01-01')).toContain('accessible_bidding_strategy');
  });
});
