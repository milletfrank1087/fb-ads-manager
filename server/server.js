import path from 'node:path';
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
import { analyzerEnabled, suggestReply, strategyNarrative, dailyBriefing } from './lib/analyzer.js';
import { analyzeStrategy, getLastAnalysis, setNarrative, setBriefing } from './lib/strategist.js';
import {
  syncAll as cmSyncAll,
  syncCommentsOnly as cmSyncCommentsOnly,
  discoverPosts as cmDiscoverPosts,
  syncPostComments as cmSyncPostComments,
  analyzeCommentsForPost as cmAnalyzePost,
  analyzeAllPending as cmAnalyzeAll,
} from './lib/commentSync.js';
import { refreshDashboard, refreshLevel, refreshAllLevels, buildDashboardPayload } from './lib/refresh.js';
import {
  setStatus as adSetStatus,
  setBudget as adSetBudget,
  rename as adRename,
  getBreakdowns as adGetBreakdowns,
  getAdPreview as adGetPreview,
  getActivities as adGetActivities,
  duplicate as adDuplicate,
  adMgmtState,
} from './lib/adManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');

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
