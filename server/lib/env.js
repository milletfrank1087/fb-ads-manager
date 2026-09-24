import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(ROOT, '.env') });

function req(name) {
  const v = (process.env[name] || '').trim();
  if (!v) {
    process.stderr.write(`FATAL: missing required env: ${name}\n`);
    process.exit(1);
  }
  return v;
}

function opt(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function intOpt(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolOpt(name, fallback) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const proxyHost = opt('PROXY_HOST');
const proxyPort = opt('PROXY_PORT');
const proxyUser = opt('PROXY_USER');
const proxyPass = opt('PROXY_PASS');
const proxyUrl = proxyHost && proxyPort
  ? `http://${encodeURIComponent(proxyUser)}:${encodeURIComponent(proxyPass)}@${proxyHost}:${proxyPort}`
  : null;

const graphVersion = opt('GRAPH_API_VERSION', 'v25.0');

export const config = Object.freeze({
  systemToken: req('FB_SYSTEM_USER_ACCESS_TOKEN'),
  appSecret: req('FB_APP_SECRET'),
  targetPageId: req('FB_TARGET_PAGE_ID'),
  timezone: opt('FB_PRIMARY_ACCOUNT_TIMEZONE', 'Europe/Kiev'),

  proxyUrl,
  proxyHost,
  proxyPort,

  graphVersion,
  graphBase: `https://graph.facebook.com/${graphVersion}`,

  timeoutMs: intOpt('REQUEST_TIMEOUT_SECONDS', 30) * 1000,
  minGapMs: intOpt('MIN_REQUEST_INTERVAL_MS', 750),

  // Hard server-level gate for every write to Facebook (hide/delete/reply/block). The UI's
  // automation switch cannot override it.
  allowModeration: boolOpt('FB_ALLOW_COMMENT_MODERATION', false),
  killSwitch: boolOpt('FB_KILL_SWITCH', false),
  maxDailyCalls: intOpt('FB_MAX_DAILY_CALLS', 500),
  circuitBreakerThreshold: intOpt('FB_CIRCUIT_BREAKER_THRESHOLD', 2),
  circuitBreakerCooldownMs: intOpt('FB_CIRCUIT_BREAKER_COOLDOWN_SECONDS', 300) * 1000,

  port: intOpt('PORT', 3000),
  logLevel: opt('LOG_LEVEL', 'info'),
  dbFile: opt('DB_FILE', 'automod.db'),

  openrouterApiKey: opt('OPENROUTER_API_KEY', ''),
  openrouterModel: opt('OPENROUTER_MODEL', 'google/gemini-3.1-flash-lite'),
  openrouterFallbackModel: opt('OPENROUTER_FALLBACK_MODEL', 'google/gemini-3-flash-preview'),
  llmTimeoutMs: intOpt('LLM_TIMEOUT_SECONDS', 60) * 1000,
  analysisBatchSize: Math.max(1, Math.min(20, intOpt('ANALYSIS_BATCH_SIZE', 10))),
  analysisConcurrency: Math.max(1, Math.min(8, intOpt('ANALYSIS_BATCH_CONCURRENCY', 3))),

  // Posts per Graph batch request (Meta hard limit 50).
  batchSize: Math.max(1, Math.min(50, intOpt('CM_BATCH_SIZE', 25))),
  maxCommentPagesPerPost: Math.max(1, intOpt('CM_MAX_COMMENT_PAGES_PER_POST', 5)),

  userAgent: 'fb-comment-automod/1.0',
});

export function maskToken(s) {
  if (!s) return '<empty>';
  if (s.length <= 12) return '*'.repeat(s.length);
  return `${s.slice(0, 8)}...${s.slice(-4)} (len=${s.length})`;
}
