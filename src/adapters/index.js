/**
 * Destination registry.
 *
 * Each destination gets its own rate limiter so a slow or throttled CRM
 * doesn't consume another destination's quota.
 */
import { config } from '../config.js';
import { RateLimiter } from '../utils/rateLimiter.js';
import { salesforce } from './salesforce.js';
import { zoho } from './zoho.js';
import { googleSheets } from './googleSheets.js';
import { airtable } from './airtable.js';
import { createDryRunAdapter } from './dryRun.js';

const REAL = { salesforce, zoho, sheets: googleSheets, airtable };

export const HIGH_BUDGET_TARGETS = ['salesforce', 'zoho'];
export const LOW_BUDGET_TARGETS = ['sheets', 'airtable'];

// Airtable hard limit: 5 req/s per base = 300/min.
const RPM_CAPS = { airtable: 300 };

/**
 * @param {{ dryRun: boolean }} opts
 * @returns {Record<string, { name: string, isConfigured: () => boolean, send: Function, limiter: RateLimiter }>}
 */
export function buildDestinations({ dryRun }) {
  const out = {};
  for (const [name, adapter] of Object.entries(REAL)) {
    const rpm = Math.min(config.delivery.destinationRpm, RPM_CAPS[name] ?? Infinity);
    out[name] = {
      ...(dryRun ? createDryRunAdapter(name) : adapter),
      limiter: new RateLimiter({ requestsPerMinute: rpm, burst: 3, name }),
    };
  }
  return out;
}
