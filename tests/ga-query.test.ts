import { describe, expect, it } from 'vitest';
import { buildGaqlQuery, GAQL_DATE_LITERALS } from '../shared/ga-query.js';

describe('buildGaqlQuery', () => {
  it('matches Python google-ads-mcp composition and PARAMETERS suffix', () => {
    const q = buildGaqlQuery({
      fields: ['campaign.id', 'campaign.name'],
      resource: 'campaign',
      conditions: ["campaign.status = 'ENABLED'"],
      orderings: ['campaign.id'],
      limit: 10,
    });
    expect(q).toBe(
      "SELECT campaign.id,campaign.name FROM campaign WHERE campaign.status = 'ENABLED' ORDER BY campaign.id LIMIT 10 PARAMETERS omit_unselected_resource_names=true",
    );
  });

  it('omits optional clauses when absent', () => {
    expect(buildGaqlQuery({ fields: ['customer.id'], resource: 'customer' })).toBe(
      'SELECT customer.id FROM customer PARAMETERS omit_unselected_resource_names=true',
    );
  });

  it('prepends segments.date DURING when date_range is a known literal', () => {
    const q = buildGaqlQuery({
      fields: ['search_term_view.search_term', 'metrics.impressions'],
      resource: 'search_term_view',
      date_range: 'LAST_30_DAYS',
    });
    expect(q).toContain('WHERE segments.date DURING LAST_30_DAYS');
    expect(q).not.toContain('DURING undefined');
  });

  it('merges date_range literal before additional conditions', () => {
    const q = buildGaqlQuery({
      fields: ['campaign.id'],
      resource: 'campaign',
      date_range: 'LAST_7_DAYS',
      conditions: ["campaign.status = 'ENABLED'"],
    });
    expect(q).toContain(
      "WHERE segments.date DURING LAST_7_DAYS AND campaign.status = 'ENABLED'",
    );
  });

  it('does not inject date when date_range is CUSTOM', () => {
    const q = buildGaqlQuery({
      fields: ['campaign.id'],
      resource: 'campaign',
      date_range: 'CUSTOM',
      conditions: ["segments.date >= '2026-01-01' AND segments.date <= '2026-03-31'"],
    });
    expect(q).not.toContain('DURING');
    expect(q).toContain("segments.date >= '2026-01-01'");
  });

  it('does not inject date when date_range is null or omitted', () => {
    const q = buildGaqlQuery({ fields: ['customer.id'], resource: 'customer', date_range: null });
    expect(q).not.toContain('WHERE');
    expect(GAQL_DATE_LITERALS.has('LAST_30_DAYS')).toBe(true);
    expect(GAQL_DATE_LITERALS.has('CUSTOM')).toBe(false);
  });
});
