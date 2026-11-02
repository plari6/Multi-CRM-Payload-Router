import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeadRouter } from '../src/router.js';
import { RateLimiter } from '../src/utils/rateLimiter.js';
import { HttpError } from '../src/utils/retry.js';
import { verifySignature } from '../src/server.js';
import { escapeCell } from '../src/utils/csvWriter.js';
import { createHmac } from 'node:crypto';

/** In-memory destination that records what it receives, or fails on demand. */
function fakeDest(name, { fail = null } = {}) {
  const sent = [];
  return {
    name,
    sent,
    isConfigured: () => true,
    limiter: new RateLimiter({ requestsPerMinute: 60000, burst: 100 }),
    async send(lead, meta) {
      if (fail) throw fail;
      sent.push({ lead, meta });
      return { externalId: `${name}-${sent.length}` };
    },
  };
}

async function makeRouter({ highFail, lowFail, extractor } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'router-test-'));
  const destinations = {
    salesforce: fakeDest('salesforce', { fail: highFail }),
    zoho: fakeDest('zoho'),
    sheets: fakeDest('sheets', { fail: lowFail }),
    airtable: fakeDest('airtable'),
  };
  const router = new LeadRouter({
    dryRun: false,
    threshold: 10000,
    highTarget: 'salesforce',
    lowTarget: 'sheets',
    destinations,
    extractor,
    maxRetries: 1,
    deadLetterFile: join(dir, 'dead.jsonl'),
  });
  return { router, destinations, deadLetterFile: router.deadLetterFile };
}

const lead = (budget, extra = {}) => ({ email: `x${Math.random()}@acme.com`, company: 'Acme', last_name: 'Doe', budget, ...extra });

test('high budget goes to the high-budget CRM, low budget to the sheet', async () => {
  const { router, destinations } = await makeRouter();
  const high = await router.route(lead('$50,000'));
  const low = await router.route(lead('2000'));
  assert.equal(high.tier, 'high');
  assert.equal(high.destination, 'salesforce');
  assert.equal(low.tier, 'low');
  assert.equal(low.destination, 'sheets');
  assert.equal(destinations.salesforce.sent.length, 1);
  assert.equal(destinations.sheets.sent.length, 1);
});

test('threshold is inclusive', async () => {
  const { router } = await makeRouter();
  assert.equal((await router.route(lead('10000'))).tier, 'high');
});

test('invalid leads are skipped and never sent', async () => {
  const { router, destinations } = await makeRouter();
  const r = await router.route({ email: 'bad', company: 'X', budget: '50000' });
  assert.equal(r.status, 'skipped');
  assert.equal(destinations.salesforce.sent.length, 0);
});

test('duplicates are detected', async () => {
  const { router } = await makeRouter();
  const payload = lead('5000', { id: 'dup-1' });
  assert.equal((await router.route(payload)).status, 'routed');
  assert.equal((await router.route(payload)).status, 'duplicate');
});

test('failed high-budget CRM falls back to the low-budget sink', async () => {
  const { router, destinations } = await makeRouter({ highFail: new HttpError('down', { status: 400 }) });
  const r = await router.route(lead('99000'));
  assert.equal(r.status, 'fallback');
  assert.equal(r.destination, 'sheets');
  assert.equal(destinations.sheets.sent[0].meta.fallbackFrom, 'salesforce');
});

test('when everything fails the lead goes to the dead-letter file', async () => {
  const err = new HttpError('nope', { status: 400 });
  const { router, deadLetterFile } = await makeRouter({ highFail: err, lowFail: err });
  const r = await router.route(lead('99000', { id: 'lost-1' }));
  assert.equal(r.status, 'failed');
  const saved = JSON.parse((await readFile(deadLetterFile, 'utf8')).trim());
  assert.equal(saved.lead.id, 'lost-1');
});

test('AI is used only when rules cannot read the budget', async () => {
  let calls = 0;
  const extractor = { available: true, extract: async () => (calls++, { amountUsd: 50000, currency: 'USD' }) };
  const { router } = await makeRouter({ extractor });
  assert.equal((await router.route(lead('25k'))).budget_method, 'rules');
  const r = await router.route(lead('mid five figures'));
  assert.equal(r.budget_method, 'ai');
  assert.equal(r.tier, 'high');
  assert.equal(calls, 1);
});

test('webhook signature check', () => {
  const body = Buffer.from('{"email":"a@b.com"}');
  const sig = createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifySignature(body, `sha256=${sig}`, 's3cret'), true);
  assert.equal(verifySignature(body, `sha256=${sig}`, 'wrong'), false);
  assert.equal(verifySignature(body, undefined, 's3cret'), false);
});

test('CSV output neutralises formulas', () => {
  assert.equal(escapeCell('=1+1'), "'=1+1");
  assert.equal(escapeCell('-500'), '-500');
  assert.equal(escapeCell('a,b'), '"a,b"');
});
