export const GAQL_DATE_LITERALS = new Set([
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_14_DAYS',
  'LAST_30_DAYS',
  'LAST_BUSINESS_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_WEEK_SUN_TODAY',
  'THIS_WEEK_MON_TODAY',
]);

const GAQL_IDENT = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
const GAQL_RESOURCE = /^[a-z_]+$/;

function assertGaqlIdentifier(value: string, label: string): void {
  if (!GAQL_IDENT.test(value)) throw new Error(`Invalid GAQL ${label}: "${value}"`);
}

export function buildGaqlQuery(args: {
  fields: string[];
  resource: string;
  conditions?: string[] | null;
  orderings?: string[] | null;
  limit?: number | string | null;
  date_range?: string | null;
}): string {
  if (!GAQL_RESOURCE.test(args.resource)) throw new Error(`Invalid GAQL resource: "${args.resource}"`);
  for (const f of args.fields) assertGaqlIdentifier(f, 'field');
  if (args.orderings?.length) {
    for (const o of args.orderings) {
      // orderings may be "field.name ASC" or "field.name DESC"
      const base = o.replace(/\s+(ASC|DESC)$/i, '').trim();
      assertGaqlIdentifier(base, 'ordering');
    }
  }

  const allConditions: string[] = [];
  if (args.date_range && GAQL_DATE_LITERALS.has(args.date_range)) {
    allConditions.push(`segments.date DURING ${args.date_range}`);
  }
  if (args.conditions?.length) allConditions.push(...args.conditions);

  const parts: string[] = [`SELECT ${args.fields.join(',')} FROM ${args.resource}`];
  if (allConditions.length) {
    parts.push(` WHERE ${allConditions.join(' AND ')}`);
  }
  if (args.orderings?.length) {
    parts.push(` ORDER BY ${args.orderings.join(',')}`);
  }
  if (args.limit != null && args.limit !== '') {
    parts.push(` LIMIT ${args.limit}`);
  }
  parts.push(' PARAMETERS omit_unselected_resource_names=true');
  return parts.join('');
}
