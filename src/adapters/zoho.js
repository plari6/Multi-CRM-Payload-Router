/**
 * Zoho CRM adapter: creates a record in the Leads module (API v6).
 *
 * OAuth2: Zoho uses the refresh-token flow. Create a "Self Client" in the
 * Zoho API Console with scope ZohoCRM.modules.leads.CREATE, then exchange
 * the grant code once for a refresh token.
 */
import { config, hasAll } from '../config.js';
import { TokenCache } from '../auth/tokenCache.js';
import { fetchJson, HttpError } from '../utils/retry.js';
import { describeLead } from './format.js';

const zc = config.zoho;

const tokens = new TokenCache(async () => {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: zc.refreshToken,
    client_id: zc.clientId,
    client_secret: zc.clientSecret,
  });
  const body = await fetchJson(`${zc.accountsUrl.replace(/\/$/, '')}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  // Zoho answers 200 with { error: "invalid_code" } on bad credentials.
  if (!body.access_token) throw new HttpError(`Zoho token error: ${body.error || 'unknown'}`, { status: 401 });
  return { accessToken: body.access_token, expiresInSec: body.expires_in };
});

export const zoho = {
  name: 'zoho',

  isConfigured: () => hasAll(zc.clientId, zc.clientSecret, zc.refreshToken),

  async send(lead, meta) {
    const record = {
      First_Name: lead.firstName || undefined,
      Last_Name: lead.lastName || lead.company,
      Company: lead.company || undefined,
      Email: lead.email,
      Phone: lead.phone || undefined,
      Description: describeLead(lead, meta),
    };
    if (process.env.ZOHO_BUDGET_FIELD && meta.amountUsd !== null) {
      record[process.env.ZOHO_BUDGET_FIELD] = meta.amountUsd;
    }

    const post = async () =>
      fetchJson(`${zc.apiDomain.replace(/\/$/, '')}/crm/v6/Leads`, {
        method: 'POST',
        headers: { Authorization: `Zoho-oauthtoken ${await tokens.get()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [record], trigger: ['workflow'] }),
      });

    let body;
    try {
      body = await post();
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 401)) throw err;
      tokens.invalidate();
      body = await post();
    }

    // Zoho reports per-record results inside a successful HTTP response.
    const row = body?.data?.[0];
    if (row?.status !== 'success') {
      throw new HttpError(`Zoho rejected lead: ${row?.code || 'UNKNOWN'} ${row?.message || ''}`.trim(), { status: 400, body });
    }
    return { externalId: row.details.id };
  },
};
