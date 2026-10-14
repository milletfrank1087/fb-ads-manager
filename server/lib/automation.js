import { fb } from './fbClient.js';
import { store } from './store.js';
import { config } from './env.js';
import { log } from './logger.js';
import { safety } from './safety.js';
import { COMMENT_FIELDS, normalizeComments, hide, remove } from './comments.js';
import { analyzerEnabled, analyzePost, analyzeBatch, analyzeComment, COMMENT_CATEGORIES } from './analyzer.js';
import { discover } from './posts.js';

// ---------- settings & policy ----------

const HARMFUL = ['hate', 'harassment', 'threat', 'spam', 'scam_accusation', 'ai_accusation', 'fake_accusation'];

// Defaults reproduce the previous behaviour: delete when the AI recommends "delete" at severity >= 4.
export const DEFAULT_POLICY = Object.fromEntries(COMMENT_CATEGORIES.map((c) => [c, HARMFUL.includes(c)
  ? { action: 'delete', minSeverity: 4, requireAiDelete: true }
  : { action: 'off', minSeverity: 4, requireAiDelete: true }]));

export const DEFAULT_SETTINGS = {
  enabled: true,
  dryRun: false,
  intervalMinutes: 15,
  maxActionsPerRun: 20,
  maxAnalysesPerRun: 500,
  policy: DEFAULT_POLICY,
};

const POLICY_ACTIONS = new Set(['off', 'hide', 'delete']);

export function getSettings() {
  const saved = store.getSetting('automod', {}) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    policy: Object.fromEntries(COMMENT_CATEGORIES.map((c) => [c, { ...DEFAULT_POLICY[c], ...(saved.policy?.[c] || {}) }])),
  };
}

export function saveSettings(input = {}) {
  const cur = getSettings();
  const clampInt = (v, lo, hi, fb) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : fb);
  const policy = {};
  for (const c of COMMENT_CATEGORIES) {
    const p = { ...cur.policy[c], ...(input.policy?.[c] || {}) };
    policy[c] = {
      action: POLICY_ACTIONS.has(p.action) ? p.action : 'off',
      minSeverity: clampInt(p.minSeverity, 0, 10, 4),
      requireAiDelete: p.requireAiDelete !== false,
    };
  }
  const next = {
    enabled: input.enabled !== undefined ? !!input.enabled : cur.enabled,
    dryRun: input.dryRun !== undefined ? !!input.dryRun : cur.dryRun,
    intervalMinutes: clampInt(input.intervalMinutes ?? cur.intervalMinutes, 15, 24 * 60, 60),
    maxActionsPerRun: clampInt(input.maxActionsPerRun ?? cur.maxActionsPerRun, 1, 100, 20),
    maxAnalysesPerRun: clampInt(input.maxAnalysesPerRun ?? cur.maxAnalysesPerRun, 10, 2000, 500),
    policy,
  };
  // Leaving dry-run: forget the "would have acted" marks so the live run acts on them.
  if (cur.dryRun && !next.dryRun) store.db.prepare("UPDATE comments SET automod_status = NULL WHERE automod_status LIKE 'would_%'").run();
  store.setSetting('automod', next);
  log.info('automod.settings.saved', { enabled: next.enabled, dryRun: next.dryRun, intervalMinutes: next.intervalMinutes });
  schedule();
  return next;
}

export function decide(c, policy) {
  const p = policy[c.category];
  if (!p || p.action === 'off') return { action: null, reason: `policy: ${c.category} is off` };
  if (c.severity < p.minSeverity) return { action: null, reason: `severity ${c.severity} < ${p.minSeverity}` };
  if (p.requireAiDelete && c.recommended_action !== 'delete') return { action: null, reason: `AI recommended ${c.recommended_action}` };
  if (p.action === 'hide' && c.is_hidden) return { action: null, reason: 'already hidden' };
  return { action: p.action, reason: `${c.category} sev ${c.severity}${p.requireAiDelete ? ', AI: delete' : ''}` };
}

// ---------- fetch ----------

const commentsUrl = (postId) => `${postId}/comments?fields=${encodeURIComponent(COMMENT_FIELDS)}&filter=stream&order=reverse_chronological&limit=100`;

function relativeFromNext(next) {
  try {
    const u = new URL(next);
    u.searchParams.delete('access_token');
    u.searchParams.delete('appsecret_proof');
    const qs = u.searchParams.toString();
    return u.pathname.replace(/^\/+(v[0-9.]+\/)?/, '') + (qs ? `?${qs}` : '');
  } catch { return null; }
}

// Newest-first paging that stops as soon as a page contains a comment we already have, so an
// hourly run is normally one sub-request per post. A post's first sync reads up to the page cap.
async function fetchComments(posts, stats) {
  const state = posts.map((p) => ({ post: p, known: store.knownCommentIds(p.id), raw: [], next: null, done: false, complete: false, error: null }));
  let ops = state.map((s, i) => ({ name: `p${i}`, relative_url: commentsUrl(s.post.id), s }));
  for (let page = 0; page < config.maxCommentPagesPerPost && ops.length; page += 1) {
    for (let i = 0; i < ops.length; i += config.batchSize) {
      const group = ops.slice(i, i + config.batchSize);
      const res = await fb.batch(group.map(({ name, relative_url }) => ({ name, relative_url })), 'GET:/automod/comments', { tokenKind: 'page' });
      stats.meta_calls += 1;
      if (!res.ok) {
        for (const o of group) { o.s.error = res.message || res.error || 'batch failed'; o.s.done = true; }
        continue;
      }
      for (const o of group) {
        const sub = res.parsed[o.name];
        if (!sub?.ok) { o.s.error = sub?.body?.error?.message || `HTTP ${sub?.code}`; o.s.done = true; continue; }
        const data = sub.body?.data || [];
        o.s.raw.push(...data);
        o.s.next = sub.body?.paging?.next || null;
        const hitKnown = data.some((c) => o.s.known.has(c.id));
        if (!o.s.next) o.s.complete = true;
        if (hitKnown || !o.s.next) o.s.done = true;
      }
    }
    ops = state.filter((s) => !s.done && s.next).map((s, i) => ({ name: `n${i}`, relative_url: relativeFromNext(s.next), s })).filter((o) => o.relative_url);
  }

  const fresh = new Set();
  for (const s of state) {
    if (s.error) { store.setPostSynced(s.post.id, s.error); stats.errors.push(`${s.post.id}: ${s.error}`); continue; }
    const rows = normalizeComments(s.raw);
    for (const id of store.upsertComments(s.post.id, rows)) fresh.add(id);
    // Only a complete read proves a missing comment was removed on Facebook.
    if (s.complete) store.reconcileDeleted(s.post.id, rows.map((r) => r.id));
    store.setPostSynced(s.post.id, null);
  }
  return fresh;
}

// ---------- AI review ----------

function threadLookup(all) {
  const byId = new Map(all.map((c) => [c.id, c]));
  const replies = new Map();
  for (const c of all) if (c.parent_id) (replies.get(c.parent_id) || replies.set(c.parent_id, []).get(c.parent_id)).push(c);
  return (c) => {
    const parent = c.parent_id ? byId.get(c.parent_id) : null;
    const rs = replies.get(c.id) || [];
    if (!parent && !rs.length) return null;
    return {
      parent: parent ? { authorName: parent.is_page_author ? 'The Page (advertiser)' : parent.from_name, text: parent.message } : null,
      replies: rs.map((r) => ({ authorName: r.is_page_author ? 'The Page (advertiser)' : r.from_name, text: r.message })),
    };
  };
}

async function postContext(post) {
  if (!post.ai_analyzed_at) {
    try {
      const { analysis } = await analyzePost({ author: post.campaign_names || 'the advertiser', content: post.message || '', imageUrl: post.picture_url });
      store.savePostAnalysis(post.id, analysis);
      post = store.getPost(post.id);
    } catch (err) {
      log.warn('automod.post_context.failed', { postId: post.id, error: String(err.message || err) });
    }
  }
  return { author: post.campaign_names || 'the advertiser', content: post.message || '', summary: post.ai_summary, adType: post.ai_ad_type, imageUrl: post.picture_url };
}

async function pool(jobs, n) {
  const q = jobs.slice();
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await q.shift()(); }));
}

export async function analyzePending(posts, budget) {
  let analyzed = 0;
  let failed = 0;
  for (const post of posts) {
    if (budget - analyzed <= 0) break;
    const targets = store.unanalyzedForPost(post.id).slice(0, budget - analyzed);
    if (!targets.length) continue;
    const ctx = await postContext(post);
    const thread = threadLookup(store.commentsForPost(post.id));
    const leftovers = [];
    const jobs = [];
    for (let i = 0; i < targets.length; i += config.analysisBatchSize) {
      const slice = targets.slice(i, i + config.analysisBatchSize);
      const withImage = i === 0;
      jobs.push(async () => {
        try {
          const payload = slice.map((c, k) => ({ idx: k, text: c.message || '', authorName: c.from_name, thread: thread(c) }));
          const { results, model } = await analyzeBatch(payload, withImage ? ctx : { ...ctx, imageUrl: null });
          slice.forEach((c, k) => {
            const a = results.get(k);
            if (a) { store.saveAnalysis(c.id, a, model); analyzed += 1; } else leftovers.push(c);
          });
        } catch { leftovers.push(...slice); }
      });
    }
    await pool(jobs, config.analysisConcurrency);
    for (const c of leftovers) {
      try {
        const { analysis, model } = await analyzeComment({ text: c.message || '', authorName: c.from_name, thread: thread(c) }, { ...ctx, imageUrl: null });
        store.saveAnalysis(c.id, analysis, model);
        analyzed += 1;
      } catch (err) {
        failed += 1;
        log.warn('automod.analyze.failed', { commentId: c.id, error: String(err.message || err) });
      }
    }
  }
  return { analyzed, failed };
}

// ---------- act ----------

async function applyPolicy(postIds, { runId, settings, includeBacklog = false }, stats) {
  const candidates = store.automodCandidates(postIds, { includeBacklog });
  let acted = 0;
  for (const c of candidates) {
    const d = decide(c, settings.policy);
    if (!d.action) { store.setAutomodStatus(c.id, 'kept'); continue; }
    if (acted >= settings.maxActionsPerRun) { stats.skipped += 1; continue; }
    const opts = { source: 'automod', runId, reason: d.reason, dryRun: settings.dryRun };
    const r = d.action === 'delete' ? await remove(c.id, opts) : await hide(c.id, opts);
    if (r.blocked) { stats.errors.push(`stopped: ${r.message}`); break; }
    acted += 1;
    if (!r.ok) { stats.failed += 1; store.setAutomodStatus(c.id, 'failed'); continue; }
    if (settings.dryRun) { store.setAutomodStatus(c.id, d.action === 'delete' ? 'would_delete' : 'would_hide'); continue; }
    store.setAutomodStatus(c.id, d.action === 'delete' ? 'deleted' : 'hidden');
    if (d.action === 'delete') stats.deleted += 1; else stats.hidden += 1;
  }
}

// ---------- run ----------

let running = null;

export function isRunning() { return !!running; }

export async function runNow(trigger = 'manual', { postIds = null, includeBacklog = false } = {}) {
  if (running) return { ok: false, error: 'run_in_progress', message: 'A run is already in progress.' };
  running = (async () => {
    const settings = getSettings();
    const t0 = Date.now();
    const runId = store.startRun(trigger, settings.dryRun);
    const stats = { meta_calls: 0, deleted: 0, hidden: 0, failed: 0, skipped: 0, errors: [] };
    let posts = store.listTrackedPosts();
    if (!posts.length && !postIds) {
      await discover().catch((err) => log.warn('automod.discover.failed', { error: String(err) }));
      posts = store.listTrackedPosts();
    }
    if (postIds) posts = posts.filter((p) => postIds.includes(p.id));
    try {
      if (safety.isKillSwitchActive()) throw new Error('Kill switch is on.');
      if (!posts.length) {
        return store.finishRun(runId, { status: 'success', elapsed_ms: Date.now() - t0, notes: { message: 'No tracked posts.' } });
      }
      const fresh = await fetchComments(posts, stats);
      let analysis = { analyzed: 0, failed: 0 };
      if (analyzerEnabled()) analysis = await analyzePending(posts.map((p) => store.getPost(p.id)), settings.maxAnalysesPerRun);
      else stats.errors.push('AI review disabled (no OPENROUTER_API_KEY) — nothing was acted on.');
      if (analyzerEnabled() && (safety.canModerate() || settings.dryRun)) {
        await applyPolicy(posts.map((p) => p.id), { runId, settings, includeBacklog }, stats);
      } else if (analyzerEnabled()) {
        stats.errors.push('Writes disabled (FB_ALLOW_COMMENT_MODERATION off) — reviewed only.');
      }
      const status = stats.errors.length ? 'partial' : 'success';
      return store.finishRun(runId, {
        status, elapsed_ms: Date.now() - t0, posts_checked: posts.length, new_comments: fresh.size,
        analyzed: analysis.analyzed, deleted: stats.deleted, hidden: stats.hidden,
        failed: stats.failed + analysis.failed, skipped: stats.skipped, meta_calls: stats.meta_calls,
        error: stats.errors.length ? stats.errors.slice(0, 5).join(' · ') : null,
      });
    } catch (err) {
      log.error('automod.run.failed', { runId, error: String(err.message || err) });
      return store.finishRun(runId, { status: 'error', elapsed_ms: Date.now() - t0, meta_calls: stats.meta_calls, error: String(err.message || err) });
    }
  })();
  try {
    const run = await running;
    log.info('automod.run.done', { id: run.id, trigger, status: run.status, newComments: run.new_comments, deleted: run.deleted, hidden: run.hidden });
    return { ok: true, run };
  } finally {
    running = null;
    schedule();
  }
}

// ---------- scheduler ----------

let timer = null;
let nextRunAt = null;

export function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextRunAt = null;
  const s = getSettings();
  if (!s.enabled || running) return;
  const last = store.lastFinishedRun();
  const due = last ? Date.parse(last.started_at) + s.intervalMinutes * 60_000 : Date.now();
  const delay = Math.max(30_000, due - Date.now());
  nextRunAt = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(() => { runNow('scheduled').catch((err) => log.error('automod.tick.failed', { error: String(err) })); }, delay);
  timer.unref();
}

export function schedulerState() {
  return { enabled: getSettings().enabled, running: !!running, nextRunAt };
}

export function startScheduler() {
  const orphans = store.failOrphanRuns();
  if (orphans) log.warn('automod.orphan_runs', { count: orphans });
  if (!store.listTrackedPosts().length) {
    discover()
      .then(() => { schedule(); })
      .catch((err) => { log.warn('automod.boot_discover.failed', { error: String(err) }); schedule(); });
  } else {
    schedule();
  }
  log.info('automod.scheduler.start', schedulerState());
}
