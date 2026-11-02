/**
 * Token-bucket rate limiter.
 *
 * Each call to `acquire()` waits until a token is free. Tokens refill evenly
 * over the minute, so bursts are capped and long runs stay under the API's
 * requests-per-minute limit.
 */
export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.requestsPerMinute  Sustained rate allowed.
   * @param {number} [opts.burst]            Max tokens saved up (defaults to 1 = evenly spaced).
   * @param {string} [opts.name]             Label used in debug output.
   */
  constructor({ requestsPerMinute, burst = 1, name = 'limiter' }) {
    if (!(requestsPerMinute > 0)) throw new Error(`${name}: requestsPerMinute must be > 0`);
    this.name = name;
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.refillMs = 60000 / requestsPerMinute;
    this.lastRefill = Date.now();
    // Calls are chained so waiting callers are served in order.
    this.queue = Promise.resolve();
  }

  #refill() {
    const now = Date.now();
    const earned = (now - this.lastRefill) / this.refillMs;
    if (earned > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + earned);
      this.lastRefill = now;
    }
  }

  acquire() {
    const next = this.queue.then(async () => {
      this.#refill();
      if (this.tokens < 1) {
        const waitMs = Math.ceil((1 - this.tokens) * this.refillMs);
        await new Promise((r) => setTimeout(r, waitMs));
        this.#refill();
      }
      this.tokens -= 1;
    });
    // Keep the chain alive even if a caller's work later throws.
    this.queue = next.catch(() => {});
    return next;
  }

  /** Acquire a token, then run `fn`. */
  async schedule(fn) {
    await this.acquire();
    return fn();
  }
}
