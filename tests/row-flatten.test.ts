import { describe, expect, it } from 'vitest';
import { flattenGoogleAdsRow, parseFieldMaskPaths, parseSearchStreamJsonBody } from '../shared/row-flatten.js';

describe('row-flatten', () => {
  it('parses field mask paths', () => {
    expect(parseFieldMaskPaths('campaign.id,campaign.name')).toEqual(['campaign.id', 'campaign.name']);
  });

  it('flattens REST camelCase row using snake_case GAQL paths', () => {
    const row = {
      campaign: { id: '1', name: 'N' },
      metrics: { clicks: '5' },
    };
    const flat = flattenGoogleAdsRow(row, ['campaign.id', 'campaign.name', 'metrics.clicks']);
    expect(flat).toEqual({
      'campaign.id': '1',
      'campaign.name': 'N',
      'metrics.clicks': '5',
    });
  });

  it('parses searchStream JSON array body', () => {
    const body = `[{"results":[{"campaign":{"id":"1"}}],"fieldMask":"campaign.id"}]`;
    const chunks = parseSearchStreamJsonBody(body);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].fieldMask).toBe('campaign.id');
    expect(flattenGoogleAdsRow(chunks[0].results![0], parseFieldMaskPaths(chunks[0].fieldMask))).toEqual({
      'campaign.id': '1',
    });
  });
});
