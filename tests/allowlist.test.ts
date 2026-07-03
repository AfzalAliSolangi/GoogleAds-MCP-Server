import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { isCustomerAllowed, normalizeCustomerId, parseAllowedCustomerIds } from '../shared/allowlist.js';
import { createMcpServer } from '../shared/mcp-app.js';
import type { GaMcpEnv } from '../shared/env.js';

describe('normalizeCustomerId', () => {
  it('strips hyphens', () => expect(normalizeCustomerId('123-456-7890')).toBe('1234567890'));
  it('strips spaces', () => expect(normalizeCustomerId('123 456')).toBe('123456'));
  it('leaves plain id alone', () => expect(normalizeCustomerId('1234567890')).toBe('1234567890'));
});

describe('parseAllowedCustomerIds', () => {
  it('undefined env var → undefined (unrestricted)', () => {
    expect(parseAllowedCustomerIds({})).toBeUndefined();
  });
  it('empty string → [] (deny all)', () => {
    expect(parseAllowedCustomerIds({ ALLOWED_CUSTOMER_IDS: '' })).toEqual([]);
  });
  it('normalizes and splits', () => {
    expect(parseAllowedCustomerIds({ ALLOWED_CUSTOMER_IDS: '123-456-7890, 999' }))
      .toEqual(['1234567890', '999']);
  });
});

describe('isCustomerAllowed', () => {
  it('undefined → always true', () => expect(isCustomerAllowed(undefined, '123')).toBe(true));
  it('[] → always false', () => expect(isCustomerAllowed([], '123')).toBe(false));
  it('listed id allowed', () => expect(isCustomerAllowed(['1234567890'], '1234567890')).toBe(true));
  it('unlisted id denied', () => expect(isCustomerAllowed(['1234567890'], '9999999999')).toBe(false));
  it('normalizes on check', () => expect(isCustomerAllowed(['1234567890'], '123-456-7890')).toBe(true));
});

// Helper: create connected MCP client backed by createMcpServer(env)
async function mcpClient(env: GaMcpEnv) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(env);
  await server.connect(serverTransport);
  const client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('search tool allowlist enforcement', () => {
  it('unrestricted (no ALLOWED_CUSTOMER_IDS): no allowlist error (may fail on missing creds, that is fine)', async () => {
    const client = await mcpClient({ ALLOWED_CUSTOMER_IDS: undefined });
    const result = await client.callTool({ name: 'search', arguments: { customer_id: '1234567890', fields: ['campaign.id'], resource: 'campaign' } }) as { isError?: boolean; content: Array<{ text: string }> };
    // Unrestricted — any failure must NOT be an allowlist error
    if (result.isError) {
      expect(result.content[0]?.text).not.toContain('not in this client\'s allowed accounts');
      expect(result.content[0]?.text).not.toContain('no customer IDs are configured');
    }
  });

  it('empty allowlist: denies without hitting API', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const client = await mcpClient({ ALLOWED_CUSTOMER_IDS: '' });
    const result = await client.callTool({ name: 'search', arguments: { customer_id: '1234567890', fields: ['campaign.id'], resource: 'campaign' } }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no customer IDs are configured');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('disallowed customer_id: denies without hitting API', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const client = await mcpClient({ ALLOWED_CUSTOMER_IDS: '1111111111' });
    const result = await client.callTool({ name: 'search', arguments: { customer_id: '9999999999', fields: ['campaign.id'], resource: 'campaign' } }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not in this client\'s allowed accounts');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('hyphenated customer_id matches normalized allowlist entry', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const client = await mcpClient({ ALLOWED_CUSTOMER_IDS: '1234567890' });
    const result = await client.callTool({ name: 'search', arguments: { customer_id: '123-456-7890', fields: ['campaign.id'], resource: 'campaign' } }) as { isError?: boolean; content: Array<{ text: string }> };
    // Should NOT be an allowlist error (may fail later due to missing Google Ads creds, that's fine)
    if (result.isError) {
      expect(result.content[0]?.text).not.toContain('allowed accounts');
    }
    fetchSpy.mockRestore();
  });
});

describe('list_accessible_customers allowlist filtering', () => {
  it('filters response to allowlist intersection', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ resourceNames: ['customers/111', 'customers/222', 'customers/333'] }), { status: 200 }));
    const client = await mcpClient({ ALLOWED_CUSTOMER_IDS: '111,333', GOOGLE_ADS_DEVELOPER_TOKEN: 'tok', GOOGLE_ADS_REFRESH_TOKEN: 'r', GOOGLE_ADS_OAUTH_CLIENT_ID: 'c', GOOGLE_ADS_OAUTH_CLIENT_SECRET: 's' });
    const result = await client.callTool({ name: 'list_accessible_customers', arguments: {} }) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.result).toEqual(expect.arrayContaining(['111', '333']));
    expect(parsed.result).not.toContain('222');
    fetchSpy.mockRestore();
  });

  it('empty allowlist → returns []', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ resourceNames: ['customers/111'] }), { status: 200 }));
    const client = await mcpClient({ ALLOWED_CUSTOMER_IDS: '', GOOGLE_ADS_DEVELOPER_TOKEN: 'tok', GOOGLE_ADS_REFRESH_TOKEN: 'r', GOOGLE_ADS_OAUTH_CLIENT_ID: 'c', GOOGLE_ADS_OAUTH_CLIENT_SECRET: 's' });
    const result = await client.callTool({ name: 'list_accessible_customers', arguments: {} }) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.result).toEqual([]);
    fetchSpy.mockRestore();
  });
});
