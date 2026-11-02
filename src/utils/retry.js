/**
 * Retry helper with exponential backoff and jitter.
 *
 * Only errors marked as retryable are retried (network failures, HTTP 429 and 5xx).
 * Validation errors and 4xx responses fail fast because retrying cannot fix them.
 */
import { logger } from './logger.js';

/** An HTTP error that remembers the status code and any Retry-After hint. */
export class HttpError extends Error {
  constructor(message, { status, body, retryAfterMs } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRetryable(err) {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  // fetch() throws TypeError on network failure; AbortError on timeout.
  return err?.name === 'TypeError' || err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ retries?: number, baseDelayMs?: number, maxDelayMs?: number, label?: string }} opts
 * @returns {Promise<{ result: T, attempts: number }>}
 * @template T
 */
export async function withRetry(fn, { retries = 3, baseDelayMs = 500, maxDelayMs = 15000, label = 'request' } = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const result = await fn(attempt);
      return { result, attempts: attempt };
    } catch (err) {
      err.attempts = attempt;
      if (attempt > retries || !isRetryable(err)) throw err;

      // Honour Retry-After when the server sends it; otherwise back off exponentially.
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = err.retryAfterMs ?? backoff + Math.floor(Math.random() * 250);
      logger.warn(`${label} failed (attempt ${attempt}/${retries + 1}: ${err.message}). Retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/**
 * fetch() wrapper: adds a timeout, parses JSON, and throws HttpError on non-2xx.
 */
export async function fetchJson(url, { timeoutMs = 15000, ...init } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }

  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new HttpError(`HTTP ${res.status} from ${new URL(url).host}: ${summarize(body)}`, {
      status: res.status,
      body,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    });
  }
  return body;
}

function summarize(body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
}
