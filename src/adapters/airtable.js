/**
 * Airtable adapter: creates one record per lead.
 *
 * Auth: a Personal Access Token with scope data.records:write on the target base.
 * Airtable allows 5 requests/second per base; the router's rate limiter keeps us under that.
 */
import { config, hasAll } from '../config.js';
import { fetchJson } from '../utils/retry.js';

const at = config.airtable;

export const airtable = {
  name: 'airtable',

  isConfigured: () => hasAll(at.token, at.baseId, at.table),

  async send(lead, meta) {
    const fields = {
      'Lead ID': lead.id,
      'First Name': lead.firstName,
      'Last Name': lead.lastName,
      Email: lead.email,
      Phone: lead.phone,
      Company: lead.company,
      'Budget (raw)': lead.budgetRaw,
      'Budget USD': meta.amountUsd ?? undefined,
      Source: lead.source,
      Message: lead.message,
    };

    const body = await fetchJson(`https://api.airtable.com/v0/${at.baseId}/${encodeURIComponent(at.table)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${at.token}`, 'Content-Type': 'application/json' },
      // typecast lets Airtable convert values (e.g. create single-select options) instead of rejecting them.
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
    return { externalId: body.records?.[0]?.id || '' };
  },
};
