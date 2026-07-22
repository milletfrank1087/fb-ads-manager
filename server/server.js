import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './lib/env.js';
import { log, banner } from './lib/logger.js';
import { fb } from './lib/fbClient.js';
import { safety } from './lib/safety.js';
import { store } from './lib/store.js';
import { pageToken } from './lib/pageToken.js';
import * as comments from './lib/comments.js';
import { autoMod } from './lib/autoMod.js';
import { analyzerEnabled, suggestReply, strategyNarrative, dailyBriefing, strategyChat, strategyChatStream } from './lib/analyzer.js';
import { analyzeStrategy, getLastAnalysis, setNarrative, setBriefing } from './lib/strategist.js';
import { STRATEGY_TOOLS, runStrategyTool, executeStrategyWrite, isWriteTool, advisorWritesEnabled, setAdvisorWritesArmed, buildAdvisorMemory } from './lib/strategyTools.js';
import {
  syncAll as cmSyncAll,
  syncCommentsOnly as cmSyncCommentsOnly,
  discoverPosts as cmDiscoverPosts,
  syncPostComments as cmSyncPostComments,
  analyzeCommentsForPost as cmAnalyzePost,
  analyzeAllPending as cmAnalyzeAll,
} from './lib/commentSync.js';
import { runCmAuto, cmAutoSecretOk } from './lib/autoRun.js';
import { refreshDashboard, refreshLevel, refreshAllLevels, buildDashboardPayload } from './lib/refresh.js';
import {
  setStatus as adSetStatus,
  setBudget as adSetBudget,
  rename as adRename,
  getBreakdowns as adGetBreakdowns,
  getAdPreview as adGetPreview,
  getActivities as adGetActivities,
  duplicate as adDuplicate,
  getAccountCapability as adGetCapability,
  adMgmtState,
} from './lib/adManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');
app.set('trust proxy', 1);

// --- Health probe (no auth) so platform health checks always pass ---------
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// --- Auth -----------------------------------------------------------------
// Admin Basic-auth gate intentionally removed at the operator's request. The app is now
// served WITHOUT authentication; if exposed publicly it must be protected at the platform
// layer (Railway access control, a network proxy, etc.). APP_USERNAME/APP_PASSWORD are no
// longer read.
log.warn('auth', {
  enabled: false,
  note: 'Auth gate removed — server is UNAUTHENTICATED. Protect it at the platform layer if public.',
});

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const elapsedMs = Date.now() - t0;
    log.info('http', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      elapsedMs,
      ip: req.ip,
    });
  });
  next();
});

// --- index.html composition from partials ---------------------------------
// index.html is split into self-contained partials (server/public/partials/*.html)
// for separation of concerns. We expand <!--#include file="partials/x.html" -->
// markers at request time (cheap: a few small local file reads), keeping a last-good
// cache so a transient read error never serves a broken page.
const PUBLIC_DIR = path.join(__dirname, 'public');
function buildIndexHtml() {
  const raw = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  return raw.replace(/<!--#include\s+file="([^"]+)"\s*-->/g, (_m, rel) => {
    const safeRel = path.normalize(rel).replace(/^([.][.][\\/])+/, '');
    const full = path.join(PUBLIC_DIR, safeRel);
    if (!full.startsWith(PUBLIC_DIR)) throw new Error(`include escapes public dir: ${rel}`);
    return fs.readFileSync(full, 'utf8');
  });
}
let indexHtmlCache = buildIndexHtml(); // fail fast at boot if partials are missing
function serveIndex(_req, res) {
  try {
    indexHtmlCache = buildIndexHtml();
  } catch (err) {
    log.error('index.compose', { error: err.message, note: 'serving last-good cache' });
  }
  res.type('html').send(indexHtmlCache);
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/safety', (_req, res) => {
  res.json({ ok: true, safety: safety.snapshot(), client: fb.meta(), pageToken: pageToken.snapshot() });
});

app.get('/api/page-token', async (req, res) => {
  const verify = req.query.verify === '1' || req.query.verify === 'true';
  if (!verify) {
    return res.json({ ok: true, pageToken: pageToken.snapshot() });
  }
  const minted = await pageToken.get({ force: true });
  if (!minted.ok) {
    return res.status(502).json({ ok: false, error: 'mint_failed', detail: minted, pageToken: pageToken.snapshot() });
  }
  const check = await fb.get(`/${minted.pageId}`, { fields: 'id,name,fan_count' }, 'GET:/page/verify', { tokenKind: 'page' });
  res.json({
    ok: check.ok,
    minted: { pageId: minted.pageId, pageName: minted.pageName },
    pageRead: check.ok
      ? { id: check.body.id, name: check.body.name, fanCount: check.body.fan_count }
      : { error: check.error?.message || check.error || 'page_read_failed' },
    pageToken: pageToken.snapshot(),
  });
});

app.post('/api/kill-switch', (req, res) => {
  const on = !!req.body?.on;
  const reason = req.body?.reason || (on ? 'manual_engage' : 'manual_release');
  safety.setKillSwitch(on, reason);
  res.json({ ok: true, killSwitch: on });
});

const VALID_LEVELS = new Set(['campaign', 'adset', 'ad']);

app.get('/api/dashboard', (req, res) => {
  const datePreset = (req.query.date_preset || 'today').toString();
  const level = (req.query.level || 'campaign').toString();
  const campaignId = req.query.campaign_id?.toString() || null;
  const adsetId = req.query.adset_id?.toString() || null;
  if (!VALID_LEVELS.has(level)) {
    return res.status(400).json({ ok: false, error: 'invalid_level' });
  }
  try {
    const payload = buildDashboardPayload(datePreset, { level, campaignId, adsetId });
    let breadcrumb = null;
    if (level !== 'campaign' && campaignId) {
      breadcrumb = { campaignName: store.getCampaignName(campaignId) };
      if (level === 'ad' && adsetId) {
        const ase = store.getAdsetName(adsetId);
        if (ase) breadcrumb.adsetName = ase.name;
      }
    }
    res.json({ ok: true, datePreset, level, campaignId, adsetId, breadcrumb, ...payload });
  } catch (err) {
    log.error('dashboard.error', { error: String(err.message || err) });
    res.status(500).json({ ok: false, error: 'dashboard_failed', message: String(err.message || err) });
  }
});

app.post('/api/refresh-all', async (req, res) => {
  const datePreset = (req.body?.date_preset || 'today').toString();
  const onlyHadDelivery = req.body?.only_had_delivery === true;
  log.info('refresh.all.request', { datePreset, onlyHadDelivery });
  const result = await refreshAllLevels({ datePreset, onlyHadDelivery });
  if (!result.ok) {
    return res.status(502).json(result);
  }
  res.json({ ok: true, refreshAll: result });
});

app.post('/api/refresh', async (req, res) => {
  const datePreset = (req.body?.date_preset || 'today').toString();
  const level = (req.body?.level || 'campaign').toString();
  const campaignId = req.body?.campaign_id?.toString() || null;
  const adsetId = req.body?.adset_id?.toString() || null;
  const onlyHadDelivery = req.body?.only_had_delivery !== false;
  if (!VALID_LEVELS.has(level)) {
    return res.status(400).json({ ok: false, error: 'invalid_level' });
  }
  log.info('refresh.request', { datePreset, level, campaignId, adsetId, onlyHadDelivery });
  const result = level === 'campaign'
    ? await refreshDashboard({ datePreset, onlyHadDelivery })
    : await refreshLevel({ level, datePreset, campaignId, adsetId, onlyHadDelivery });
  if (!result.ok) {
    return res.status(result.error === 'kill_switch_on' || result.error === 'daily_cap_reached' ? 423 : 502).json(result);
  }
  const payload = buildDashboardPayload(datePreset, { level, campaignId, adsetId });
  let breadcrumb = null;
  if (level !== 'campaign' && campaignId) {
    breadcrumb = { campaignName: store.getCampaignName(campaignId) };
    if (level === 'ad' && adsetId) {
      const ase = store.getAdsetName(adsetId);
      if (ase) breadcrumb.adsetName = ase.name;
    }
  }
  res.json({ ok: true, refresh: result, level, campaignId, adsetId, breadcrumb, ...payload });
});

// ===================== Ad Management (/api/ads/*) =====================

const ah = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  log.error('route.error', { path: req.path, error: String(err.message || err) });
  res.status(500).json({ ok: false, error: 'internal', message: String(err.message || err) });
});

function adActionStatus(result) {
  if (result.blocked || result.error === 'ad_management_disabled') return 423;
  if (result.error === 'kill_switch_on' || result.error === 'daily_cap_reached' || result.error === 'readonly_mode') return 423;
  if (result.error === 'endpoint_cooldown') return 429;
  if (['invalid_level', 'invalid_status', 'invalid_budget', 'no_budget', 'missing_id'].includes(result.error)) return 400;
  return 502;
}

app.get('/api/ads/state', (_req, res) => {
  res.json({ ok: true, ...adMgmtState() });
});

app.get('/api/ads/audit', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json({ ok: true, actions: store.getAdActions(limit) });
});

// Read-only diagnostic: does the token actually have write tasks on the account, and is the
// account healthy? Used to disambiguate an edge 403 on writes from a permission/account issue.
app.get('/api/ads/capability', ah(async (_req, res) => {
  const result = await adGetCapability();
  res.status(result.ok ? 200 : 502).json(result);
}));

app.post('/api/ads/:level/:id/status', ah(async (req, res) => {
  const { level, id } = req.params;
  const status = (req.body?.status || '').toString();
  const result = await adSetStatus({ level, id, status });
  if (!result.ok) return res.status(adActionStatus(result)).json(result);
  res.json({ ok: true, result });
}));

app.post('/api/ads/:level/:id/rename', ah(async (req, res) => {
  const { level, id } = req.params;
  const name = (req.body?.name || '').toString();
  const result = await adRename({ level, id, name });
  if (!result.ok) {
    const code = result.error === 'empty_name' || result.error === 'name_too_long' ? 400 : adActionStatus(result);
    return res.status(code).json(result);
  }
  res.json({ ok: true, result });
}));

app.post('/api/ads/:level/:id/budget', ah(async (req, res) => {
  const { level, id } = req.params;
  const result = await adSetBudget({
    level,
    id,
    dailyBudget: req.body?.daily_budget,
    lifetimeBudget: req.body?.lifetime_budget,
  });
  if (!result.ok) {
    const code = result.error === 'budget_rate_limit' ? 429 : (result.error === 'abo_campaign' ? 422 : adActionStatus(result));
    return res.status(code).json(result);
  }
  res.json({ ok: true, result });
}));

// --- READ intelligence (GET, allowed even in read-only) ---
app.get('/api/ads/:level/:id/breakdowns', ah(async (req, res) => {
  const { level, id } = req.params;
  const result = await adGetBreakdowns({
    level, id,
    datePreset: req.query.date_preset?.toString() || 'last_7d',
    breakdown: req.query.breakdown?.toString() || 'age_gender',
  });
  if (!result.ok) return res.status(adActionStatus(result)).json(result);
  res.json(result);
}));

app.get('/api/ads/activities', ah(async (req, res) => {
  const result = await adGetActivities({ id: req.query.entity_id?.toString() || null, limit: parseInt(req.query.limit, 10) || 100 });
  if (!result.ok) return res.status(adActionStatus(result)).json(result);
  res.json(result);
}));

app.get('/api/ads/:level/:id/activities', ah(async (req, res) => {
  const result = await adGetActivities({ id: req.params.id, limit: parseInt(req.query.limit, 10) || 200 });
  if (!result.ok) return res.status(adActionStatus(result)).json(result);
  res.json(result);
}));

app.get('/api/ads/ad/:id/preview', ah(async (req, res) => {
  const result = await adGetPreview({ adId: req.params.id, adFormat: req.query.ad_format?.toString() || 'DESKTOP_FEED_STANDARD' });
  if (!result.ok) return res.status(adActionStatus(result)).json(result);
  res.json(result);
}));

// --- WRITE: duplicate to a PAUSED copy (gated; never edits the source) ---
app.post('/api/ads/:level/:id/duplicate', ah(async (req, res) => {
  const { level, id } = req.params;
  const result = await adDuplicate({ level, id, deepCopy: req.body?.deep_copy !== false });
  if (!result.ok) return res.status(adActionStatus(result)).json(result);
  res.json({ ok: true, result });
}));

// ===================== Strategy advisor (/api/strategy/*) — suggest-only, reads only =====================

const VALID_STRATEGY_WINDOWS = new Set(['last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d']);

app.post('/api/strategy/analyze', ah(async (req, res) => {
  const window = (req.body?.window || 'last_30d').toString();
  if (!VALID_STRATEGY_WINDOWS.has(window)) {
    return res.status(400).json({ ok: false, error: 'invalid_window', message: `window must be one of: ${[...VALID_STRATEGY_WINDOWS].join(', ')}` });
  }
  const result = await analyzeStrategy({ window });
  if (!result.ok) return res.status(502).json(result);
  res.json(result);
}));

app.get('/api/strategy/last', (_req, res) => {
  const last = getLastAnalysis();
  if (!last) return res.json({ ok: false, error: 'no_analysis', message: 'Run an analysis first.' });
  res.json(last);
});

app.post('/api/strategy/narrative', ah(async (req, res) => {
  if (!analyzerEnabled()) {
    return res.status(503).json({ ok: false, error: 'ai_disabled', message: 'AI is disabled (no OPENROUTER_API_KEY).' });
  }
  const last = getLastAnalysis();
  if (!last?.digest) {
    return res.status(409).json({ ok: false, error: 'no_analysis', message: 'Run /api/strategy/analyze first.' });
  }
  try {
    const { narrative, model } = await strategyNarrative(last.digest);
    setNarrative(narrative);
    log.info('strategy.narrative.ok', { model });
    res.json({ ok: true, narrative, model });
  } catch (err) {
    log.warn('strategy.narrative.failed', { error: String(err.message || err) });
    res.status(502).json({ ok: false, error: 'narrative_failed', message: String(err.message || err) });
  }
}));

// Daily briefing — Gemini turns the decision digest into a "today vs normal" standup, with
// confidence-gated actions only. Reads from the last analysis; run /analyze first.
app.post('/api/strategy/briefing', ah(async (req, res) => {
  if (!analyzerEnabled()) {
    return res.status(503).json({ ok: false, error: 'ai_disabled', message: 'AI is disabled (no OPENROUTER_API_KEY).' });
  }
  const last = getLastAnalysis();
  if (!last?.decisions) {
    return res.status(409).json({ ok: false, error: 'no_analysis', message: 'Run /api/strategy/analyze first.' });
  }
  try {
    const { briefing, model } = await dailyBriefing(last.decisions);
    setBriefing(briefing);
    log.info('strategy.briefing.ok', { model });
    res.json({ ok: true, briefing, model });
  } catch (err) {
    log.warn('strategy.briefing.failed', { error: String(err.message || err) });
    res.status(502).json({ ok: false, error: 'briefing_failed', message: String(err.message || err) });
  }
}));

// Conversational advisor — free-form Q&A grounded in the last analysis snapshot (digest + campaigns +
// ad sets) and the community playbook. Multi-turn: client sends {message, history:[{role,content}]}.
// Streams tokens via SSE when {stream:true}; otherwise returns JSON. Every turn is persisted to the
// strategy_chat table for debugging.
app.post('/api/strategy/chat', ah(async (req, res) => {
  const wantStream = req.body?.stream === true;
  const sessionId = (req.body?.sessionId || '').toString().slice(0, 64) || null;
  const sseError = (status, error, message) => {
    if (!wantStream) return res.status(status).json({ ok: false, error, message });
    res.writeHead(status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'error', error, message })}\n\n`);
    return res.end();
  };

  if (!analyzerEnabled()) return sseError(503, 'ai_disabled', 'AI is disabled (no OPENROUTER_API_KEY).');
  const message = (req.body?.message || '').toString().trim();
  if (!message) return sseError(400, 'empty_message', 'message is required.');
  const last = getLastAnalysis();
  if (!last?.decisions && !last?.campaigns) {
    return sseError(409, 'no_analysis', 'Run /api/strategy/analyze first so the advisor has data to reason over.');
  }
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const window = last?.window || null;
  const startedAt = Date.now();
  // Tier A: standing operator brief + episodic memory (recent applied changes + past chat decisions).
  let memory = '';
  try { memory = buildAdvisorMemory(); } catch (e) { log.warn('strategy.memory.failed', { error: String(e.message || e) }); }
  try { store.logStrategyChat({ session_id: sessionId, role: 'user', content: message, window }); } catch (e) { log.warn('strategy.chat.log_failed', { error: String(e.message || e) }); }

  // Read-only tool wiring: a one-line human summary for the UI chip + the (huge) iframe for previews.
  const toolSummary = (name, r) => {
    if (!r || r.ok === false) return r?.message ? `failed: ${String(r.message).slice(0, 120)}` : 'failed';
    if (name === 'get_fresh_insights') {
      if (r.level === 'ad') {
        const n = r.ads?.length || 0;
        const below = (r.ads || []).filter((a) => /BELOW/.test(a.quality || '')).length;
        return `${r.parent}: ${n} ad(s)${below ? `, ${below} below-avg quality` : ''} (${r.window})`;
      }
      if (r.granularity === 'daily') return `${r.entity}: ${r.series?.length || 0}-day series${r.trend?.meanCpa != null ? `, mean CPA $${r.trend.meanCpa}` : ''} (${r.window})`;
      if (r.rows) return `${r.entity}: ${r.rows.length} ${r.breakdown} rows (${r.window})`;
      const t = r.totals; return t ? `${r.entity}: $${t.spend} spend, ${t.cpa != null ? 'CPA $' + t.cpa : 'no conv'} (${r.window})` : `${r.entity}: no spend (${r.window})`;
    }
    if (name === 'get_change_history') return `${r.scope}: ${r.count} recent change(s)`;
    if (name === 'get_ad_preview') return `${r.adName} (${r.status}) — ${r.format}`;
    if (name === 'get_audiences') {
      if (r.scope === 'targeting') return r.targeting ? `${r.adset}: ${r.targeting.audience_type}${Array.isArray(r.targeting.countries) ? ` · ${r.targeting.countries.join(',')}` : ''} · ${r.targeting.age}` : `${r.adset}: no targeting`;
      return `${r.count} audience(s) · ${r.lookalikes?.length || 0} lookalike(s)`;
    }
    if (name === 'get_signal') {
      const p = (r.pixels || [])[0];
      return `CAPI ${r.capi_live ? 'live' : 'not detected'}${p && p.server_pct != null ? ` · ${p.server_pct}% server (${p.pixel})` : ''}`;
    }
    if (name === 're_analyze') return `re-analyzed ${r.window}: ${r.counts?.activeCampaigns ?? '?'} active campaigns`;
    if (name === 'get_comments') {
      if (r.scope === 'summary') return `${r.summary?.total ?? 0} comments · ${r.summary?.needs_reply ?? 0} need reply · ${r.summary?.flagged ?? 0} flagged`;
      return `${r.count} ${r.scope} comment(s)`;
    }
    if (name === 'compute') {
      switch (r.op) {
        case 'arithmetic': return `= ${r.value}`;
        case 'cpa_ci': return r.cpa != null ? `CPA $${r.cpa} (95% $${r.ci95?.[0]}–$${r.ci95?.[1]}, ${r.confidence})` : 'no CPA (insufficient data)';
        case 'compare_cpa': return `${r.verdict}${r.confidence ? ` (${r.confidence})` : ''}`;
        case 'pct_change': return `${r.pct_change}%`;
        case 'z_score': return r.z != null ? `z = ${r.z}` : 'z unavailable';
        case 'weekly_rate': return `≈ ${r.weekly_rate}/week`;
        case 'roas': return r.roas != null ? `ROAS ${r.roas}` : 'ROAS n/a';
        case 'decision_confidence': return `${r.tier} (score ${r.score})`;
        case 'summary_stats': return `mean ${r.mean} · median ${r.median} · sd ${r.sd} (n=${r.n})`;
        default: return r.value != null ? `= ${r.value}` : 'computed';
      }
    }
    if (name === 'query_data') return `${r.rowCount} row(s)${r.truncated ? ' (truncated)' : ''}${Array.isArray(r.columns) && r.columns.length ? ` · ${r.columns.slice(0, 6).join(', ')}` : ''}`;
    if (name === 'get_query_schema') return `${Object.keys(r.tables || {}).length} queryable tables`;
    if (name === 'measure_incrementality') {
      if (r.mode === 'design') return 'holdout test plan';
      return `${r.entity}: ~${r.estimated_incremental_daily_conversions}/day incremental${r.estimated_iroas_of_campaign != null ? `, iROAS ${r.estimated_iroas_of_campaign}` : ''} (${r.confidence}, ${r.direction})`;
    }
    if (name === 'record_finding') return `saved finding #${r.id}`;
    return 'done';
  };
  const persistTool = (name, args, r) => {
    try { store.logStrategyChat({ session_id: sessionId, role: 'tool', content: `${name}(${JSON.stringify(args).slice(0, 200)}) -> ${toolSummary(name, r)}`, model: name, window }); } catch {}
  };
  const persistApproval = (a) => {
    try { store.logStrategyChat({ session_id: sessionId, role: 'tool', content: `PROPOSED ${a.tool}: ${a.summary} [awaiting approval]`, model: a.tool, window }); } catch {}
  };

  if (!wantStream) {
    const toolsUsed = [];
    const approvals = [];
    const onTool = ({ phase, name, args, result }) => { if (phase === 'done') { toolsUsed.push({ name, ok: result?.ok !== false }); persistTool(name, args, result); } };
    const onApproval = (a) => { approvals.push(a); persistApproval(a); };
    try {
      const { reply, model } = await strategyChat({ message, history, last, memory, tools: STRATEGY_TOOLS, runTool: runStrategyTool, onTool, onApproval, isApprovalTool: isWriteTool });
      const elapsedMs = Date.now() - startedAt;
      log.info('strategy.chat.ok', { model, qLen: message.length, turns: history.length, tools: toolsUsed.length, approvals: approvals.length, elapsedMs, stream: false });
      try { store.logStrategyChat({ session_id: sessionId, role: 'assistant', content: reply, model, window, elapsed_ms: elapsedMs }); } catch (e) { log.warn('strategy.chat.log_failed', { error: String(e.message || e) }); }
      res.json({ ok: true, reply, model, toolsUsed, approvals, advisorWritesEnabled: advisorWritesEnabled() });
    } catch (err) {
      log.warn('strategy.chat.failed', { error: String(err.message || err) });
      try { store.logStrategyChat({ session_id: sessionId, role: 'assistant', content: '', window, error_message: String(err.message || err) }); } catch {}
      res.status(502).json({ ok: false, error: 'chat_failed', message: String(err.message || err) });
    }
    return;
  }

  // Streaming (SSE)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const onDelta = (chunk) => { res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`); };
  const toolsUsed = [];
  const approvals = [];
  const onTool = ({ phase, name, args, result }) => {
    if (phase === 'start') { res.write(`data: ${JSON.stringify({ type: 'tool', phase: 'start', name, args })}\n\n`); return; }
    toolsUsed.push({ name, ok: result?.ok !== false });
    persistTool(name, args, result);
    const evt = { type: 'tool', phase: 'done', name, args, ok: result?.ok !== false, summary: toolSummary(name, result) };
    if (name === 'get_ad_preview' && result?.ok && result.iframe) evt.preview = { iframe: result.iframe, adName: result.adName };
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  const onApproval = (a) => {
    approvals.push(a);
    persistApproval(a);
    res.write(`data: ${JSON.stringify({ type: 'approval', approval: a, armed: advisorWritesEnabled() })}\n\n`);
  };
  try {
    const { reply, model } = await strategyChatStream({ message, history, last, memory, onDelta, onTool, onApproval, isApprovalTool: isWriteTool, tools: STRATEGY_TOOLS, runTool: runStrategyTool });
    const elapsedMs = Date.now() - startedAt;
    res.write(`data: ${JSON.stringify({ type: 'done', model, approvals: approvals.length })}\n\n`);
    res.end();
    log.info('strategy.chat.ok', { model, qLen: message.length, turns: history.length, tools: toolsUsed.length, approvals: approvals.length, elapsedMs, stream: true });
    try { store.logStrategyChat({ session_id: sessionId, role: 'assistant', content: reply, model, window, elapsed_ms: elapsedMs }); } catch (e) { log.warn('strategy.chat.log_failed', { error: String(e.message || e) }); }
  } catch (err) {
    log.warn('strategy.chat.failed', { error: String(err.message || err), stream: true });
    try { res.write(`data: ${JSON.stringify({ type: 'error', error: 'chat_failed', message: String(err.message || err) })}\n\n`); } catch {}
    res.end();
    try { store.logStrategyChat({ session_id: sessionId, role: 'assistant', content: '', window, error_message: String(err.message || err) }); } catch {}
  }
}));

// Executes a Tier-2 write the operator approved on an approval card. Gated by FB_ALLOW_ADVISOR_WRITES
// (default OFF) + adManager's own allowAdManagement/rate guards. The exact reviewed args are what run.
app.post('/api/strategy/tool/execute', ah(async (req, res) => {
  const name = (req.body?.name || '').toString();
  const args = (req.body && typeof req.body.args === 'object' && req.body.args) || {};
  const sessionId = (req.body?.sessionId || '').toString().slice(0, 64) || null;
  const decision = (req.body?.decision || 'approve').toString();

  if (!isWriteTool(name)) return res.status(400).json({ ok: false, error: 'not_a_write_tool', message: `${name} is not an approvable write.` });

  // Rejections never touch Meta — just record the operator's decision (+ optional note) for the audit/AI.
  if (decision === 'reject') {
    try { store.logStrategyChat({ session_id: sessionId, role: 'tool', content: `REJECTED ${name}(${JSON.stringify(args).slice(0, 200)})${req.body?.note ? ' — ' + String(req.body.note).slice(0, 200) : ''}`, model: name }); } catch {}
    log.info('strategy.write.rejected', { name });
    return res.json({ ok: true, rejected: true });
  }

  if (!advisorWritesEnabled()) {
    try { store.logStrategyChat({ session_id: sessionId, role: 'tool', content: `BLOCKED ${name} — advisor writes disabled`, model: name }); } catch {}
    return res.status(423).json({ ok: false, error: 'advisor_writes_disabled', armed: false, message: 'Live actions are off — flip "Live actions ON" in the advisor brief (or set FB_ALLOW_ADVISOR_WRITES=1) to let approvals execute. (Nothing was sent to Meta.)' });
  }

  try {
    const result = await executeStrategyWrite(name, args);
    const ok = result?.ok === true;
    try { store.logStrategyChat({ session_id: sessionId, role: 'tool', content: `${ok ? 'APPLIED' : 'FAILED'} ${name}(${JSON.stringify(args).slice(0, 200)}) -> ${ok ? 'ok' : (result?.message || result?.error || 'error')}`, model: name }); } catch {}
    log.info('strategy.write.execute.result', { name, ok, blocked: !!result?.blocked });
    const status = ok ? 200 : (result?.blocked || result?.error === 'advisor_writes_disabled' ? 423 : 502);
    return res.status(status).json({ ok, result, armed: true });
  } catch (err) {
    log.warn('strategy.write.execute.failed', { name, error: String(err.message || err) });
    return res.status(502).json({ ok: false, error: 'execute_failed', message: String(err.message || err) });
  }
}));

// Tier A: the standing OPERATOR BRIEF the advisor honors every turn (target CPA/ROAS, risk
// tolerance, sacred campaigns, brand voice). Stored as JSON in app_settings; injected via memory.
const PROFILE_RISK = new Set(['conservative', 'balanced', 'aggressive']);
const PROFILE_GOAL = new Set(['', 'maximize_donations', 'hold_cpa', 'hold_roas', 'awareness', 'maintain']);
app.get('/api/strategy/profile', (_req, res) => {
  let profile = {};
  try { profile = JSON.parse(store.getSetting('advisor_profile') || '{}') || {}; } catch { profile = {}; }
  res.json({ ok: true, profile, armed: advisorWritesEnabled(), envForced: config.allowAdvisorWrites === true, memoryPreview: (() => { try { return buildAdvisorMemory(); } catch { return ''; } })() });
});

// The brief is split into ACCOUNT-level fields (brand voice + risk tolerance + notes — genuinely
// global) and PER-CAMPAIGN goals (each beneficiary campaign has its own target CPA/ROAS, goal and
// "sacred" flag — a single account-wide target was wrong). Campaigns are matched by name substring.
app.post('/api/strategy/profile', ah(async (req, res) => {
  const b = req.body || {};
  const campaigns = (Array.isArray(b.campaigns) ? b.campaigns : [])
    .map((c) => ({
      name: String(c?.name || '').slice(0, 120).trim(),
      goal: PROFILE_GOAL.has(c?.goal) ? (c.goal || '') : '',
      targetCpa: c?.targetCpa != null && c.targetCpa !== '' ? String(c.targetCpa).slice(0, 40) : '',
      targetRoas: c?.targetRoas != null && c.targetRoas !== '' ? String(c.targetRoas).slice(0, 40) : '',
      sacred: c?.sacred === true || c?.sacred === 'true',
      notes: String(c?.notes || '').slice(0, 600),
    }))
    .filter((c) => c.name)
    .slice(0, 40);
  const clean = {
    riskTolerance: PROFILE_RISK.has(b.riskTolerance) ? b.riskTolerance : 'balanced',
    brandVoice: String(b.brandVoice || '').slice(0, 1200),
    notes: String(b.notes || '').slice(0, 2000),
    campaigns,
  };
  try { store.setSetting('advisor_profile', JSON.stringify(clean)); } catch (e) {
    log.warn('strategy.profile.save_failed', { error: String(e.message || e) });
    return res.status(500).json({ ok: false, error: 'save_failed', message: String(e.message || e) });
  }
  log.info('strategy.profile.saved', { campaigns: campaigns.length, sacred: campaigns.filter((c) => c.sacred).length, risk: clean.riskTolerance });
  res.json({ ok: true, profile: clean });
}));

// Runtime arm switch for advisor writes (so the operator can enable real execution from the UI
// without restarting). Per-action approval is STILL required; this only flips approve→execute vs
// approve→dry-run. If the env flag is set, writes are always armed and this cannot disarm them.
app.post('/api/strategy/arm', ah(async (req, res) => {
  const on = req.body?.armed === true || req.body?.armed === 'true' || req.body?.armed === 1;
  setAdvisorWritesArmed(on);
  log.warn('strategy.writes.arm_toggled', { armed: on, envForced: config.allowAdvisorWrites === true });
  res.json({ ok: true, armed: advisorWritesEnabled(), envForced: config.allowAdvisorWrites === true });
}));

// ===================== Comments Manager (/api/cm/*) =====================

function actionStatus(result) {
  if (result.blocked || result.error === 'moderation_disabled') return 423;
  if (result.error === 'kill_switch_on' || result.error === 'daily_cap_reached') return 423;
  if (result.error === 'no_psid') return 422;
  return 502;
}

function respondAfterAction(res, commentId, result) {
  const row = store.getCommentWithAnalysis(commentId);
  res.json({ ok: true, result, row, summary: store.getCmSummary() });
}

function threadLookupFor(postId) {
  const all = store.listAllCommentsForPost(postId);
  const byId = new Map();
  const repliesBy = new Map();
  for (const c of all) byId.set(c.id, c);
  for (const c of all) {
    if (c.parent_id) {
      if (!repliesBy.has(c.parent_id)) repliesBy.set(c.parent_id, []);
      repliesBy.get(c.parent_id).push(c);
    }
  }
  return (row) => {
    const parent = row.parent_id ? byId.get(row.parent_id) : null;
    const replies = repliesBy.get(row.id) || [];
    if (!parent && !replies.length) return null;
    return {
      parent: parent ? { authorName: parent.from_name, text: parent.message } : null,
      replies: replies.map((r) => ({ authorName: r.from_name, text: r.message })),
    };
  };
}

app.get('/api/cm/state', (_req, res) => {
  res.json({
    ok: true,
    moderationEnabled: safety.isModerationAllowed(),
    killSwitch: safety.isKillSwitchActive(),
    readonly: safety.isReadonly(),
    analyzerEnabled: analyzerEnabled(),
    targetPageId: pageToken.targetPageId,
    posts: store.getPostCatalog(),
    summary: store.getCmSummary(),
    rules: store.listRules(),
    blockedCount: store.getBlocked().filter((b) => !b.unblocked_at).length,
    lastSyncedAt: store.getLastCommentSyncAt(),
    reviewSince: store.getReviewSince(),
    newSinceLastSync: store.getNewSinceLastSync(),
    cmAutoEnabled: config.cmAutoEnabled,
  });
});

app.get('/api/cm/posts', (_req, res) => {
  res.json({ ok: true, posts: store.getPostCatalog() });
});

const WINDOW_HOURS = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };
function createdSinceFor(win) {
  const hours = WINDOW_HOURS[win];
  if (!hours) return null;
  return new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 19);
}

app.get('/api/cm/inbox', (req, res) => {
  const win = req.query.window?.toString() || '';
  const newOnly = win === 'sync' || req.query.new_only === '1' || req.query.new_only === 'true';
  const { rows, total, limit, offset } = store.getInboxComments({
    filter: req.query.filter?.toString() || 'all',
    sort: req.query.sort?.toString() || 'severity_desc',
    postId: req.query.post_id?.toString() || null,
    minSev: parseInt(req.query.min_sev, 10) || 0,
    q: (req.query.q?.toString() || '').trim(),
    since: newOnly ? store.getReviewSince() : null,
    createdSince: createdSinceFor(win),
    limit: parseInt(req.query.limit, 10) || 100,
    offset: parseInt(req.query.offset, 10) || 0,
  });
  res.json({ ok: true, rows, total, limit, offset, moderationEnabled: safety.isModerationAllowed(), summary: store.getCmSummary(req.query.post_id?.toString() || null) });
});

app.post('/api/cm/sync', ah(async (req, res) => {
  log.info('cm.sync.request', { analyze: req.body?.analyze !== false });
  const result = await cmSyncAll({ analyze: req.body?.analyze !== false, applyRules: req.body?.apply_rules !== false });
  res.json({ ok: true, ...result, moderationEnabled: safety.isModerationAllowed() });
}));

app.post('/api/cm/sync-comments', ah(async (req, res) => {
  log.info('cm.sync_comments.request', { analyze: req.body?.analyze !== false });
  const result = await cmSyncCommentsOnly({ analyze: req.body?.analyze !== false, applyRules: req.body?.apply_rules !== false });
  res.json({ ok: true, ...result, moderationEnabled: safety.isModerationAllowed() });
}));

app.post('/api/cm/discover', ah(async (_req, res) => {
  const result = await cmDiscoverPosts({ withMeta: true });
  res.json({ ok: true, ...result, posts: store.getPostCatalog() });
}));

app.get('/api/cm/runs', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const runs = store.listCmRuns(limit);
  res.json({ ok: true, runs, cmAutoEnabled: config.cmAutoEnabled });
});

app.get('/api/cm/runs/:id', (req, res) => {
  const run = store.getCmRun(parseInt(req.params.id, 10));
  if (!run) return res.status(404).json({ ok: false, error: 'run_not_found' });
  res.json({ ok: true, run });
});

app.post('/api/cm/auto-run', ah(async (req, res) => {
  if (!config.cmAutoEnabled) {
    return res.status(423).json({ ok: false, error: 'auto_disabled', message: 'Set CM_AUTO_ENABLED=1 to enable automated comment moderation.' });
  }
  if (!cmAutoSecretOk(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Invalid or missing CM_AUTO_SECRET.' });
  }
  log.info('cm.auto.request', { trigger: 'scheduled' });
  const result = await runCmAuto({ trigger: 'scheduled' });
  if (!result.ok && result.error === 'run_in_progress') return res.status(409).json(result);
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
}));

app.post('/api/cm/auto-run/manual', ah(async (req, res) => {
  if (!config.cmAutoEnabled) {
    return res.status(423).json({ ok: false, error: 'auto_disabled', message: 'Set CM_AUTO_ENABLED=1 to enable automated comment moderation.' });
  }
  log.warn('cm.auto.request', { trigger: 'manual' });
  const result = await runCmAuto({ trigger: 'manual' });
  if (!result.ok && result.error === 'run_in_progress') return res.status(409).json(result);
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
}));

app.post('/api/cm/posts/:postId/refresh', ah(async (req, res) => {
  const post = store.getAdPost(req.params.postId);
  const result = await cmSyncPostComments(req.params.postId, post?.ad_id || null);
  if (!result.ok) return res.status(actionStatus(result)).json(result);
  if (req.body?.analyze !== false && analyzerEnabled() && post) await cmAnalyzePost(store.getAdPost(req.params.postId), { force: false });
  res.json({ ok: true, ...result, summary: store.getCmSummary() });
}));

app.post('/api/cm/posts/:postId/analyze', ah(async (req, res) => {
  const post = store.getAdPost(req.params.postId);
  if (!post) return res.status(404).json({ ok: false, error: 'post_not_found' });
  if (!analyzerEnabled()) return res.status(503).json({ ok: false, error: 'analyzer_disabled', message: 'Set OPENROUTER_API_KEY to enable AI review.' });
  const result = await cmAnalyzePost(post, { force: req.body?.force === true });
  res.json({ ok: true, ...result, summary: store.getCmSummary() });
}));

app.post('/api/cm/analyze', ah(async (req, res) => {
  if (!analyzerEnabled()) return res.status(503).json({ ok: false, error: 'analyzer_disabled', message: 'Set OPENROUTER_API_KEY to enable AI review.' });
  const result = await cmAnalyzeAll({ force: req.body?.force === true });
  res.json({ ok: true, ...result, summary: store.getCmSummary() });
}));

const PER_COMMENT_ACTIONS = { hide: comments.hide, unhide: comments.unhide, like: comments.like, unlike: comments.unlike };

for (const [action, fn] of Object.entries(PER_COMMENT_ACTIONS)) {
  app.post(`/api/cm/comments/:id/${action}`, ah(async (req, res) => {
    const result = await fn(req.params.id);
    if (!result.ok) return res.status(actionStatus(result)).json(result);
    respondAfterAction(res, req.params.id, result);
  }));
}

app.post('/api/cm/comments/:id/reply', ah(async (req, res) => {
  const message = (req.body?.message || '').toString().trim();
  if (!message) return res.status(400).json({ ok: false, error: 'message_required' });
  if (message.length > 8000) return res.status(400).json({ ok: false, error: 'message_too_long' });
  const result = await comments.reply(req.params.id, message);
  if (!result.ok) return res.status(actionStatus(result)).json(result);
  respondAfterAction(res, req.params.id, result);
}));

app.delete('/api/cm/comments/:id', ah(async (req, res) => {
  const result = await comments.remove(req.params.id);
  if (!result.ok) return res.status(actionStatus(result)).json(result);
  res.json({ ok: true, result, summary: store.getCmSummary() });
}));

app.post('/api/cm/comments/:id/delete-and-block', ah(async (req, res) => {
  const reason = (req.body?.reason || '').toString().slice(0, 200) || null;
  const result = await comments.deleteAndBlock({ commentId: req.params.id, reason });
  if (!result.ok) return res.status(actionStatus(result)).json(result);
  res.json({ ok: true, result, summary: store.getCmSummary() });
}));

// Block the commenter WITHOUT deleting the comment (needs a PSID — see comments.blockByComment).
app.post('/api/cm/comments/:id/block', ah(async (req, res) => {
  const reason = (req.body?.reason || '').toString().slice(0, 200) || null;
  const result = await comments.blockByComment({ commentId: req.params.id, reason });
  if (!result.ok) return res.status(actionStatus(result)).json(result);
  res.json({ ok: true, result, row: store.getCommentWithAnalysis(req.params.id), blocked: store.getBlocked(), summary: store.getCmSummary() });
}));

app.post('/api/cm/comments/:id/suggest-reply', ah(async (req, res) => {
  if (!analyzerEnabled()) return res.status(503).json({ ok: false, error: 'analyzer_disabled', message: 'Set OPENROUTER_API_KEY to enable AI replies.' });
  const row = store.getCommentWithAnalysis(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'comment_not_found' });
  const post = store.getAdPost(row.post_id);
  const getThread = threadLookupFor(row.post_id);
  try {
    const { suggestion, model } = await suggestReply({
      comment: { text: row.message || '', authorName: row.from_name },
      analysis: row.ai_category ? {
        category: row.ai_category, severity: row.ai_severity,
        recommended_action: row.ai_recommended_action,
        english_translation: row.ai_translation, action_reason: row.ai_action_reason,
      } : null,
      postCtx: { author: post?.campaign_name || 'the advertiser', adType: post?.ai_ad_type, summary: post?.ai_summary, content: post?.message },
      thread: getThread(row),
    });
    res.json({ ok: true, suggestion, model });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'suggest_failed', message: String(err.message || err) });
  }
}));

const BULK_ACTIONS = {
  hide: comments.hide, unhide: comments.unhide, like: comments.like, unlike: comments.unlike,
  delete: comments.remove,
  block: (id) => comments.blockByComment({ commentId: id }),
  'delete-and-block': (id) => comments.deleteAndBlock({ commentId: id }),
};

app.post('/api/cm/bulk', ah(async (req, res) => {
  const action = (req.body?.action || '').toString();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 300).map(String) : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: 'ids_required' });
  if (!BULK_ACTIONS[action]) return res.status(400).json({ ok: false, error: 'invalid_action', message: `action must be one of ${Object.keys(BULK_ACTIONS).join(', ')}` });
  log.warn('cm.bulk.request', { action, count: ids.length });
  const fn = BULK_ACTIONS[action];
  const results = [];
  let succeeded = 0;
  let blocked = false;
  for (const id of ids) {
    try {
      const r = await fn(id);
      if (r.blocked) blocked = true;
      if (r.ok) succeeded += 1;
      results.push({ id, ok: !!r.ok, error: r.ok ? null : (r.error?.message || r.error || r.message || 'failed') });
      if (r.blocked) break;
    } catch (err) {
      results.push({ id, ok: false, error: String(err.message || err) });
    }
  }
  res.json({ ok: true, action, total: ids.length, succeeded, failed: ids.length - succeeded, blocked, results, summary: store.getCmSummary() });
}));

// ----- auto-mod rules -----
app.get('/api/cm/rules', (_req, res) => res.json({ ok: true, rules: store.listRules() }));

app.post('/api/cm/rules', ah(async (req, res) => {
  try {
    const id = autoMod.create({
      name: req.body?.name, pattern: req.body?.pattern, match_type: req.body?.match_type,
      case_sensitive: !!req.body?.case_sensitive, is_enabled: req.body?.is_enabled !== false,
    });
    res.json({ ok: true, id, rules: store.listRules() });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'invalid_rule', message: String(err.message || err) });
  }
}));

app.patch('/api/cm/rules/:id', ah(async (req, res) => {
  try {
    const changes = autoMod.update(Number(req.params.id), req.body || {});
    res.json({ ok: true, changes, rules: store.listRules() });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'invalid_rule', message: String(err.message || err) });
  }
}));

app.delete('/api/cm/rules/:id', ah(async (req, res) => {
  const changes = autoMod.remove(Number(req.params.id));
  res.json({ ok: true, changes, rules: store.listRules() });
}));

app.post('/api/cm/rules/preview', (req, res) => {
  const visible = store.db.prepare('SELECT id, message, is_hidden, has_url, from_id, from_name, post_id FROM comments WHERE deleted = 0 AND is_hidden = 0').all();
  const matches = autoMod.evaluate(visible);
  res.json({
    ok: true,
    matchCount: matches.length,
    sample: matches.slice(0, 25).map((m) => ({ id: m.comment.id, message: (m.comment.message || '').slice(0, 200), rule: m.rule.name })),
  });
});

app.post('/api/cm/rules/apply', ah(async (_req, res) => {
  if (!safety.isModerationAllowed()) return res.status(423).json({ ok: false, error: 'moderation_disabled', message: 'Enable FB_ALLOW_COMMENT_MODERATION to auto-hide.' });
  const visible = store.db.prepare('SELECT id, message, is_hidden, has_url, from_id, from_name FROM comments WHERE deleted = 0 AND is_hidden = 0').all();
  const matches = autoMod.evaluate(visible);
  let applied = 0;
  for (const { comment, rule } of matches) {
    const r = await comments.hide(comment.id);
    if (r.blocked) return res.status(423).json({ ok: false, blocked: true, applied, error: r.error, message: r.message });
    if (r.ok) { store.bumpRuleHit(rule.id); applied += 1; }
  }
  res.json({ ok: true, applied, matched: matches.length, summary: store.getCmSummary() });
}));

// ----- audit + blocked -----
app.get('/api/cm/audit', (req, res) => {
  res.json({ ok: true, log: store.getModLog(parseInt(req.query.limit, 10) || 100) });
});

app.get('/api/cm/blocked', (_req, res) => res.json({ ok: true, blocked: store.getBlocked() }));

app.post('/api/cm/blocked/:psid/unblock', ah(async (req, res) => {
  const result = await comments.unblock(req.params.psid);
  if (!result.ok) return res.status(actionStatus(result)).json(result);
  res.json({ ok: true, result, blocked: store.getBlocked() });
}));

app.post('/api/cm/new-since', (req, res) => {
  const lastVisits = req.body?.lastVisits && typeof req.body.lastVisits === 'object' ? req.body.lastVisits : {};
  res.json({ ok: true, counts: store.getNewSinceCounts(lastVisits) });
});

app.get('/api/usage', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const samples = store.getRecentUsage(limit);
  res.json({ ok: true, samples, safety: safety.snapshot() });
});

app.get('/api/rate-limit-details', (_req, res) => {
  const appSample = store.getLatestNonNullHeader('x_app_usage');
  const bucSample = store.getLatestNonNullHeader('x_business_use_case_usage');
  const adAcctSample = store.getLatestNonNullHeader('x_ad_account_usage');
  const insightsSample = store.getLatestNonNullHeader('x_fb_ads_insights_throttle');
  const latest = bucSample || appSample || insightsSample;

  if (!latest) {
    return res.json({
      ok: true,
      hasData: false,
      message: 'No API calls yet. Click Refresh to capture rate-limit headers.',
      safety: safety.snapshot(),
    });
  }
  const xApp = appSample ? safeJson(appSample.value) : null;
  const xBuc = bucSample ? safeJson(bucSample.value) : null;
  const xAdAcct = adAcctSample ? safeJson(adAcctSample.value) : null;
  const xInsights = insightsSample ? safeJson(insightsSample.value) : null;

  const accounts = [];
  if (xBuc && typeof xBuc === 'object') {
    for (const [acctId, entries] of Object.entries(xBuc)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        accounts.push({
          accountId: acctId,
          type: e.type || 'unknown',
          callCountPct: Number(e.call_count || 0),
          totalCpuTimePct: Number(e.total_cputime || 0),
          totalTimePct: Number(e.total_time || 0),
          estimatedTimeToRegainAccess: Number(e.estimated_time_to_regain_access || 0),
        });
      }
    }
  }

  res.json({
    ok: true,
    hasData: true,
    capturedAt: latest.ts,
    where: latest.where_path,
    httpStatus: latest.http_status,
    sources: {
      app: appSample ? { ts: appSample.ts, where: appSample.where_path } : null,
      buc: bucSample ? { ts: bucSample.ts, where: bucSample.where_path } : null,
      insights: insightsSample ? { ts: insightsSample.ts, where: insightsSample.where_path } : null,
    },
    app: xApp
      ? {
          callCountPct: Number(xApp.call_count || 0),
          totalCpuTimePct: Number(xApp.total_cputime || 0),
          totalTimePct: Number(xApp.total_time || 0),
        }
      : null,
    accounts,
    insightsThrottle: xInsights
      ? {
          appUtilPct: Number(xInsights.app_id_util_pct || 0),
          accountUtilPct: Number(xInsights.acc_id_util_pct || 0),
          tier: xInsights.ads_api_access_tier || null,
        }
      : null,
    adAccountUsage: xAdAcct,
    safety: safety.snapshot(),
    devDashboardUrl: `https://developers.facebook.com/apps/${process.env.FB_APP_ID}/rate-limit-details/ads_management/?business_id=${process.env.FB_BUSINESS_ID}`,
  });
});

function safeJson(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch {
    return null;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    nodeVersion: process.version,
    safety: safety.snapshot(),
  });
});

app.use((err, req, res, _next) => {
  log.error('http.unhandled', { method: req.method, path: req.path, error: String(err.message || err), stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
  res.status(500).json({ ok: false, error: 'internal', message: String(err.message || err) });
});

const server = app.listen(config.port, () => {
  const snap = safety.snapshot();
  banner('FB Ads Manager — GFM Greece Dashboard', [
    `URL          http://localhost:${config.port}`,
    `Account      ${config.primaryAccountId} (tz: ${config.primaryAccountTz})`,
    `Graph API    ${config.graphVersion}  via proxy ${config.proxyHost}:${config.proxyPort}`,
    `Readonly     ${snap.readonly ? 'YES (writes blocked)' : 'NO (writes allowed!)'}`,
    `KillSwitch   ${snap.killSwitch ? 'ENGAGED (no calls will go out)' : 'released'}`,
    `Daily cap    ${snap.dailyCallsUsed} / ${snap.dailyCallCap} calls (day ${snap.dailyCallDay})`,
    `Cooldowns    ${snap.cooldowns.length} active`,
  ]);
});

function shutdown(signal) {
  log.warn('server.shutdown', { signal });
  server.close(() => {
    log.info('server.closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log.error('process.unhandledRejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('process.uncaughtException', { error: String(err.message || err), stack: err.stack });
});
