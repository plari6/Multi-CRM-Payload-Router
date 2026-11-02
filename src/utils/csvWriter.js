/**
 * Minimal streaming CSV writer (RFC 4180 quoting).
 *
 * Also guards against CSV/formula injection: a cell that starts with = + - @
 * would run as a formula when the file is opened in Excel or Sheets, so it is
 * prefixed with a single quote. Plain negative numbers are left alone.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

export function escapeCell(value) {
  if (value === undefined || value === null) return '';
  let s = String(value);
  if (FORMULA_START.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class CsvWriter {
  constructor(path, columns) {
    this.path = path;
    this.columns = columns;
    this.stream = null;
  }

  async open() {
    await mkdir(dirname(this.path), { recursive: true });
    this.stream = createWriteStream(this.path, { encoding: 'utf8' });
    // Wait until the file is actually open so path/permission errors surface here.
    await once(this.stream, 'open');
    // The BOM makes Excel read the file as UTF-8 (otherwise "€" shows up as "â‚¬").
    await this.#write(`﻿${this.columns.map(escapeCell).join(',')}\n`);
  }

  async writeRow(row) {
    await this.#write(`${this.columns.map((c) => escapeCell(row[c])).join(',')}\n`);
  }

  async close() {
    if (!this.stream) return;
    this.stream.end();
    await once(this.stream, 'finish');
  }

  async #write(chunk) {
    // Respect backpressure on very large outputs.
    if (!this.stream.write(chunk)) await once(this.stream, 'drain');
  }
}
