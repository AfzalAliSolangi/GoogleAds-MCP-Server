import type { GaMcpEnv } from './env.js';

export function normalizeCustomerId(id: string): string {
  return id.replace(/[\s-]/g, '');
}

/** undefined = unrestricted; [] = deny all */
export function parseAllowedCustomerIds(env: GaMcpEnv): string[] | undefined {
  if (env.ALLOWED_CUSTOMER_IDS === undefined) return undefined;
  return env.ALLOWED_CUSTOMER_IDS.split(',').map(s => normalizeCustomerId(s.trim())).filter(Boolean);
}

export function isCustomerAllowed(allowed: string[] | undefined, customerId: string): boolean {
  if (allowed === undefined) return true;
  if (allowed.length === 0) return false;
  return allowed.includes(normalizeCustomerId(customerId));
}
