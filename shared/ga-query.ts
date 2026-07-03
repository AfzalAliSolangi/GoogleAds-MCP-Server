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

export function buildGaqlQuery(args: {
  fields: string[];
  resource: string;
  conditions?: string[] | null;
  orderings?: string[] | null;
  limit?: number | string | null;
  date_range?: string | null;
}): string {
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
