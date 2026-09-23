import { fb } from './fbClient.js';
import { store } from './store.js';
import { config } from './env.js';
import { log } from './logger.js';
import { COMMENT_FIELDS, normalizeCommentList, hide } from './comments.js';
import { autoMod } from './autoMod.js';
import { safety } from './safety.js';
import {
  analyzerEnabled, analyzePost, analyzeBatch, analyzeComment,
} from './analyzer.js';

const POST_META_FIELDS = [
  'message', 'created_time', 'permalink_url', 'is_published', 'full_picture',
  'attachments{media{image{src}},type,title,description,url}',
].join(',');

const FIRST_PAGE_LIMIT = 100;

function pickThumbnail(meta) {
  if (!meta) return null;
  if (meta.full_picture) return meta.full_picture;
  const att = meta.attachments?.data?.[0];
  return att?.media?.image?.src || meta.picture || null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function postExpansionFields(limit = FIRST_PAGE_LIMIT) {
  return `${POST_META_FIELDS},comments.filter(stream).order(chronological).limit(${limit}){${COMMENT_FIELDS}}`;
}

// Convert an absolute Graph paging.next URL into a batch-safe relative_url (drop host,
// version prefix, and the token params — the batch's top-level page token is the fallback).
function toRelativeUrl(abs) {
  try {
    const u = new URL(abs);
    u.searchParams.delete('access_token');
    u.searchParams.delete('appsecret_proof');
    const path = u.pathname.replace(/^\/+(v[0-9.]+\/)?/, '');
    const qs = u.searchParams.toString();
    return qs ? `${path}?${qs}` : path;
  } catch {
    return null;
  }
}

/**
 * Field-expanded + batched sync. For up to cmMaxPostsPerSync ad posts, fetch post meta
 * AND the first page of comments in ONE field-expanded request per post, bundled into
 * batches of cmBatchSize (≤50). Then paginate remaining comment pages, also batched.
 *
 * Rate-limit math: field expansion folds "post meta" + "first comment page" into a single
 * Graph call (1 call vs 2). Batching then collapses N of those into 1 HTTP round-trip and
 * 1 internal daily-cap increment (Meta still counts each sub-op, but we minimise sub-ops
 * via field expansion and minimise top-level calls + throttle gaps via batching).
 */
export async function syncPosts({ withComments = true } = {}) {
  const ads = store.getAdsWithPostId();
  const byPost = new Map();
  for (const a of ads) {
    if (a.post_id && !byPost.has(a.post_id)) byPost.set(a.post_id, a);
  }

  // Also include organic posts from page_posts store
  if (config.targetPageId) {
    const pagePosts = store.listPagePosts({ pageId: config.targetPageId, limit: 30 });
    for (const p of pagePosts) {
      if (p.id && !byPost.has(p.id)) {
        byPost.set(p.id, {
          post_id: p.id,
          campaign_name: 'RiseHope Organic Feed',
          campaign_id: 'organic',
          ad_name: p.pillar || 'Page Feed Post',
          effective_status: 'ACTIVE',
        });
      }
    }
  }

  // Only posts OWNED by our target page are readable with the minted page token.
  // object_story_id is "{pageId}_{postId}", so filter by prefix; promoted posts from other
  // pages would just 400 and waste batch sub-ops (which still count against Meta limits).
  let candidates = [...byPost.values()];
  let skippedOtherPage = 0;
  if (config.targetPageId) {
    const prefix = `${config.targetPageId}_`;
    const owned = candidates.filter((a) => String(a.post_id).startsWith(prefix));
    skippedOtherPage = candidates.length - owned.length;
    if (owned.length) candidates = owned;
  }
  const posts = candidates.slice(0, config.cmMaxPostsPerSync);
  if (!posts.length) {
    log.info('cm.sync.no_posts', { adsWithPost: ads.length, skippedOtherPage });
    return { uniquePosts: byPost.size, ownedPosts: 0, skippedOtherPage, processed: 0, comments: 0, batchCalls: 0 };
  }

  const fields = postExpansionFields();
  const acc = new Map(); // postId -> { ad, meta, comments:[], next, pages, complete }
  for (const a of posts) acc.set(a.post_id, { ad: a, meta: null, comments: [], next: null, pages: 0, complete: false });

  let batchCalls = 0;

  // ---- Pass 1: post meta + first comment page, field-expanded, batched ----
  const failedPosts = [];
  for (const group of chunk(posts, config.cmBatchSize)) {
    const ops = group.map((a, i) => ({
      method: 'GET',
      name: `p${i}`,
      relative_url: withComments
        ? `${a.post_id}?fields=${encodeURIComponent(fields)}`
        : `${a.post_id}?fields=${encodeURIComponent(POST_META_FIELDS)}`,
    }));
    const res = await fb.batch(ops, 'GET:/cm/post+comments', { tokenKind: 'page' });
    batchCalls += 1;
    if (!res.ok) {
      log.error('cm.sync.batch_failed', { error: res.error?.message || res.error || res.message });
      return { uniquePosts: byPost.size, processed: 0, comments: 0, batchCalls, error: 'batch_failed' };
    }
    group.forEach((a, i) => {
      const sub = res.parsed?.[`p${i}`];
      const entry = acc.get(a.post_id);
      if (!sub || !sub.ok || !sub.body) {
        failedPosts.push({ postId: a.post_id, code: sub?.code, error: sub?.body?.error?.message });
        entry.complete = true;
        entry.failed = true;
        return;
      }
      const body = sub.body;
      entry.meta = body;
      const cdata = body.comments?.data || [];
      entry.comments.push(...cdata);
      entry.next = body.comments?.paging?.next || null;
      entry.pages = 1;
      entry.complete = !entry.next;
    });
  }
  if (failedPosts.length) {
    log.warn('cm.sync.posts_failed', { count: failedPosts.length, sample: failedPosts.slice(0, 3) });
  }

  // ---- Pass 2..maxPages: paginate remaining comment pages, batched ----
  let page = 1;
  while (withComments && page < config.cmMaxCommentPagesPerPost) {
    const pending = [...acc.values()].filter((e) => e.next && !e.complete);
    if (!pending.length) break;
    page += 1;
    for (const group of chunk(pending, config.cmBatchSize)) {
      const ops = [];
      const map = [];
      group.forEach((e, i) => {
        const rel = toRelativeUrl(e.next);
        if (!rel) { e.complete = true; return; }
        ops.push({ method: 'GET', name: `c${i}`, relative_url: rel });
        map.push({ name: `c${i}`, entry: e });
      });
      if (!ops.length) continue;
      const res = await fb.batch(ops, 'GET:/cm/comments_page', { tokenKind: 'page' });
      batchCalls += 1;
      if (!res.ok) { log.error('cm.sync.page_batch_failed', {}); break; }
      for (const { name, entry } of map) {
        const sub = res.parsed?.[name];
        if (!sub || !sub.ok || !sub.body) { entry.complete = true; continue; }
        entry.comments.push(...(sub.body.data || []));
        entry.next = sub.body.paging?.next || null;
        entry.pages += 1;
        if (!entry.next) entry.complete = true;
      }
    }
  }

  // ---- Persist ----
  let totalComments = 0;
  let reconciledTotal = 0;
  for (const [postId, e] of acc.entries()) {
    // Skip posts we couldn't read (e.g. owned by another page) — don't create ghost catalog rows.
    if (e.failed && !e.meta) continue;
    if (e.meta) {
      store.upsertAdPost({
        id: postId,
        pageId: config.targetPageId,
        adId: e.ad.ad_id,
        adName: e.ad.ad_name,
        campaignId: e.ad.campaign_id,
        campaignName: e.ad.campaign_name,
        adsetId: e.ad.adset_id,
        adsetName: e.ad.adset_name,
        effectiveStatus: e.ad.effective_status,
        message: e.meta.message ?? null,
        fullPictureUrl: pickThumbnail(e.meta) ?? e.ad.creative_thumb_url ?? null,
        permalinkUrl: e.meta.permalink_url ?? null,
        createdTime: e.meta.created_time ?? e.ad.created_time ?? null,
        isDarkPost: e.meta.is_published === false ? 1 : 0,
      });
    }
    if (withComments) {
      const normalized = normalizeCommentList(e.comments);
      store.upsertCommentsForAd(postId, e.ad.ad_id, normalized);
      // Only reconcile (mark missing-as-deleted) when we fetched the post's FULL stream,
      // otherwise capped pagination would wrongly delete un-fetched comments.
      if (e.complete) {
        reconciledTotal += store.reconcileDeletedComments(postId, normalized.map((c) => c.id));
      }
      store.setPostCommentSyncedAt(postId, new Date().toISOString());
      totalComments += normalized.length;
    }
  }

  const prunedForeign = store.pruneForeignPosts(config.targetPageId);
  log.info('cm.sync.persisted', {
    uniquePosts: byPost.size, ownedPosts: posts.length, skippedOtherPage, prunedForeign,
    failed: failedPosts.length, comments: totalComments, reconciled: reconciledTotal, batchCalls,
  });
  return {
    uniquePosts: byPost.size, ownedPosts: posts.length, skippedOtherPage,
    processed: posts.length, failed: failedPosts.length,
    comments: totalComments, reconciled: reconciledTotal, batchCalls,
  };
}

// Rebuild the catalog only (meta, no comments) — used by the /discover route.
export async function discoverPosts() {
  const r = await syncPosts({ withComments: false });
  return { uniquePosts: r.uniquePosts, processed: r.processed, batchCalls: r.batchCalls };
}

async function applyAutoHideRules(postId) {
  if (!safety.isModerationAllowed()) return { applied: 0, skipped: true };
  const visible = store.db
    .prepare('SELECT id, message, is_hidden, has_url, from_id, from_name FROM comments WHERE post_id = ? AND deleted = 0 AND is_hidden = 0')
    .all(postId);
  const matches = autoMod.evaluate(visible);
  let applied = 0;
  for (const { comment, rule } of matches) {
    try {
      const r = await hide(comment.id);
      if (r.ok) { store.bumpRuleHit(rule.id); applied += 1; }
    } catch (err) {
      log.warn('cm.autohide.failed', { commentId: comment.id, ruleId: rule.id, error: String(err.message || err) });
    }
  }
  if (applied) log.info('cm.autohide.applied', { postId, applied });
  return { applied };
}

// ---------- AI analysis ----------

function buildThreadLookup(allComments) {
  const byId = new Map();
  const repliesBy = new Map();
  for (const c of allComments) byId.set(c.id, c);
  for (const c of allComments) {
    if (c.parent_id) {
      if (!repliesBy.has(c.parent_id)) repliesBy.set(c.parent_id, []);
      repliesBy.get(c.parent_id).push(c);
    }
  }
  return (comment) => {
    const parent = comment.parent_id ? byId.get(comment.parent_id) : null;
    const replies = repliesBy.get(comment.id) || [];
    if (!parent && !replies.length) return null;
    return {
      parent: parent ? { authorName: parent.from_name, text: parent.message } : null,
      replies: replies.map((r) => ({ authorName: r.from_name, text: r.message })),
    };
  };
}

async function ensurePostAnalysis(post, { force = false } = {}) {
  if (post.ai_analyzed_at && post.ai_summary && !force) {
    return { summary: post.ai_summary, ad_type: post.ai_ad_type, category: post.ai_category, severity: post.ai_severity };
  }
  try {
    const { analysis, model } = await analyzePost({
      author: post.campaign_name || 'the advertiser',
      content: post.message || '',
      campaignName: post.campaign_name,
      imageUrl: post.full_picture_url,
    });
    store.savePostAnalysis(post.id, analysis, model);
    log.info('cm.analyze.post.ok', { postId: post.id, adType: analysis.ad_type, model });
    return analysis;
  } catch (err) {
    log.warn('cm.analyze.post.failed', { postId: post.id, error: String(err.message || err) });
    return null;
  }
}

async function runWithConcurrency(jobs, concurrency, onResult) {
  const queue = jobs.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) return;
      try { onResult(null, await job.run(), job); } catch (err) { onResult(err, null, job); }
    }
  });
  await Promise.all(workers);
}

export async function analyzeCommentsForPost(post, { force = false } = {}) {
  if (!analyzerEnabled()) return { analyzed: 0, failed: 0, disabled: true };
  const postCtxAnalysis = await ensurePostAnalysis(post, { force });
  if (force) store.deleteAnalysesForPost(post.id);

  const all = store.listAllCommentsForPost(post.id);
  const targets = force ? all : store.getUnanalyzedComments(post.id, config.analysisMaxCommentsPerRun);
  if (!targets.length) return { analyzed: 0, failed: 0 };

  const getThread = buildThreadLookup(all);
  const ctx = {
    author: post.campaign_name || 'the advertiser',
    content: post.message || '',
    summary: postCtxAnalysis?.summary || null,
    adType: postCtxAnalysis?.ad_type || null,
    imageUrl: post.full_picture_url,
  };

  const batchSize = Math.max(1, Math.min(20, config.analysisBatchSize || 10));
  const concurrency = Math.max(1, config.analysisBatchConcurrency || 3);
  const jobs = [];
  for (let i = 0; i < targets.length; i += batchSize) {
    const slice = targets.slice(i, i + batchSize);
    const payload = slice.map((c, k) => ({ idx: i + k, text: c.message || '', authorName: c.from_name, thread: getThread(c) }));
    const withImage = jobs.length === 0;
    jobs.push({
      slice,
      payload,
      run: () => analyzeBatch(payload, withImage ? ctx : { ...ctx, imageUrl: null }),
    });
  }

  let analyzed = 0;
  let failed = 0;
  const fallback = [];
  await runWithConcurrency(jobs, concurrency, (err, res, job) => {
    if (err) { for (const row of job.slice) fallback.push(row); return; }
    for (let k = 0; k < job.slice.length; k += 1) {
      const idx = job.payload[k].idx;
      const analysis = res.results.get(idx);
      if (analysis) { store.upsertAnalysis(job.slice[k].id, analysis, res.model); analyzed += 1; }
      else fallback.push(job.slice[k]);
    }
  });

  for (const row of fallback) {
    try {
      const { analysis, model } = await analyzeComment(
        { text: row.message || '', authorName: row.from_name, thread: getThread(row) },
        ctx,
      );
      store.upsertAnalysis(row.id, analysis, model);
      analyzed += 1;
    } catch (err) {
      log.warn('cm.analyze.fallback.failed', { commentId: row.id, error: String(err.message || err) });
      failed += 1;
    }
  }

  log.info('cm.analyze.post_comments.done', { postId: post.id, analyzed, failed, total: targets.length });
  return { analyzed, failed };
}

export async function analyzeAllPending({ force = false } = {}) {
  if (!analyzerEnabled()) return { posts: 0, analyzed: 0, failed: 0, disabled: true };
  const posts = store.db.prepare('SELECT * FROM ad_posts ORDER BY last_comment_synced_at DESC NULLS LAST').all();
  let analyzed = 0;
  let failed = 0;
  for (const p of posts) {
    const r = await analyzeCommentsForPost(p, { force });
    analyzed += r.analyzed;
    failed += r.failed;
  }
  return { posts: posts.length, analyzed, failed };
}

/**
 * Full sync: batched field-expanded post+comment fetch -> auto-hide rules -> AI review.
 */
export async function syncAll({ analyze = true, applyRules = true } = {}) {
  const startedAt = Date.now();
  log.info('cm.sync.start', { analyze, applyRules });

  store.markSyncStarted();
  const synced = await syncPosts({ withComments: true });

  let autoHidden = 0;
  if (applyRules && safety.isModerationAllowed()) {
    for (const p of store.getPostCatalog()) {
      autoHidden += (await applyAutoHideRules(p.id)).applied || 0;
    }
  }

  let analyzed = 0;
  let analysisFailed = 0;
  if (analyze && analyzerEnabled()) {
    const a = await analyzeAllPending({ force: false });
    analyzed = a.analyzed;
    analysisFailed = a.failed;
  }

  const elapsedMs = Date.now() - startedAt;
  const result = {
    postsDiscovered: synced.uniquePosts,
    postsSynced: synced.processed,
    skippedOtherPage: synced.skippedOtherPage || 0,
    postsFailed: synced.failed || 0,
    comments: synced.comments,
    batchCalls: synced.batchCalls,
    reconciled: synced.reconciled || 0,
    autoHidden,
    analyzed,
    analysisFailed,
    analyzerEnabled: analyzerEnabled(),
    elapsedMs,
  };
  log.info('cm.sync.done', result);
  return result;
}

/**
 * Comments-only sync: re-pull comments for posts ALREADY in the catalog (no post
 * discovery / no post-meta refresh), then auto-hide rules + AI review. Lighter and
 * faster than syncAll — use it for "just get me new comments and review them".
 * Reuses the same batched 2-pass fetch + the same persistence/reconcile path.
 */
export async function syncCommentsOnly({ analyze = true, applyRules = true, activeOnly = false } = {}) {
  const watched = store.getWatchedPosts();
  let posts;
  if (watched.length) {
    posts = watched;
  } else {
    const prefix = config.targetPageId ? `${config.targetPageId}_` : null;
    posts = store.getPostCatalog()
      .filter((p) => !prefix || String(p.id).startsWith(prefix));
  }
  if (activeOnly) {
    posts = posts.filter((p) => String(p.effective_status || '').toUpperCase() === 'ACTIVE');
  }
  posts = posts.slice(0, config.cmMaxPostsPerSync);
  return syncPostsComments(posts, { analyze, applyRules });
}

export async function syncPostsComments(posts, { analyze = true, applyRules = true, analyzePosts = null } = {}) {
  const startedAt = Date.now();
  log.info('cm.sync_comments.start', { analyze, applyRules, posts: posts.length });

  if (!posts.length) {
    const elapsedMs = Date.now() - startedAt;
    log.info('cm.sync_comments.no_posts', {});
    return {
      commentsOnly: true, postsSynced: 0, postsFailed: 0, comments: 0, reconciled: 0,
      batchCalls: 0, autoHidden: 0, analyzed: 0, analysisFailed: 0,
      analyzerEnabled: analyzerEnabled(), elapsedMs,
    };
  }

  store.markSyncStarted();

  const commentFields = `comments.filter(stream).order(chronological).limit(${FIRST_PAGE_LIMIT}){${COMMENT_FIELDS}}`;
  const acc = new Map();
  for (const p of posts) acc.set(p.id, { post: p, comments: [], next: null, pages: 0, complete: false, failed: false });

  let apiCalls = 0;

  // Individual GET per post — batch POST with page tokens silently strips
  // the comments field from sub-responses (Meta Graph API regression, Sep 2026).
  for (const p of posts) {
    const entry = acc.get(p.id);
    try {
      const res = await fb.get(`/${p.id}`, { fields: commentFields }, 'GET:/post/comments', { tokenKind: 'page' });
      apiCalls += 1;
      if (!res.ok) { entry.complete = true; entry.failed = true; continue; }
      const cdata = res.body?.comments?.data || [];
      entry.comments.push(...cdata);
      entry.next = res.body?.comments?.paging?.next || null;
      entry.pages = 1;
      entry.complete = !entry.next;
    } catch (err) {
      log.warn('cm.sync_comments.post_failed', { postId: p.id, error: String(err.message || err) });
      entry.complete = true;
      entry.failed = true;
    }
  }

  // Paginate remaining comment pages per post
  let page = 1;
  while (page < config.cmMaxCommentPagesPerPost) {
    const pending = [...acc.values()].filter((e) => e.next && !e.complete);
    if (!pending.length) break;
    page += 1;
    for (const e of pending) {
      const rel = toRelativeUrl(e.next);
      if (!rel) { e.complete = true; continue; }
      try {
        const r = await fb.get(`/${rel}`, null, 'GET:/post/comments', { tokenKind: 'page' });
        apiCalls += 1;
        if (!r.ok) { e.complete = true; continue; }
        e.comments.push(...(r.body?.data || []));
        e.next = r.body?.paging?.next || null;
        e.pages += 1;
        if (!e.next) e.complete = true;
      } catch { e.complete = true; }
    }
  }

  // ---- Persist ----
  let totalComments = 0;
  let reconciledTotal = 0;
  let failed = 0;
  for (const [postId, e] of acc.entries()) {
    if (e.failed) { failed += 1; continue; }
    const normalized = normalizeCommentList(e.comments);
    store.upsertCommentsForAd(postId, e.post.ad_id, normalized);
    if (e.complete) reconciledTotal += store.reconcileDeletedComments(postId, normalized.map((c) => c.id));
    store.setPostCommentSyncedAt(postId, new Date().toISOString());
    totalComments += normalized.length;
  }

  // ---- Auto-hide rules ----
  let autoHidden = 0;
  if (applyRules && safety.isModerationAllowed()) {
    for (const p of posts) autoHidden += (await applyAutoHideRules(p.id)).applied || 0;
  }

  let analyzed = 0;
  let analysisFailed = 0;
  if (analyze && analyzerEnabled()) {
    const targets = analyzePosts || posts;
    for (const p of targets) {
      const a = await analyzeCommentsForPost(p, { force: false });
      analyzed += a.analyzed || 0;
      analysisFailed += a.failed || 0;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const result = {
    commentsOnly: true, postsSynced: posts.length, postsFailed: failed,
    comments: totalComments, reconciled: reconciledTotal, batchCalls: 0, apiCalls,
    autoHidden, analyzed, analysisFailed, analyzerEnabled: analyzerEnabled(), elapsedMs,
  };
  log.info('cm.sync_comments.done', result);
  return result;
}

// Single-post refresh (used by the per-post refresh route) — also field-expanded.
export async function syncPostComments(postId, adId = null) {
  const fields = `comments.filter(stream).order(chronological).limit(${FIRST_PAGE_LIMIT}){${COMMENT_FIELDS}}`;
  const res = await fb.get(`/${postId}`, { fields }, 'GET:/post/comments', { tokenKind: 'page' });
  if (!res.ok) {
    return { ok: false, error: res.error?.message || res.error || res.message || 'comments_fetch_failed', blocked: res.blocked || false };
  }
  const all = res.body?.comments?.data || [];
  let next = res.body?.comments?.paging?.next || null;
  let pages = 1;
  while (next && pages < config.cmMaxCommentPagesPerPost) {
    const rel = toRelativeUrl(next);
    if (!rel) break;
    const r = await fb.get(`/${rel}`, null, 'GET:/post/comments', { tokenKind: 'page' });
    if (!r.ok) break;
    all.push(...(r.body?.data || []));
    next = r.body?.paging?.next || null;
    pages += 1;
  }
  const normalized = normalizeCommentList(all);
  store.upsertCommentsForAd(postId, adId, normalized);
  const reconciled = next ? 0 : store.reconcileDeletedComments(postId, normalized.map((c) => c.id));
  store.setPostCommentSyncedAt(postId, new Date().toISOString());
  log.info('cm.comments.synced', { postId, fetched: normalized.length, reconciled, complete: !next });
  return { ok: true, postId, fetched: normalized.length, reconciled };
}
