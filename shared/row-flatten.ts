/** ad_group_criterion → adGroupCriterion */
export function snakeToCamelSegment(segment: string): string {
  return segment.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function getChild(obj: Record<string, unknown>, segment: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, segment)) {
    return obj[segment];
  }
  const camel = snakeToCamelSegment(segment);
  if (Object.prototype.hasOwnProperty.call(obj, camel)) {
    return obj[camel];
  }
  return undefined;
}

export function getAtFieldPath(row: unknown, dottedPath: string): unknown {
  const segments = dottedPath.split('.');
  let cur: unknown = row;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = getChild(cur as Record<string, unknown>, seg);
  }
  return cur;
}

/**
 * Google Ads REST JSON sometimes wraps primitives; unwrap common patterns.
 */
export function formatCellValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.type === 'string' && 'value' in o) {
      return formatCellValue(o.value);
    }
  }
  return value;
}

export function flattenGoogleAdsRow(
  row: unknown,
  fieldPaths: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of fieldPaths) {
    const p = path.trim();
    if (!p) continue;
    const raw = getAtFieldPath(row, p);
    out[p] = formatCellValue(raw);
  }
  return out;
}

export function parseFieldMaskPaths(fieldMask: string | undefined): string[] {
  if (!fieldMask?.trim()) return [];
  return fieldMask
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export type SearchStreamChunk = {
  results?: unknown[];
  fieldMask?: string;
};

export function parseSearchStreamJsonBody(text: string): SearchStreamChunk[] {
  const trimmed = text.trim();
  const parsed: unknown = JSON.parse(trimmed);
  if (Array.isArray(parsed)) {
    return parsed as SearchStreamChunk[];
  }
  if (parsed && typeof parsed === 'object' && 'results' in (parsed as object)) {
    return [parsed as SearchStreamChunk];
  }
  return [];
}
