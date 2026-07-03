import type { GaMcpEnv } from './env.js';

export function normalizeCustomerId(id: string): string {
  const normalized = id.replace(/[\s-]/g, '');
  if (!normalized || !/^\d+$/.test(normalized)) {
    throw new Error(`Invalid customer ID "${id}": must contain only digits (hyphens/spaces allowed as separators)`);
  }
  return normalized;
}

/** undefined = unrestricted; [] = deny all */
export function parseAllowedCustomerIds(env: GaMcpEnv): string[] | undefined {
  if (env.ALLOWED_CUSTOMER_IDS === undefined) return undefined;
  return env.ALLOWED_CUSTOMER_IDS.split(',').map(s => s.trim()).filter(Boolean).map(normalizeCustomerId);
}

export function isCustomerAllowed(allowed: string[] | undefined, customerId: string): boolean {
  if (allowed === undefined) return true;
  if (allowed.length === 0) return false;
  return allowed.includes(normalizeCustomerId(customerId));
}
