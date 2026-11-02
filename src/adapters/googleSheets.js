/**
 * Google Sheets adapter: appends one row per lead.
 *
 * Auth uses a Google Cloud service account (OAuth2 JWT bearer flow). The JWT is
 * signed with Node's built-in crypto, so the large `googleapis` package isn't needed.
 * Share the spreadsheet with the service account's email as an Editor.
 */
import { createSign } from 'node:crypto';
import { config, hasAll } from '../config.js';
import { TokenCache } from '../auth/tokenCache.js';
import { fetchJson, HttpError } from '../utils/retry.js';

const gs = config.sheets;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const b64url = (input) => Buffer.from(input).toString('base64url');

function signJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: gs.serviceAccountEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(gs.privateKey, 'base64url');
  return `${header}.${claims}.${signature}`;
}

const tokens = new TokenCache(async () => {
  const body = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt() }),
  });
  return { accessToken: body.access_token, expiresInSec: body.expires_in };
});

/** Column order of the sheet. Put matching headers in row 1 of your sheet. */
export const SHEET_COLUMNS = ['Received At', 'Lead ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Company', 'Budget (raw)', 'Budget USD', 'Source', 'Message'];

export const googleSheets = {
  name: 'sheets',

  isConfigured: () => hasAll(gs.spreadsheetId, gs.serviceAccountEmail, gs.privateKey),

  async send(lead, meta) {
    const row = [
      new Date().toISOString(),
      lead.id,
      lead.firstName,
      lead.lastName,
      lead.email,
      lead.phone,
      lead.company,
      lead.budgetRaw,
      meta.amountUsd ?? '',
      lead.source,
      lead.message,
    ];

    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(gs.spreadsheetId)}` +
      `/values/${encodeURIComponent(gs.range)}:append` +
      // RAW (not USER_ENTERED) so a lead typing "=HYPERLINK(...)" can't inject a formula.
      '?valueInputOption=RAW&insertDataOption=INSERT_ROWS';

    const post = async () =>
      fetchJson(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await tokens.get()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] }),
      });

    let body;
    try {
      body = await post();
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 401)) throw err;
      tokens.invalidate();
      body = await post();
    }
    return { externalId: body?.updates?.updatedRange || '' };
  },
};
