import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './lib/env.js';
import { log, banner } from './lib/logger.js';
import { fb } from './lib/fbClient.js';
import { safety } from './lib/safety.js';
import { store } from './lib/store.js';
import * as comments from './lib/comments.js';
import { discover, addManual } from './lib/posts.js';
import { analyzerEnabled, suggestReply } from './lib/analyzer.js';
import { getSettings, saveSettings, runNow, isRunning, schedulerState, startScheduler } from './lib/automation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) log.info('http', { method: req.method, path: req.path, status: res.statusCode, elapsedMs: Date.now() - t0 });
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const ah = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  log.error('route.error', { path: req.path, error: String(err.message || err) });
  res.status(500).json({ ok: false, error: 'internal', message: String(err.message || err) });
});

function failStatus(r) {
  if (r.blocked) return 423;
  if (r.error === 'no_psid') return 422;
  return 502;
}

// ---------- state & settings ----------

app.get('/api/state', (_req, res) => {
  res.json({
    ok: true,
    settings: getSettings(),
    scheduler: schedulerState(),
    safety: safety.snapshot(),
    analyzerEnabled: analyzerEnabled(),
    page: fb.meta(),
    counts: store.inboxCounts(),
    trackedPosts: store.listTrackedPosts().length,
    lastRun: store.listRuns(1)[0] || null,
  });
});

app.post('/api/settings', ah(async (req, res) => {
  res.json({ ok: true, settings: saveSettings(req.body || {}), scheduler: schedulerState() });
}));

app.post('/api/kill-switch', (req, res) => {
  safety.setKillSwitch(!!req.body?.on, 'ui');
  res.json({ ok: true, safety: safety.snapshot() });
});

// ---------- posts ----------

app.get('/api/posts', (_req, res) => res.json({ ok: true, posts: store.listPosts() }));

app.post('/api/posts/refresh', ah(async (_req, res) => {
  const r = await discover();
  res.status(r.ok ? 200 : 502).json({ ...r, posts: store.listPosts() });
}));

app.post('/api/posts/track', ah(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  if (!ids) return res.status(400).json({ ok: false, message: 'ids[] is required.' });
  const r = store.setTracked(ids);
  log.info('posts.tracked', { ...r, total: ids.length });
  res.json({ ok: true, ...r, posts: store.listPosts() });
}));

app.post('/api/posts/add', ah(async (req, res) => {
  const r = await addManual(req.body?.input);
  res.status(r.ok ? 200 : 400).json({ ...r, posts: store.listPosts() });
}));

// Applies the policy to comments that existed before the post was tracked (normally skipped).
app.post('/api/posts/:id/review-backlog', ah(async (req, res) => {
  if (!store.getPost(req.params.id)?.tracked) return res.status(400).json({ ok: false, message: 'Track the post first.' });
  const r = await runNow('backlog', { postIds: [req.params.id], includeBacklog: true });
  res.status(r.ok ? 200 : 409).json(r);
}));

// ---------- comments ----------

app.get('/api/comments', (req, res) => {
  const { rows, total } = store.inbox({
    filter: String(req.query.filter || 'all'),
    postId: req.query.post_id ? String(req.query.post_id) : null,
    q: String(req.query.q || '').trim().slice(0, 100),
    limit: parseInt(req.query.limit, 10) || 50,
    offset: parseInt(req.query.offset, 10) || 0,
  });
  res.json({ ok: true, rows, total, counts: store.inboxCounts() });
});

app.post('/api/comments/:id/reply', ah(async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > 8000) return res.status(400).json({ ok: false, message: 'Reply text is required (max 8000 chars).' });
  const r = await comments.reply(req.params.id, message);
  if (!r.ok) return res.status(failStatus(r)).json(r);
  res.json({ ok: true, comment: store.getComment(req.params.id) });
}));

app.post('/api/comments/:id/suggest-reply', ah(async (req, res) => {
  if (!analyzerEnabled()) return res.status(503).json({ ok: false, message: 'Set OPENROUTER_API_KEY to enable AI drafts.' });
  const c = store.getComment(req.params.id);
  if (!c) return res.status(404).json({ ok: false, message: 'Comment not found.' });
  const post = store.getPost(c.post_id);
  const parent = c.parent_id ? store.getComment(c.parent_id) : null;
  const { suggestion } = await suggestReply({
    comment: { text: c.message || '', authorName: c.from_name },
    analysis: c.category ? { category: c.category, severity: c.severity, recommended_action: c.recommended_action, english_translation: c.english_translation, action_reason: c.action_reason } : null,
    postCtx: { author: post?.campaign_names || 'the advertiser', adType: post?.ai_ad_type, summary: post?.ai_summary, content: post?.message },
    thread: parent ? { parent: { authorName: parent.from_name, text: parent.message }, replies: [] } : null,
  });
  res.json({ ok: true, suggestion });
}));

app.post('/api/comments/:id/:action', ah(async (req, res) => {
  const fn = comments.ACTIONS[req.params.action];
  if (!fn) return res.status(404).json({ ok: false, message: 'Unknown action.' });
  const r = await fn(req.params.id);
  if (!r.ok) return res.status(failStatus(r)).json(r);
  res.json({ ok: true, comment: store.getComment(req.params.id) });
}));

// ---------- runs ----------

app.post('/api/run', (_req, res) => {
  if (isRunning()) return res.status(409).json({ ok: false, message: 'A run is already in progress.' });
  runNow('manual').catch((err) => log.error('run.manual.failed', { error: String(err) }));
  res.status(202).json({ ok: true, started: true });
});

app.get('/api/runs', (req, res) => res.json({ ok: true, runs: store.listRuns(parseInt(req.query.limit, 10) || 30), scheduler: schedulerState() }));

app.get('/api/runs/:id', (req, res) => {
  const run = store.getRun(parseInt(req.params.id, 10));
  if (!run) return res.status(404).json({ ok: false });
  res.json({ ok: true, run, actions: store.listActions({ runId: run.id }) });
});

app.get('/api/actions', (req, res) => res.json({ ok: true, actions: store.listActions({ limit: parseInt(req.query.limit, 10) || 100 }) }));

// ---------- blocked users ----------

app.get('/api/blocked', (_req, res) => res.json({ ok: true, blocked: store.listBlocked() }));

app.post('/api/blocked/:psid/unblock', ah(async (req, res) => {
  const r = await comments.unblock(req.params.psid);
  res.status(r.ok ? 200 : failStatus(r)).json({ ...r, blocked: store.listBlocked() });
}));

app.use((err, req, res, _next) => {
  log.error('http.unhandled', { path: req.path, error: String(err.message || err) });
  res.status(500).json({ ok: false, error: 'internal', message: String(err.message || err) });
});

const server = app.listen(config.port, () => {
  const s = getSettings();
  banner('Comment Auto-Moderation', [
    `URL          http://localhost:${config.port}`,
    `Page         ${config.targetPageId}`,
    `Proxy        ${config.proxyUrl ? `${config.proxyHost}:${config.proxyPort}` : 'none (direct connection)'}`,
    `Writes       ${config.allowModeration ? 'allowed' : 'DISABLED (FB_ALLOW_COMMENT_MODERATION)'}`,
    `Automation   ${s.enabled ? `ON every ${s.intervalMinutes} min${s.dryRun ? ' (dry run)' : ''}` : 'off'}`,
    `AI review    ${analyzerEnabled() ? 'on' : 'OFF (no OPENROUTER_API_KEY)'}`,
  ]);
  startScheduler();
});

function shutdown(signal) {
  log.warn('server.shutdown', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('process.unhandledRejection', { reason: String(reason) }));
