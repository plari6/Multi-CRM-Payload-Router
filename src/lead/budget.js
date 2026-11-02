/**
 * Rule-based budget parser.
 *
 * Handles the common formats quickly and for free:
 *   "25000", "$25,000", "25k", "1.2M", "USD 30000", "€20k", "10k-20k", "between 5000 and 8000"
 * Anything it cannot read confidently (e.g. "mid five figures") returns null,
 * and the caller can then ask Gemini.
 */

// Approximate conversion rates to USD. Good enough for routing decisions;
// override with BUDGET_FX_RATES='{"EUR":1.08}' if you need different values.
const DEFAULT_FX_TO_USD = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.73,
  AUD: 0.66,
  AED: 0.27,
  SAR: 0.27,
  INR: 0.012,
  JPY: 0.0067,
  CHF: 1.13,
};

const SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };

const MULTIPLIERS = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

function loadFxRates() {
  try {
    const custom = process.env.BUDGET_FX_RATES ? JSON.parse(process.env.BUDGET_FX_RATES) : {};
    return { ...DEFAULT_FX_TO_USD, ...custom };
  } catch {
    return DEFAULT_FX_TO_USD;
  }
}
const FX = loadFxRates();

export function toUsd(amount, currency = 'USD') {
  const rate = FX[currency?.toUpperCase()] ?? null;
  return rate === null ? null : Math.round(amount * rate);
}

export function isSupportedCurrency(code) {
  return Boolean(code && FX[code.toUpperCase()]);
}

/** Detect the currency from a symbol or an ISO code inside the text. */
function detectCurrency(text) {
  for (const [symbol, code] of Object.entries(SYMBOLS)) if (text.includes(symbol)) return code;
  const iso = text.toUpperCase().match(/\b(USD|EUR|GBP|CAD|AUD|AED|SAR|INR|JPY|CHF)\b/);
  return iso ? iso[1] : null;
}

// A number, optionally with thousands separators/decimals, optionally followed by a multiplier word.
const AMOUNT_RE = /(\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|mm|m|b|thousand|million|billion)?\b/gi;

/**
 * @param {string} raw              Budget text.
 * @param {string} [fallbackCurrency]  Currency column value, used when the text has none.
 * @returns {{ amountUsd: number, currency: string, note?: string } | null}
 */
export function parseBudget(raw, fallbackCurrency = '') {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const amounts = [];
  for (const match of text.matchAll(AMOUNT_RE)) {
    const base = Number(match[1].replace(/[,\s]/g, ''));
    const mult = match[2] ? MULTIPLIERS[match[2].toLowerCase()] : 1;
    if (Number.isFinite(base)) amounts.push(base * mult);
  }
  if (amounts.length === 0) return null;

  // Ranges like "10k-20k": a trailing multiplier usually applies to both ends ("10-20k").
  if (amounts.length === 2 && amounts[0] < amounts[1] && amounts[1] / amounts[0] >= 100) {
    const mult = amounts[1] >= 1e6 ? 1e6 : 1e3;
    if (amounts[0] * mult <= amounts[1]) amounts[0] *= mult;
  }

  // Too many numbers (e.g. a sentence with dates and phone numbers) is ambiguous: let AI decide.
  if (amounts.length > 2) return null;

  const amount = amounts.length === 2 ? (amounts[0] + amounts[1]) / 2 : amounts[0];
  const currency = detectCurrency(text) || fallbackCurrency || 'USD';
  const amountUsd = toUsd(amount, currency);
  if (amountUsd === null) return null;

  return {
    amountUsd,
    currency,
    note: amounts.length === 2 ? 'range midpoint' : undefined,
  };
}
