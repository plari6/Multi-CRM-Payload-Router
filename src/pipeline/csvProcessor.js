/**
 * Batch mode: stream a CSV of leads through the router and write a results CSV.
 *
 * - Streams the input, so large files don't need to fit in memory.
 * - Processes up to `concurrency` leads at a time; the per-destination rate
 *   limiters still cap the request rate to each API.
 * - Malformed rows (wrong column count) are reported in the output, not sent.
 * - Ctrl+C stops reading new rows, finishes the ones in flight, and still writes the output.
 */
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import csv from 'csv-parser';
import { CsvWriter } from '../utils/csvWriter.js';
import { normalizeLead } from '../lead/normalize.js';
import { logger, renderProgress, endProgress, colors } from '../utils/logger.js';

export const OUTPUT_COLUMNS = [
  'row',
  'lead_id',
  'email',
  'company',
  'budget_raw',
  'budget_usd',
  'budget_method',
  'tier',
  'destination',
  'status',
  'external_id',
  'attempts',
  'error',
  'duration_ms',
  'processed_at',
];

const csvOptions = () => ({
  // Strip a UTF-8 BOM (Excel adds one) and surrounding spaces from headers.
  mapHeaders: ({ header }) => header.replace(/^﻿/, '').trim(),
  mapValues: ({ value }) => (typeof value === 'string' ? value.trim() : value),
  skipLines: 0,
  strict: false,
});

/** Counts data rows first so the progress bar can show a real percentage. */
async function countRows(path) {
  let n = 0;
  for await (const _ of createReadStream(path).pipe(csv(csvOptions()))) n += 1;
  return n;
}

/**
 * @param {object} opts
 * @param {string} opts.input
 * @param {string} opts.output
 * @param {import('../router.js').LeadRouter} opts.router
 * @param {number} opts.concurrency
 */
export async function processCsv({ input, output, router, concurrency }) {
  try {
    await access(input);
  } catch {
    throw new Error(`Input file not found: ${input}`);
  }

  const total = await countRows(input);
  if (total === 0) throw new Error(`No data rows found in ${input}`);
  logger.info(`Processing ${colors.bold(total)} leads from ${input} (concurrency ${concurrency})`);

  const writer = new CsvWriter(output, OUTPUT_COLUMNS);
  await writer.open();

  const stats = { done: 0, total, ok: 0, failed: 0, skipped: 0, byDestination: {}, byStatus: {} };
  const inFlight = new Set();
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130); // second Ctrl+C: quit immediately
    stopping = true;
    endProgress();
    logger.warn('Stopping: finishing leads already in progress (press Ctrl+C again to force quit)...');
  };
  process.on('SIGINT', onSigint);

  const record = async (row) => {
    stats.done += 1;
    stats.byStatus[row.status] = (stats.byStatus[row.status] || 0) + 1;
    if (row.status === 'routed' || row.status === 'fallback') {
      stats.ok += 1;
      stats.byDestination[row.destination] = (stats.byDestination[row.destination] || 0) + 1;
    } else if (row.status === 'failed') stats.failed += 1;
    else stats.skipped += 1;

    await writer.writeRow(row);
    renderProgress(stats);
  };

  let expectedColumns = 0;
  const parser = createReadStream(input).pipe(csv(csvOptions()));
  parser.on('headers', (headers) => {
    expectedColumns = headers.length;
  });

  let rowNumber = 1; // header is row 1, so the first lead is row 2 (matches Excel)
  try {
    for await (const raw of parser) {
      if (stopping) break;
      rowNumber += 1;
      const thisRow = rowNumber;

      // csv-parser names extra columns "_<index>"; missing columns are absent.
      const keys = Object.keys(raw);
      const malformed = keys.some((k) => /^_\d+$/.test(k)) || keys.length < expectedColumns;
      if (malformed) {
        const partial = normalizeLead(raw);
        await record({
          row: thisRow,
          lead_id: partial.id,
          email: partial.email,
          company: partial.company,
          status: 'skipped',
          error: `malformed row: expected ${expectedColumns} columns, got ${keys.length}`,
          processed_at: new Date().toISOString(),
        });
        continue;
      }

      const task = router
        .route(raw)
        .catch((err) => ({ status: 'failed', error: `unexpected: ${err.message}` }))
        .then((result) => record({ row: thisRow, ...result }))
        .finally(() => inFlight.delete(task));
      inFlight.add(task);

      // Wait for a free slot before reading the next row (this also pauses the file stream).
      if (inFlight.size >= concurrency) await Promise.race(inFlight);
    }
  } catch (err) {
    endProgress();
    logger.error(`CSV parsing stopped at row ${rowNumber}: ${err.message}`);
  } finally {
    await Promise.allSettled(inFlight);
    await writer.close();
    endProgress();
    process.off('SIGINT', onSigint);
  }

  return { ...stats, interrupted: stopping };
}
