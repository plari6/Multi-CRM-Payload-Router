/**
 * Salesforce adapter: creates a Lead record through the REST API.
 *
 * OAuth2 flows supported (set up a Connected App / External Client App first):
 *  - Client Credentials: SALESFORCE_CLIENT_ID + SALESFORCE_CLIENT_SECRET
 *  - Refresh Token:      the above + SALESFORCE_REFRESH_TOKEN
 */
import { config, hasAll } from '../config.js';
import { TokenCache } from '../auth/tokenCache.js';
import { fetchJson, HttpError } from '../utils/retry.js';
import { describeLead } from './format.js';

const sf = config.salesforce;

const tokens = new TokenCache(async () => {
  const params = new URLSearchParams({ client_id: sf.clientId, client_secret: sf.clientSecret });
  if (sf.refreshToken) {
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', sf.refreshToken);
  } else {
    params.set('grant_type', 'client_credentials');
  }

  const body = await fetchJson(`${sf.instanceUrl.replace(/\/$/, '')}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  // Salesforce doesn't return expires_in; tokens live as long as the org's session timeout.
  // We cache for 30 minutes and refresh early on any 401.
  return { accessToken: body.access_token, expiresInSec: 1800, extra: { instanceUrl: body.instance_url } };
});

export const salesforce = {
  name: 'salesforce',

  isConfigured: () => hasAll(sf.instanceUrl, sf.clientId, sf.clientSecret),

  /**
   * @param {import('../lead/types.js').Lead} lead
   * @param {{ amountUsd: number|null, tier: string }} meta
   */
  async send(lead, meta) {
    const record = {
      FirstName: lead.firstName || undefined,
      // LastName and Company are required on the standard Lead object.
      LastName: lead.lastName || lead.company,
      Company: lead.company || `${lead.firstName} ${lead.lastName}`.trim(),
      Email: lead.email,
      Phone: lead.phone || undefined,
      Description: describeLead(lead, meta),
    };
    // Optional custom number field, e.g. SALESFORCE_BUDGET_FIELD=Budget__c
    if (process.env.SALESFORCE_BUDGET_FIELD && meta.amountUsd !== null) {
      record[process.env.SALESFORCE_BUDGET_FIELD] = meta.amountUsd;
    }

    const post = async () => {
      const accessToken = await tokens.get();
      const base = (tokens.extra.instanceUrl || sf.instanceUrl).replace(/\/$/, '');
      return fetchJson(`${base}/services/data/${sf.apiVersion}/sobjects/Lead`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
    };

    let body;
    try {
      body = await post();
    } catch (err) {
      // Expired session: get a new token and try once more.
      if (!(err instanceof HttpError && err.status === 401)) throw err;
      tokens.invalidate();
      body = await post();
    }
    return { externalId: body.id };
  },
};
