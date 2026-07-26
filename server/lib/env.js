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

const proxyUser = encodeURIComponent(req('PROXY_USER'));
const proxyPass = encodeURIComponent(req('PROXY_PASS'));
const proxyHost = req('PROXY_HOST');
const proxyPort = req('PROXY_PORT');
const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;

const graphVersion = opt('GRAPH_API_VERSION', 'v25.0');
const graphBase = `https://graph.facebook.com/${graphVersion}`;

export const config = Object.freeze({
  systemToken: req('FB_SYSTEM_USER_ACCESS_TOKEN'),
  appId: opt('FB_APP_ID'),
  appSecret: req('FB_APP_SECRET'),
  businessId: opt('FB_BUSINESS_ID'),

  primaryAccountId: req('FB_PRIMARY_ACCOUNT_ID'),
  primaryAccountTz: opt('FB_PRIMARY_ACCOUNT_TIMEZONE', 'Europe/Kiev'),

  proxyUrl,
  proxyHost,
  proxyPort,

  graphVersion,
  graphBase,

  timeoutMs: intOpt('REQUEST_TIMEOUT_SECONDS', 30) * 1000,
  minGapMs: intOpt('MIN_REQUEST_INTERVAL_MS', 750),

  readonly: boolOpt('FB_READONLY', true),
  allowCommentModeration: boolOpt('FB_ALLOW_COMMENT_MODERATION', false),
  allowAdManagement: boolOpt('FB_ALLOW_AD_MANAGEMENT', false),
  // Separate, default-OFF gate for the AI advisor's Tier-2 write tools (pause/budget/duplicate).
  // The advisor proposes a change; the operator approves it; ONLY then, and ONLY if this is on,
  // does it execute (still subject to allowAdManagement + the budget rate guard). Keeping this
  // independent from the dashboard's manual buttons means the AI can never mutate live campaigns
  // by accident — the operator must explicitly arm it.
  allowAdvisorWrites: boolOpt('FB_ALLOW_ADVISOR_WRITES', false),
  targetPageId: opt('FB_TARGET_PAGE_ID', '113297813778299'),
  killSwitch: boolOpt('FB_KILL_SWITCH', false),
  maxDailyCalls: intOpt('FB_MAX_DAILY_CALLS', 500),
  circuitBreakerThreshold: intOpt('FB_CIRCUIT_BREAKER_THRESHOLD', 2),
  circuitBreakerCooldownMs: intOpt('FB_CIRCUIT_BREAKER_COOLDOWN_SECONDS', 300) * 1000,

  port: intOpt('PORT', 3000),
  logLevel: opt('LOG_LEVEL', 'info'),

  openrouterApiKey: opt('OPENROUTER_API_KEY', ''),
  openrouterModel: opt('OPENROUTER_MODEL', 'google/gemini-3.1-flash-lite'),
  openrouterFallbackModel: opt('OPENROUTER_FALLBACK_MODEL', 'google/gemini-3-flash-preview'),
  // Stronger model for the interactive advisor chat (final synthesis + tool reasoning). Bulk
  // comment classification stays on the cheap model; the chat routes to this one with the others
  // as fallbacks. Default = the (stronger) preview model.
  openrouterSynthesisModel: opt('OPENROUTER_SYNTHESIS_MODEL', 'google/gemini-3-flash-preview'),
  analysisBatchSize: intOpt('ANALYSIS_BATCH_SIZE', 10),
  analysisBatchConcurrency: Math.max(1, Math.min(8, intOpt('ANALYSIS_BATCH_CONCURRENCY', 3))),
  analysisMaxCommentsPerRun: intOpt('ANALYSIS_MAX_COMMENTS_PER_RUN', 500),
  cmMaxPostsPerSync: intOpt('CM_MAX_POSTS_PER_SYNC', 40),
  cmMaxCommentPagesPerPost: intOpt('CM_MAX_COMMENT_PAGES_PER_POST', 5),
  // Posts per Graph batch request when field-expanding meta+comments. Hard cap 50 (Meta limit);
  // kept lower by default because each sub-op can return up to 100 comments.
  cmBatchSize: Math.max(1, Math.min(50, intOpt('CM_BATCH_SIZE', 25))),

  cmAutoEnabled: boolOpt('CM_AUTO_ENABLED', false),
  cmAutoSecret: opt('CM_AUTO_SECRET', ''),
  cmAutoMaxDeletesPerRun: Math.max(1, Math.min(100, intOpt('CM_AUTO_MAX_DELETES_PER_RUN', 20))),
  cmAutoSchedule: opt('CM_AUTO_SCHEDULE', '06:00,18:00'),

  userAgent: 'fb-ads-manager/0.8 (+node-express; +sync; +comments; +batch; +admgmt; +cm-auto)',
});

export function maskToken(s) {
  if (!s) return '<empty>';
  if (s.length <= 12) return '*'.repeat(s.length);
  return `${s.slice(0, 8)}...${s.slice(-4)} (len=${s.length})`;
}
