/**
 * Gemini-powered budget extraction.
 *
 * Used only when the rule-based parser can't read a budget, for example:
 *   "mid five figures", "fifty grand", or a budget buried in the free-text message.
 *
 * Safety nets:
 *  - Rate limited (GEMINI_RPM) so batch runs don't hit 429s.
 *  - Retries 429/5xx with backoff.
 *  - Circuit breaker: after several failures in a row, AI is switched off for the rest
 *    of the process and leads fall back to rule-based routing instead of stalling.
 */
import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config.js';
import { RateLimiter } from '../utils/rateLimiter.js';
import { withRetry, HttpError } from '../utils/retry.js';
import { logger } from '../utils/logger.js';
import { toUsd } from '../lead/budget.js';

const CIRCUIT_BREAK_AFTER = 3;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    budget_found: { type: Type.BOOLEAN, description: 'True only if the text states or clearly implies a budget.' },
    amount: { type: Type.NUMBER, description: 'Budget as a single number in the stated currency. Use the midpoint for ranges.' },
    currency: { type: Type.STRING, description: 'ISO 4217 code, e.g. USD, EUR. Default USD if unstated.' },
    confidence: { type: Type.NUMBER, description: '0 to 1.' },
  },
  required: ['budget_found', 'confidence'],
};

const buildPrompt = (lead) => `You extract the project budget from inbound sales leads.
Return JSON only. If no budget is stated or clearly implied, set budget_found to false.
Do not guess from company size or job title.

Examples:
- "mid five figures" -> amount 50000, USD
- "fifty grand" -> amount 50000, USD
- "around 2 lakh rupees" -> amount 200000, INR
- "not sure yet" -> budget_found false

Budget field: ${JSON.stringify(lead.budgetRaw || '')}
Currency field: ${JSON.stringify(lead.currency || '')}
Message: ${JSON.stringify(lead.message || '')}`;

export class GeminiBudgetExtractor {
  constructor({ apiKey, model, rpm }) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
    this.limiter = new RateLimiter({ requestsPerMinute: rpm, name: 'gemini' });
    this.consecutiveFailures = 0;
    this.disabled = false;
  }

  /** @returns {boolean} whether calls will actually be made. */
  get available() {
    return !this.disabled;
  }

  /**
   * @param {import('../lead/types.js').Lead} lead
   * @returns {Promise<{ amountUsd: number, currency: string, confidence: number } | null>}
   *          null when no budget was found or AI is unavailable.
   */
  async extract(lead) {
    if (this.disabled) return null;
    if (!lead.budgetRaw && !lead.message) return null;

    try {
      const { result } = await withRetry(
        () =>
          this.limiter.schedule(async () => {
            try {
              return await this.client.models.generateContent({
                model: this.model,
                contents: buildPrompt(lead),
                config: {
                  temperature: 0,
                  responseMimeType: 'application/json',
                  responseSchema: RESPONSE_SCHEMA,
                },
              });
            } catch (err) {
              // The SDK's ApiError carries the HTTP status; convert it so withRetry knows what to retry.
              if (typeof err?.status === 'number') throw new HttpError(err.message, { status: err.status });
              throw err;
            }
          }),
        { retries: 2, baseDelayMs: 2000, label: `Gemini (${lead.id})` },
      );

      this.consecutiveFailures = 0;
      return this.#interpret(result.text);
    } catch (err) {
      this.consecutiveFailures += 1;
      logger.warn(`Gemini could not process ${lead.id}: ${err.message}`);
      if (this.consecutiveFailures >= CIRCUIT_BREAK_AFTER) {
        this.disabled = true;
        logger.error(`Gemini failed ${CIRCUIT_BREAK_AFTER} times in a row. AI is off for the rest of this run; using rules only.`);
      }
      return null;
    }
  }

  #interpret(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      logger.warn('Gemini returned invalid JSON; ignoring');
      return null;
    }
    // Low-confidence answers are treated as "no budget" rather than risking a wrong route.
    if (!data.budget_found || !(data.amount > 0) || data.confidence < 0.5) return null;

    const currency = (data.currency || 'USD').toUpperCase();
    const amountUsd = toUsd(data.amount, currency);
    if (amountUsd === null) {
      logger.warn(`Gemini returned unsupported currency "${currency}"`);
      return null;
    }
    return { amountUsd, currency, confidence: data.confidence };
  }
}

/** Builds the extractor if a key is configured, otherwise returns null (rules-only mode). */
export function createBudgetExtractor() {
  const { apiKey, model, rpm, enabled } = config.gemini;
  if (!enabled) return null;
  if (!apiKey) {
    logger.warn('GEMINI_API_KEY not set: budgets will be parsed with rules only.');
    return null;
  }
  return new GeminiBudgetExtractor({ apiKey, model, rpm });
}
