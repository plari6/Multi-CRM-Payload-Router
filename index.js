#!/usr/bin/env node
/**
 * Multi-CRM Payload Router: command-line entry point.
 *
 *   node index.js route  --input leads.csv [--output out.csv] [--dry-run]
 *   node index.js serve  [--port 3000] [--dry-run]
 *   node index.js replay [--file output/dead_letter.jsonl] [--dry-run]
 *   node index.js sign   '<json body>'
 *
 * Run `node index.js help` for every option.
 */
import { parseArgs } from 'node:util';
import { readFile, rename, access } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { config } from './src/config.js';
import { LeadRouter } from './src/router.js';
import { createBudgetExtractor } from './src/ai/geminiBudgetExtractor.js';
import { processCsv } from './src/pipeline/csvProcessor.js';
import { startServer } from './src/server.js';
import { logger, colors } from './src/utils/logger.js';

const HELP = `
${colors.bold('Multi-CRM Payload Router')}
Routes high-budget leads to Salesforce/Zoho and low-budget leads to Google Sheets/Airtable.

${colors.bold('Commands')}
  route    Route every lead in a CSV file and write a results CSV
  serve    Start the Express webhook server
  replay   Re-send leads from the dead-letter file
  sign     Print the X-Signature header for a JSON body (for testing webhooks)
  help     Show this message

${colors.bold('Options')}
  -i, --input <file>        CSV to route (route)                 [required]
  -o, --output <file>       Results CSV (route)                  [default: output/routed_leads.csv]
  -p, --port <n>            Server port (serve)                  [default: PORT or 3000]
  -f, --file <file>         Dead-letter file (replay)            [default: DEAD_LETTER_FILE]
  -c, --concurrency <n>     Leads processed at once (route)      [default: CONCURRENCY or 3]
  -t, --threshold <usd>     High-budget threshold in USD         [default: HIGH_BUDGET_THRESHOLD or 10000]
      --high <target>       salesforce | zoho                    [default: HIGH_BUDGET_DESTINATION]
      --low <target>        sheets | airtable                    [default: LOW_BUDGET_DESTINATION]
      --dry-run             Don't call any CRM; write payloads to output/dry_run_*.jsonl
      --no-ai               Don't use Gemini; parse budgets with rules only

${colors.bold('Examples')}
  node index.js route -i data/sample_leads.csv --dry-run
  node index.js route -i leads.csv -o results.csv --threshold 25000 --high zoho --low airtable
  node index.js serve --port 8080
`;

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      input: { type: 'string', short: 'i' },
      output: { type: 'string', short: 'o', default: 'output/routed_leads.csv' },
      port: { type: 'string', short: 'p' },
      file: { type: 'string', short: 'f' },
      concurrency: { type: 'string', short: 'c' },
      threshold: { type: 'string', short: 't' },
      high: { type: 'string' },
      low: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'no-ai': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return { command: values.help ? 'help' : positionals[0] || 'help', args: positionals.slice(1), opts: values };
}

const positiveInt = (value, name) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number (got "${value}")`);
  return n;
};

/** Builds the router from CLI flags + .env, and refuses to start if settings are incomplete. */
function buildRouter(opts) {
  const dryRun = opts['dry-run'] || config.routing.dryRun;
  const router = new LeadRouter({
    dryRun,
    threshold: positiveInt(opts.threshold, 'threshold'),
    highTarget: opts.high?.toLowerCase(),
    lowTarget: opts.low?.toLowerCase(),
    extractor: opts['no-ai'] ? null : createBudgetExtractor(),
  });

  const problems = router.preflight();
  if (problems.length) {
    problems.forEach((p) => logger.error(p));
    throw new Error('Configuration incomplete. See README.md > Environment variables.');
  }

  logger.info(
    `Routing: budget >= $${router.threshold.toLocaleString('en-US')} -> ${colors.bold(router.highTarget)}, ` +
      `otherwise -> ${colors.bold(router.lowTarget)}` +
      `${dryRun ? colors.yellow(' [DRY RUN]') : ''} | AI: ${router.extractor ? config.gemini.model : 'off'}`,
  );
  return router;
}

function printSummary(stats, output) {
  console.log('');
  console.log(colors.bold('Summary'));
  console.log(`  Processed     ${stats.done}/${stats.total}${stats.interrupted ? colors.yellow(' (interrupted)') : ''}`);
  for (const [status, n] of Object.entries(stats.byStatus)) console.log(`  ${status.padEnd(13)} ${n}`);
  for (const [dest, n] of Object.entries(stats.byDestination)) console.log(`  -> ${dest.padEnd(10)} ${n}`);
  console.log(`  Results CSV   ${output}`);
  if (stats.failed) console.log(colors.yellow(`  Failed leads were saved to ${config.delivery.deadLetterFile}; run "node index.js replay" to retry.`));
}

async function cmdRoute(opts) {
  if (!opts.input) throw new Error('--input is required. Example: node index.js route -i data/sample_leads.csv');
  const router = buildRouter(opts);
  const concurrency = positiveInt(opts.concurrency, 'concurrency') ?? config.delivery.concurrency;
  const stats = await processCsv({ input: opts.input, output: opts.output, router, concurrency });
  printSummary(stats, opts.output);
  return stats.failed > 0 ? 2 : 0;
}

async function cmdServe(opts) {
  const router = buildRouter(opts);
  startServer(router, positiveInt(opts.port, 'port') ?? config.server.port);
  return null; // keep running
}

async function cmdReplay(opts) {
  const file = opts.file || config.delivery.deadLetterFile;
  try {
    await access(file);
  } catch {
    logger.success(`No dead-letter file at ${file}. Nothing to replay.`);
    return 0;
  }

  // Check settings before touching the file.
  const router = buildRouter(opts);
  // Move the file aside first, so leads that fail again go into a fresh dead-letter file.
  const archived = file.replace(/\.jsonl$/, '') + `.replayed-${Date.now()}.jsonl`;
  await rename(file, archived);

  const lines = (await readFile(archived, 'utf8')).split('\n').filter(Boolean);
  logger.info(`Replaying ${lines.length} leads from ${archived}`);
  let ok = 0;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      logger.warn('Skipping unreadable line in dead-letter file');
      continue;
    }
    const r = await router.route(entry.lead);
    if (r.status === 'routed' || r.status === 'fallback') ok += 1;
    logger.info(`${r.lead_id}: ${r.status} -> ${r.destination}${r.error ? ` (${r.error})` : ''}`);
  }
  logger.success(`Replay done: ${ok}/${lines.length} delivered`);
  return ok === lines.length ? 0 : 2;
}

function cmdSign(args) {
  const secret = config.server.webhookSecret;
  if (!secret) throw new Error('Set WEBHOOK_SECRET in .env first');
  if (!args[0]) throw new Error(`Usage: node index.js sign '{"email":"a@b.com"}'`);
  console.log(`sha256=${createHmac('sha256', secret).update(args[0]).digest('hex')}`);
  return 0;
}

async function main() {
  const { command, args, opts } = parseCli(process.argv.slice(2));
  switch (command) {
    case 'route':
      return cmdRoute(opts);
    case 'serve':
      return cmdServe(opts);
    case 'replay':
      return cmdReplay(opts);
    case 'sign':
      return cmdSign(args);
    case 'help':
      console.log(HELP);
      return 0;
    default:
      console.log(HELP);
      throw new Error(`Unknown command "${command}"`);
  }
}

main()
  .then((code) => {
    if (code !== null) process.exitCode = code;
  })
  .catch((err) => {
    logger.error(err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  });
