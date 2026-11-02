/**
 * LeadRouter: the core decision engine shared by the webhook server and the CSV CLI.
 *
 *   payload -> normalize -> validate -> resolve budget -> pick tier -> deliver
 *
 * Delivery chain (so a lead is never silently lost):
 *   1. Primary destination for its tier (with rate limiting + retries)
 *   2. High-budget lead whose CRM failed -> low-budget sink, flagged "fallback"
 *   3. Everything failed -> appended to the dead-letter file for replay
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';
import { normalizeLead, validateLead } from './lead/normalize.js';
import { parseBudget } from './lead/budget.js';
import { buildDestinations, HIGH_BUDGET_TARGETS, LOW_BUDGET_TARGETS } from './adapters/index.js';
import { withRetry } from './utils/retry.js';
import { logger } from './utils/logger.js';

const DEDUPE_CAPACITY = 10_000;

export class LeadRouter {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun]
   * @param {number}  [opts.threshold]     USD amount at which a lead counts as high-budget.
   * @param {string}  [opts.highTarget]    'salesforce' | 'zoho'
   * @param {string}  [opts.lowTarget]     'sheets' | 'airtable'
   * @param {import('./ai/geminiBudgetExtractor.js').GeminiBudgetExtractor|null} [opts.extractor]
   * @param {object}  [opts.destinations]  Override adapters (used by tests).
   */
  constructor(opts = {}) {
    this.dryRun = opts.dryRun ?? config.routing.dryRun;
    this.threshold = opts.threshold ?? config.routing.highBudgetThreshold;
    this.highTarget = opts.highTarget ?? config.routing.highBudgetDestination;
    this.lowTarget = opts.lowTarget ?? config.routing.lowBudgetDestination;
    this.extractor = opts.extractor ?? null;
    this.destinations = opts.destinations ?? buildDestinations({ dryRun: this.dryRun });
    this.deadLetterFile = opts.deadLetterFile ?? config.delivery.deadLetterFile;
    this.maxRetries = opts.maxRetries ?? config.delivery.maxRetries;
    this.seen = new Set();
  }

  /**
   * Checks settings before any lead is processed.
   * @returns {string[]} Problems found; empty means ready.
   */
  preflight() {
    const problems = [];
    if (!HIGH_BUDGET_TARGETS.includes(this.highTarget)) {
      problems.push(`HIGH_BUDGET_DESTINATION must be one of ${HIGH_BUDGET_TARGETS.join(', ')} (got "${this.highTarget}")`);
    }
    if (!LOW_BUDGET_TARGETS.includes(this.lowTarget)) {
      problems.push(`LOW_BUDGET_DESTINATION must be one of ${LOW_BUDGET_TARGETS.join(', ')} (got "${this.lowTarget}")`);
    }
    if (!(this.threshold > 0)) problems.push('HIGH_BUDGET_THRESHOLD must be a positive number');
    if (problems.length) return problems;

    for (const target of [this.highTarget, this.lowTarget]) {
      if (!this.destinations[target].isConfigured()) {
        problems.push(`"${target}" credentials are missing in .env (or run with --dry-run)`);
      }
    }
    return problems;
  }

  /**
   * Routes one raw payload.
   * @returns {Promise<object>} A flat result row (also used for the output CSV).
   */
  async route(rawPayload) {
    const startedAt = Date.now();
    const lead = normalizeLead(rawPayload);
    const base = {
      lead_id: lead.id,
      email: lead.email,
      company: lead.company,
      budget_raw: lead.budgetRaw,
      budget_usd: '',
      budget_method: '',
      tier: '',
      destination: '',
      status: '',
      external_id: '',
      attempts: 0,
      error: '',
      duration_ms: 0,
      processed_at: '',
    };
    const finish = (fields) => ({
      ...base,
      ...fields,
      duration_ms: Date.now() - startedAt,
      processed_at: new Date().toISOString(),
    });

    // 1. Validation: bad rows are reported, never sent.
    const { valid, errors } = validateLead(lead);
    if (!valid) return finish({ status: 'skipped', error: errors.join('; ') });

    // 2. Duplicate protection (webhook senders often retry the same event).
    if (this.seen.has(lead.id)) return finish({ status: 'duplicate', error: 'already processed in this session' });
    this.#remember(lead.id);

    // 3. Budget -> tier.
    const budget = await this.resolveBudget(lead);
    const tier = budget.amountUsd !== null && budget.amountUsd >= this.threshold ? 'high' : 'low';
    Object.assign(base, {
      budget_usd: budget.amountUsd ?? '',
      budget_method: budget.method,
      tier,
    });
    const meta = { amountUsd: budget.amountUsd, tier };

    // 4. Delivery with fallback chain.
    const primary = tier === 'high' ? this.highTarget : this.lowTarget;
    let totalAttempts = 0;
    try {
      const { externalId, attempts } = await this.#deliver(primary, lead, meta);
      return finish({ status: 'routed', destination: primary, external_id: externalId, attempts });
    } catch (err) {
      totalAttempts += err.attempts ?? 1;
      logger.warn(`${lead.id}: ${primary} failed (${err.message})`);

      if (tier === 'high') {
        try {
          const { externalId, attempts } = await this.#deliver(this.lowTarget, lead, { ...meta, fallbackFrom: primary });
          return finish({
            status: 'fallback',
            destination: this.lowTarget,
            external_id: externalId,
            attempts: totalAttempts + attempts,
            error: `${primary}: ${err.message}`,
          });
        } catch (fallbackErr) {
          totalAttempts += fallbackErr.attempts ?? 1;
          err.message = `${primary}: ${err.message} | ${this.lowTarget}: ${fallbackErr.message}`;
        }
      }

      await this.#deadLetter(lead, meta, err.message);
      return finish({ status: 'failed', destination: 'dead_letter', attempts: totalAttempts, error: err.message });
    }
  }

  /**
   * Rules first (free, instant). Gemini only when rules can't read the budget.
   * @returns {Promise<import('./lead/types.js').BudgetResult>}
   */
  async resolveBudget(lead) {
    const parsed = parseBudget(lead.budgetRaw, lead.currency);
    if (parsed) return { amountUsd: parsed.amountUsd, method: 'rules', note: parsed.note };

    if (this.extractor?.available && (lead.budgetRaw || lead.message)) {
      const ai = await this.extractor.extract(lead);
      if (ai) return { amountUsd: ai.amountUsd, method: 'ai' };
    }
    // No usable budget: routed as low-budget so a human can qualify it.
    return { amountUsd: null, method: 'none' };
  }

  async #deliver(target, lead, meta) {
    const dest = this.destinations[target];
    if (!dest.isConfigured()) {
      const err = new Error(`${target} is not configured`);
      err.attempts = 0;
      throw err;
    }
    const { result, attempts } = await withRetry(() => dest.limiter.schedule(() => dest.send(lead, meta)), {
      retries: this.maxRetries,
      label: `${target} (${lead.id})`,
    });
    return { externalId: result.externalId, attempts };
  }

  async #deadLetter(lead, meta, reason) {
    try {
      await mkdir(dirname(this.deadLetterFile), { recursive: true });
      await appendFile(this.deadLetterFile, `${JSON.stringify({ at: new Date().toISOString(), reason, meta, lead })}\n`);
    } catch (err) {
      // Last resort: print the lead so it can be recovered from logs.
      logger.error(`Could not write dead-letter file: ${err.message}. Lead: ${JSON.stringify(lead)}`);
    }
  }

  #remember(id) {
    if (this.seen.size >= DEDUPE_CAPACITY) {
      // Drop the oldest entry (Sets keep insertion order).
      this.seen.delete(this.seen.values().next().value);
    }
    this.seen.add(id);
  }
}
