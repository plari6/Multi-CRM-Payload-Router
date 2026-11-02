/**
 * Small console logger with colors, timestamps and an in-place progress bar.
 * No dependency needed: ANSI codes work in modern Windows Terminal, macOS and Linux.
 */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const colors = {
  gray: paint('90'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  cyan: paint('36'),
  bold: paint('1'),
};

const stamp = () => colors.gray(new Date().toISOString().slice(11, 19));

// While a progress bar is on screen, clear it before printing a log line.
let progressActive = false;
const clearProgress = () => {
  if (progressActive && process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
};

const write = (stream, label, args) => {
  clearProgress();
  stream(`${stamp()} ${label}`, ...args);
};

export const logger = {
  info: (...args) => write(console.log, colors.blue('INFO '), args),
  success: (...args) => write(console.log, colors.green('OK   '), args),
  warn: (...args) => write(console.warn, colors.yellow('WARN '), args),
  error: (...args) => write(console.error, colors.red('ERROR'), args),
  debug: (...args) => {
    if (process.env.DEBUG) write(console.log, colors.gray('DEBUG'), args);
  },
};

/**
 * Renders a single-line progress bar: [#######-----] 12/40 30% | ok 10 | failed 2
 * Falls back to plain lines when stdout is not a terminal (e.g. piped to a file).
 */
export function renderProgress({ done, total, ok, failed, skipped }) {
  const width = 28;
  const ratio = total > 0 ? done / total : 0;
  const filled = Math.round(ratio * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  const line =
    `[${colors.cyan(bar)}] ${done}/${total} ${Math.round(ratio * 100)}% | ` +
    `${colors.green(`ok ${ok}`)} | ${colors.red(`failed ${failed}`)} | ${colors.yellow(`skipped ${skipped}`)}`;

  if (process.stdout.isTTY) {
    clearProgress();
    process.stdout.write(line);
    progressActive = true;
  } else {
    console.log(line);
  }
}

export function endProgress() {
  if (progressActive && process.stdout.isTTY) process.stdout.write('\n');
  progressActive = false;
}
