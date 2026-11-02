/**
 * Webhook server (Express).
 *
 * Endpoints
 *   POST /webhooks/lead         One lead object, or an array of up to 100.
 *                               Replies 202 at once and routes in the background
 *                               (webhook senders usually time out after ~10s).
 *                               Add ?sync=true to wait for the routing result instead.
 *   GET  /leads/:id             Routing result for a lead (kept in memory).
 *   GET  /health                Liveness + which destinations are configured.
 *   GET  /stats                 Counters since start.
 *
 * Security
 *   When WEBHOOK_SECRET is set, every request must carry
 *     X-Signature: sha256=<hex HMAC-SHA256 of the raw body>
 *   which is checked with a constant-time comparison.
 */
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { normalizeLead } from './lead/normalize.js';
import { logger, colors } from './utils/logger.js';

const MAX_BATCH = 100;
const RESULT_HISTORY = 5000;

export function verifySignature(rawBody, header, secret) {
  if (!header || typeof header !== 'string') return false;
  const received = header.startsWith('sha256=') ? header.slice(7) : header;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(received, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {import('./router.js').LeadRouter} router
 * @param {{ webhookSecret?: string }} [opts]
 */
export function createApp(router, { webhookSecret = config.server.webhookSecret } = {}) {
  const app = express();
  app.disable('x-powered-by');

  const results = new Map(); // leadId -> latest result
  const pending = new Set(); // background jobs, awaited on shutdown
  const stats = { received: 0, routed: 0, fallback: 0, failed: 0, skipped: 0, duplicate: 0, startedAt: new Date().toISOString() };

  const saveResult = (result) => {
    stats[result.status] = (stats[result.status] || 0) + 1;
    results.set(result.lead_id, result);
    if (results.size > RESULT_HISTORY) results.delete(results.keys().next().value);
    const color = { routed: colors.green, fallback: colors.yellow, failed: colors.red }[result.status] || colors.gray;
    logger.info(`${color(result.status.padEnd(9))} ${result.lead_id} tier=${result.tier || '-'} -> ${result.destination || '-'} ${result.error ? `(${result.error})` : ''}`);
  };

  const runInBackground = (payload) => {
    const job = router
      .route(payload)
      .then(saveResult)
      .catch((err) => logger.error(`Unexpected routing error: ${err.stack || err.message}`))
      .finally(() => pending.delete(job));
    pending.add(job);
  };

  // Keep the raw bytes: the HMAC must be computed on exactly what was sent.
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      dryRun: router.dryRun,
      routing: { threshold: router.threshold, high: router.highTarget, low: router.lowTarget },
      configured: Object.fromEntries(Object.entries(router.destinations).map(([k, d]) => [k, d.isConfigured()])),
      ai: Boolean(router.extractor?.available),
      inFlight: pending.size,
    });
  });

  app.get('/stats', (_req, res) => res.json(stats));

  app.get('/leads/:id', (req, res) => {
    const result = results.get(req.params.id);
    if (!result) return res.status(404).json({ error: 'not found (still processing, or unknown id)' });
    return res.json(result);
  });

  app.post('/webhooks/lead', async (req, res) => {
    if (webhookSecret && !verifySignature(req.rawBody ?? Buffer.alloc(0), req.get('x-signature'), webhookSecret)) {
      return res.status(401).json({ error: 'invalid or missing X-Signature' });
    }

    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    if (payloads.length === 0 || payloads.some((p) => !p || typeof p !== 'object' || Array.isArray(p))) {
      return res.status(400).json({ error: 'body must be a JSON object or an array of objects' });
    }
    if (payloads.length > MAX_BATCH) {
      return res.status(413).json({ error: `max ${MAX_BATCH} leads per request` });
    }
    stats.received += payloads.length;

    if (req.query.sync === 'true') {
      const out = [];
      for (const p of payloads) {
        const result = await router.route(p);
        saveResult(result);
        out.push(result);
      }
      return res.status(200).json(Array.isArray(req.body) ? out : out[0]);
    }

    // Async mode: report the lead IDs now so the caller can poll /leads/:id.
    const accepted = payloads.map((p) => {
      runInBackground(p);
      const leadId = normalizeLead(p).id;
      return { lead_id: leadId, status_url: `/leads/${encodeURIComponent(leadId)}` };
    });
    return res.status(202).json(Array.isArray(req.body) ? accepted : accepted[0]);
  });

  // Malformed JSON and other errors -> clean JSON response, no stack traces leaked.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'malformed JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    logger.error(err.stack || err.message);
    return res.status(500).json({ error: 'internal error' });
  });

  app.locals.drain = () => Promise.allSettled([...pending]);
  return app;
}

/** Starts the HTTP server and shuts down cleanly on SIGINT/SIGTERM. */
export function startServer(router, port = config.server.port) {
  const app = createApp(router);
  if (!config.server.webhookSecret) {
    logger.warn('WEBHOOK_SECRET is not set: webhook signatures are NOT verified. Set it before going live.');
  }

  const server = app.listen(port, () => {
    logger.success(`Webhook server listening on http://localhost:${port}`);
    logger.info(`POST leads to http://localhost:${port}/webhooks/lead`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received: no new requests; finishing leads in progress...`);
    server.close();
    await app.locals.drain();
    logger.success('Shutdown complete');
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}
