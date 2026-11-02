/**
 * Caches an OAuth2 access token and refreshes it shortly before it expires.
 *
 * If several leads need a token at the same moment, only one refresh request
 * is sent; the others wait for it.
 */
const EXPIRY_MARGIN_MS = 60_000;

export class TokenCache {
  /**
   * @param {() => Promise<{ accessToken: string, expiresInSec?: number, extra?: object }>} fetchToken
   * @param {number} [defaultTtlSec]  Used when the provider doesn't say how long the token lasts.
   */
  constructor(fetchToken, defaultTtlSec = 3600) {
    this.fetchToken = fetchToken;
    this.defaultTtlSec = defaultTtlSec;
    this.token = null;
    this.expiresAt = 0;
    this.extra = {};
    this.pending = null;
  }

  async get() {
    if (this.token && Date.now() < this.expiresAt - EXPIRY_MARGIN_MS) return this.token;
    if (!this.pending) {
      this.pending = this.fetchToken()
        .then(({ accessToken, expiresInSec, extra }) => {
          this.token = accessToken;
          this.expiresAt = Date.now() + (expiresInSec ?? this.defaultTtlSec) * 1000;
          this.extra = extra ?? {};
          return accessToken;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  /** Forget the token (e.g. after a 401) so the next call fetches a fresh one. */
  invalidate() {
    this.token = null;
    this.expiresAt = 0;
  }
}
