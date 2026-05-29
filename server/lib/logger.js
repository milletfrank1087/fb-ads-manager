import { config } from './env.js';

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ACTIVE_LEVEL = LEVELS[config.logLevel] || LEVELS.info;

function tsLocal() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  return `${h}:${m}:${s}.${ms}`;
}

function colorFor(level) {
  if (level === 'error') return COLOR.red;
  if (level === 'warn') return COLOR.yellow;
  if (level === 'debug') return COLOR.gray;
  return COLOR.cyan;
}

function fmtValue(v) {
  if (v === null || v === undefined) return COLOR.gray + 'null' + COLOR.reset;
  if (typeof v === 'string') {
    if (v.length > 120) return JSON.stringify(v.slice(0, 117) + '...');
    return v.includes(' ') || v.includes('=') ? JSON.stringify(v) : v;
  }
  if (typeof v === 'number') return COLOR.yellow + String(v) + COLOR.reset;
  if (typeof v === 'boolean') return COLOR.magenta + String(v) + COLOR.reset;
  return JSON.stringify(v);
}

function emit(level, event, data) {
  if (LEVELS[level] < ACTIVE_LEVEL) return;
  const ts = tsLocal();
  const c = colorFor(level);
  const tag = `[${level.toUpperCase()}]`.padEnd(7);
  let line = `${COLOR.gray}${ts}${COLOR.reset} ${c}${tag}${COLOR.reset} ${COLOR.bold}${event}${COLOR.reset}`;
  if (data && typeof data === 'object') {
    const pairs = Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${COLOR.dim}${k}=${COLOR.reset}${fmtValue(v)}`)
      .join('  ');
    if (pairs) line += `  ${pairs}`;
  }
  process.stdout.write(line + '\n');
}

export const log = {
  debug: (event, data) => emit('debug', event, data),
  info: (event, data) => emit('info', event, data),
  warn: (event, data) => emit('warn', event, data),
  error: (event, data) => emit('error', event, data),
};

export function banner(title, lines = []) {
  const width = Math.max(title.length, ...lines.map((l) => l.length)) + 4;
  const bar = '═'.repeat(width);
  process.stdout.write(`\n${COLOR.cyan}╔${bar}╗${COLOR.reset}\n`);
  process.stdout.write(`${COLOR.cyan}║${COLOR.reset} ${COLOR.bold}${title.padEnd(width - 2)}${COLOR.reset} ${COLOR.cyan}║${COLOR.reset}\n`);
  if (lines.length) {
    process.stdout.write(`${COLOR.cyan}╠${bar}╣${COLOR.reset}\n`);
    for (const l of lines) {
      process.stdout.write(`${COLOR.cyan}║${COLOR.reset} ${l.padEnd(width - 2)} ${COLOR.cyan}║${COLOR.reset}\n`);
    }
  }
  process.stdout.write(`${COLOR.cyan}╚${bar}╝${COLOR.reset}\n\n`);
}
