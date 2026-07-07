import { GAQL_RESOURCES_TEXT } from './gaql_resources_embed.js';

const SEARCH_DOC = `Fetches data from the Google Ads API using the search method

Args:
    customer_id: The id of the customer
    fields: The fields to fetch
    resource: The resource to return fields from
    conditions: List of conditions to filter the data, combined using AND clauses
    orderings: How the data is ordered
    limit: The maximum number of rows to return
    date_range: GAQL date range literal or CUSTOM`;

/**
 * @param todayIso - Today's date in YYYY-MM-DD format, injected by the caller so Claude
 *                   always computes date ranges relative to the real current date.
 */
export function buildSearchToolDescription(todayIso: string): string {
  const fileContent = GAQL_RESOURCES_TEXT.trim().length
    ? GAQL_RESOURCES_TEXT.trimEnd()
    : 'WARNING: The list of valid resources is missing.';
  return `
${SEARCH_DOC}


### CRITICAL RULES — read before every single call to this tool

    RULE 1 — NEVER FABRICATE DATA
        Every number, metric, search term, impression count, cost, or any other value you
        present to the user MUST come verbatim from the tool result.
        If the API returns no data or an empty result array, tell the user exactly that.
        Do NOT fill gaps, estimate, approximate, or invent values of any kind.

    RULE 2 — ALWAYS ASK FOR DATE RANGE — NO EXCEPTIONS, NO DEFAULTS
        There is NO default date range. "Last 30 days" is NOT a default.
        ANY query that touches metrics, performance, spend, clicks, impressions, CTR,
        conversions, search terms, or rankings REQUIRES an explicit date range from the user.

        This includes (but is not limited to) requests like:
            "show me top campaigns"          → requires date range
            "what are my best search terms"  → requires date range
            "review campaign performance"    → requires date range
            "how much did we spend"          → requires date range
            "which ads are converting"       → requires date range

        If the user has not stated a specific date range in their message, STOP and ask:
            "Which date range would you like to analyse? For example:
             last 7 days, last 30 days, this month, last month,
             or a custom range like 2026-01-01 to 2026-03-31?"

        Only skip this question for structural queries with no metrics
        (e.g. "list my campaigns" with only id/name fields, no spend/clicks/etc.).

    RULE 3 — NO IMPLICIT WHERE CONDITIONS
        Only add WHERE conditions that the user explicitly requested.
        Never silently add filters such as campaign.status = 'ENABLED' unless the user
        specifically asked for active-only results.

    RULE 4 — COST FIELDS ARE IN MICROS
        All cost and value fields (e.g. metrics.cost_micros, metrics.average_cpc) are
        returned in micros — one-millionth of the account currency unit.
        Divide by 1,000,000 to obtain the real currency amount before displaying to users.
        The tool result includes "cost_fields_are_in_micros": true as a reminder.

    RULE 5 — RESULTS MAY BE TRUNCATED
        The tool result includes "may_be_truncated": true when no LIMIT was set.
        If this flag is true, tell the user the results may be incomplete and offer to
        refine the query with a LIMIT or additional filters.

    RULE 6 — VERIFY WHICH ACCOUNT WAS QUERIED
        The tool result always includes "queried_customer_id". Before presenting results,
        confirm to the user which account ID the data comes from.

    RULE 7 — ABSENT FIELD ≠ NULL VALUE
        The Google Ads API uses fieldMask to omit unrequested fields.
        If a field you selected does not appear in a row, it was excluded by fieldMask —
        not zero, not null, not missing from the account. Do NOT infer a value for it.

    RULE 8 — SHOW YOUR WORK FOR DERIVED METRICS
        If you compute a derived metric (e.g. CTR = clicks / impressions), always show
        the raw API values alongside the calculation so the user can verify independently.

    RULE 9 — ASK WHICH ACCOUNT(S) TO QUERY
        If the user has not explicitly stated which Google Ads account (customer ID) to
        analyse, you MUST ask them before calling this tool. Do NOT assume or pick one
        arbitrarily.
        If the user is unsure which accounts are available, call list_accessible_customers
        first to show them the options, then ask them to choose.
        Suggested clarification:
            "Which Google Ads account would you like to analyse? If you're not sure, I can
             look up the accounts you have access to first."


### Hints
    Language Grammar can be found at https://developers.google.com/google-ads/api/docs/query/grammar
    All resources and descriptions are found at https://developers.google.com/google-ads/api/fields/v23/overview

    For Conversion issues try looking in offline_conversion_upload_conversion_action_summary

### Hint for customer_id
    Must be a string of digits without punctuation.
    If presented as 123-456-7890, remove the hyphens → 1234567890.
    If the user has not specified which account to query, apply RULE 9 above: ask first.
    Never pick a customer_id from a previous query or from memory.

### Hints for Dates
    TODAY IS ${todayIso}. Use this as your only reference for date arithmetic.

    Standard windows — set date_range to one of these literals; the server injects the
    GAQL condition automatically (you never write the date string yourself):
        TODAY | YESTERDAY | LAST_7_DAYS | LAST_14_DAYS | LAST_30_DAYS
        LAST_BUSINESS_WEEK | THIS_MONTH | LAST_MONTH
        THIS_WEEK_SUN_TODAY | THIS_WEEK_MON_TODAY

    Custom windows — set date_range='CUSTOM' and add the condition to conditions[].
    Always derive the dates from TODAY (${todayIso}). Example for past 30 days:
        "segments.date >= '${thirtyDaysAgo(todayIso)}' AND segments.date <= '${todayIso}'"
    Dates must be YYYY-MM-DD with dashes. Both start and end are required.

    Omit date_range only when the query truly needs no date filter (e.g. listing campaigns).
    Omitting it for any performance or impression query is an error.

### Hints for limits
    Requests to resource change_event must specify a LIMIT of less than or equal to 10000

### Hints for conversions questions
    https://developers.google.com/google-ads/api/docs/conversions/upload-summaries


### Hint for keyword_view
    keyword_view returns BOTH positive (target) keywords AND negative keywords.
    Unless the user explicitly asks for negative keywords, you MUST include this condition:
        ad_group_criterion.negative = FALSE
    Omitting it inflates row counts with negatives that carry zero spend and corrupt analysis.

### Hints for all resources
    What follows is a list of valid resources that can be queried.
    To find out which specific fields you can select, filter by, or sort by for a given resource, you MUST use the \`get_resource_metadata\` tool.
    Do not guess the fields. Use the tool to look them up.
    Once you have the fields, ensure the whole field name is used (e.g., 'campaign.id', not just 'id'). Wildcards and partial fields are not allowed.
    ${fileContent}
`;
}

function thirtyDaysAgo(todayIso: string): string {
  const d = new Date(todayIso);
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}
