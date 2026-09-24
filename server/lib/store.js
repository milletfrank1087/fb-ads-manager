import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { ROOT, config } from './env.js';
import { log } from './logger.js';

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, config.dbFile);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  message TEXT,
  permalink_url TEXT,
  picture_url TEXT,
  created_time TEXT,
  ad_names TEXT,
  campaign_names TEXT,
  ad_status TEXT,
  tracked INTEGER NOT NULL DEFAULT 0,
  tracked_at TEXT,
  last_synced_at TEXT,
  last_sync_error TEXT,
  ai_summary TEXT,
  ai_ad_type TEXT,
  ai_analyzed_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id TEXT,
  message TEXT,
  from_id TEXT,
  from_name TEXT,
  created_time TEXT,
  like_count INTEGER DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  can_hide INTEGER NOT NULL DEFAULT 1,
  can_remove INTEGER NOT NULL DEFAULT 1,
  user_likes INTEGER NOT NULL DEFAULT 0,
  permalink_url TEXT,
  attachment_type TEXT,
  attachment_url TEXT,
  is_page_author INTEGER NOT NULL DEFAULT 0,
  my_reply_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_by TEXT,
  handled_by_human INTEGER NOT NULL DEFAULT 0,
  automod_status TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_time);
CREATE INDEX IF NOT EXISTS idx_comments_first_seen ON comments(first_seen_at);

CREATE TABLE IF NOT EXISTS analyses (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  severity INTEGER NOT NULL,
  recommended_action TEXT NOT NULL,
  english_translation TEXT,
  explanation TEXT,
  action_reason TEXT,
  model TEXT,
  analyzed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  elapsed_ms INTEGER,
  posts_checked INTEGER DEFAULT 0,
  new_comments INTEGER DEFAULT 0,
  analyzed INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  meta_calls INTEGER DEFAULT 0,
  error TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source TEXT NOT NULL,
  run_id INTEGER,
  action TEXT NOT NULL,
  comment_id TEXT,
  post_id TEXT,
  from_name TEXT,
  message_preview TEXT,
  category TEXT,
  severity INTEGER,
  reason TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_created ON actions(created_at);

CREATE TABLE IF NOT EXISTS blocked_users (
  psid TEXT PRIMARY KEY,
  name TEXT,
  reason TEXT,
  blocked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unblocked_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_call_counter (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS endpoint_cooldowns (
  endpoint TEXT PRIMARY KEY,
  cooldown_until TEXT NOT NULL,
  reason TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0
);
`);

log.info('store.init', { path: DB_PATH });

const now = () => new Date().toISOString();

// ---------- settings ----------

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------- posts ----------

const upsertPostStmt = db.prepare(`
INSERT INTO posts (id, source, message, permalink_url, picture_url, created_time, ad_names, campaign_names, ad_status)
VALUES (@id, @source, @message, @permalink_url, @picture_url, @created_time, @ad_names, @campaign_names, @ad_status)
ON CONFLICT(id) DO UPDATE SET
  source = CASE WHEN posts.source = 'manual' THEN excluded.source ELSE posts.source END,
  message = COALESCE(excluded.message, posts.message),
  permalink_url = COALESCE(excluded.permalink_url, posts.permalink_url),
  picture_url = COALESCE(excluded.picture_url, posts.picture_url),
  created_time = COALESCE(excluded.created_time, posts.created_time),
  ad_names = COALESCE(excluded.ad_names, posts.ad_names),
  campaign_names = COALESCE(excluded.campaign_names, posts.campaign_names),
  ad_status = COALESCE(excluded.ad_status, posts.ad_status)
`);

function upsertPost(p) {
  upsertPostStmt.run({
    id: p.id,
    source: p.source || 'page',
    message: p.message ?? null,
    permalink_url: p.permalink_url ?? null,
    picture_url: p.picture_url ?? null,
    created_time: p.created_time ?? null,
    ad_names: p.ad_names ?? null,
    campaign_names: p.campaign_names ?? null,
    ad_status: p.ad_status ?? null,
  });
}

const POST_COLUMNS = `
  p.*,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted = 0) AS comment_count,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_by = 'automod') AS automod_deleted,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted = 0 AND c.is_hidden = 1) AS hidden_count
`;

function listPosts() {
  return db.prepare(`SELECT ${POST_COLUMNS} FROM posts p ORDER BY p.tracked DESC, p.created_time DESC`).all();
}

function getPost(id) {
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) || null;
}

function listTrackedPosts() {
  return db.prepare('SELECT * FROM posts WHERE tracked = 1 ORDER BY created_time DESC').all();
}

// Tracking changes are applied as one transaction so "Save" is all-or-nothing.
const setTrackedTx = db.transaction((ids) => {
  const want = new Set(ids);
  const current = db.prepare('SELECT id, tracked FROM posts').all();
  let added = 0;
  let removed = 0;
  for (const p of current) {
    if (want.has(p.id) && !p.tracked) {
      db.prepare('UPDATE posts SET tracked = 1, tracked_at = ? WHERE id = ?').run(now(), p.id);
      added += 1;
    } else if (!want.has(p.id) && p.tracked) {
      db.prepare('UPDATE posts SET tracked = 0 WHERE id = ?').run(p.id);
      removed += 1;
    }
  }
  return { added, removed };
});

function setPostSynced(id, error = null) {
  db.prepare('UPDATE posts SET last_synced_at = ?, last_sync_error = ? WHERE id = ?').run(now(), error, id);
}

function savePostAnalysis(id, a) {
  db.prepare('UPDATE posts SET ai_summary = ?, ai_ad_type = ?, ai_analyzed_at = ? WHERE id = ?')
    .run(a.summary, a.ad_type, now(), id);
}

function deletePost(id) {
  return db.prepare('DELETE FROM posts WHERE id = ? AND tracked = 0').run(id).changes;
}

// ---------- comments ----------

const insertCommentStmt = db.prepare(`
INSERT INTO comments (id, post_id, parent_id, message, from_id, from_name, created_time, like_count,
  is_hidden, can_hide, can_remove, user_likes, permalink_url, attachment_type, attachment_url, is_page_author, my_reply_id)
VALUES (@id, @post_id, @parent_id, @message, @from_id, @from_name, @created_time, @like_count,
  @is_hidden, @can_hide, @can_remove, @user_likes, @permalink_url, @attachment_type, @attachment_url, @is_page_author, @my_reply_id)
ON CONFLICT(id) DO UPDATE SET
  message = excluded.message,
  from_id = COALESCE(excluded.from_id, comments.from_id),
  from_name = COALESCE(excluded.from_name, comments.from_name),
  like_count = excluded.like_count,
  is_hidden = excluded.is_hidden,
  can_hide = excluded.can_hide,
  can_remove = excluded.can_remove,
  user_likes = excluded.user_likes,
  permalink_url = COALESCE(excluded.permalink_url, comments.permalink_url),
  my_reply_id = COALESCE(excluded.my_reply_id, comments.my_reply_id),
  deleted = 0,
  deleted_by = NULL
`);

// Returns the ids that did not exist before this call (i.e. genuinely new comments).
const upsertCommentsTx = db.transaction((postId, rows) => {
  const exists = db.prepare('SELECT 1 FROM comments WHERE id = ?');
  const fresh = [];
  for (const r of rows) {
    if (!exists.get(r.id)) fresh.push(r.id);
    insertCommentStmt.run({ ...r, post_id: postId });
  }
  return fresh;
});

function knownCommentIds(postId) {
  return new Set(db.prepare('SELECT id FROM comments WHERE post_id = ?').all(postId).map((r) => r.id));
}

function reconcileDeleted(postId, presentIds) {
  const present = new Set(presentIds);
  const local = db.prepare('SELECT id FROM comments WHERE post_id = ? AND deleted = 0').all(postId);
  const mark = db.prepare("UPDATE comments SET deleted = 1, deleted_by = COALESCE(deleted_by, 'external') WHERE id = ?");
  let n = 0;
  for (const { id } of local) if (!present.has(id)) { mark.run(id); n += 1; }
  return n;
}

function getComment(id) {
  return db.prepare(`
    SELECT c.*, a.category, a.severity, a.recommended_action, a.english_translation, a.explanation, a.action_reason
    FROM comments c LEFT JOIN analyses a ON a.comment_id = c.id WHERE c.id = ?
  `).get(id) || null;
}

function commentsForPost(postId) {
  return db.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY created_time ASC').all(postId);
}

function setCommentHidden(id, hidden) {
  db.prepare('UPDATE comments SET is_hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
}

function markCommentDeleted(id, by) {
  db.prepare('UPDATE comments SET deleted = 1, deleted_by = ? WHERE id = ?').run(by, id);
}

function setCommentLiked(id, liked) {
  db.prepare('UPDATE comments SET user_likes = ? WHERE id = ?').run(liked ? 1 : 0, id);
}

function setCommentReply(id, replyId) {
  db.prepare('UPDATE comments SET my_reply_id = ? WHERE id = ?').run(replyId, id);
}

// A manual action on a comment takes precedence over automation for good.
function markHandledByHuman(id) {
  db.prepare('UPDATE comments SET handled_by_human = 1 WHERE id = ?').run(id);
}

function setAutomodStatus(id, status) {
  db.prepare('UPDATE comments SET automod_status = ? WHERE id = ?').run(status, id);
}

const INBOX_FILTERS = {
  all: 'c.deleted = 0',
  flagged: "c.deleted = 0 AND c.is_hidden = 0 AND c.is_page_author = 0 AND c.handled_by_human = 0 AND a.recommended_action IN ('delete','review')",
  unanswered: "c.deleted = 0 AND c.is_hidden = 0 AND c.parent_id IS NULL AND c.is_page_author = 0 AND c.my_reply_id IS NULL AND a.category = 'safe'",
  hidden: 'c.deleted = 0 AND c.is_hidden = 1',
  deleted: 'c.deleted = 1',
  unreviewed: 'c.deleted = 0 AND a.comment_id IS NULL AND c.is_page_author = 0',
};

function inbox({ filter = 'all', postId = null, q = '', limit = 50, offset = 0 } = {}) {
  const where = [INBOX_FILTERS[filter] || INBOX_FILTERS.all, 'p.tracked = 1'];
  const params = [];
  if (postId) { where.push('c.post_id = ?'); params.push(postId); }
  if (q) { where.push('(c.message LIKE ? OR a.english_translation LIKE ? OR c.from_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const whereSql = where.join(' AND ');
  const base = `FROM comments c
    JOIN posts p ON p.id = c.post_id
    LEFT JOIN analyses a ON a.comment_id = c.id
    LEFT JOIN comments pc ON pc.id = c.parent_id
    WHERE ${whereSql}`;
  const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...params).n;
  const rows = db.prepare(`
    SELECT c.*, a.category, a.severity, a.recommended_action, a.english_translation, a.explanation, a.action_reason,
           p.message AS post_message, p.campaign_names, p.picture_url AS post_picture,
           pc.message AS parent_message, pc.from_name AS parent_from_name
    ${base}
    ORDER BY c.created_time DESC LIMIT ? OFFSET ?
  `).all(...params, Math.min(200, Math.max(1, limit)), Math.max(0, offset));
  return { rows, total };
}

function inboxCounts() {
  const out = {};
  for (const [k, cond] of Object.entries(INBOX_FILTERS)) {
    out[k] = db.prepare(`SELECT COUNT(*) n FROM comments c JOIN posts p ON p.id = c.post_id LEFT JOIN analyses a ON a.comment_id = c.id WHERE p.tracked = 1 AND ${cond}`).get().n;
  }
  return out;
}

// ---------- analyses ----------

function unanalyzedForPost(postId, ids = null) {
  const rows = db.prepare(`
    SELECT c.* FROM comments c LEFT JOIN analyses a ON a.comment_id = c.id
    WHERE c.post_id = ? AND c.deleted = 0 AND c.is_page_author = 0 AND a.comment_id IS NULL
    ORDER BY c.created_time ASC
  `).all(postId);
  return ids ? rows.filter((r) => ids.has(r.id)) : rows;
}

function saveAnalysis(commentId, a, model) {
  db.prepare(`
    INSERT INTO analyses (comment_id, category, severity, recommended_action, english_translation, explanation, action_reason, model, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(comment_id) DO UPDATE SET category = excluded.category, severity = excluded.severity,
      recommended_action = excluded.recommended_action, english_translation = excluded.english_translation,
      explanation = excluded.explanation, action_reason = excluded.action_reason, model = excluded.model, analyzed_at = excluded.analyzed_at
  `).run(commentId, a.category, a.severity, a.recommended_action, a.english_translation, a.explanation, a.action_reason, model || null, now());
}

// Comments the automation may act on: analyzed, still visible, not the Page's own, never touched
// by a human, not already processed, and posted AFTER the post started being tracked (so tracking
// an old post never mass-acts on its backlog).
function automodCandidates(postIds, { includeBacklog = false } = {}) {
  if (!postIds.length) return [];
  const ph = postIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT c.id, c.post_id, c.message, c.from_name, c.from_id, c.is_hidden, a.category, a.severity, a.recommended_action, a.action_reason
    FROM comments c
    JOIN analyses a ON a.comment_id = c.id
    JOIN posts p ON p.id = c.post_id
    WHERE c.post_id IN (${ph})
      AND c.deleted = 0 AND c.is_page_author = 0 AND c.handled_by_human = 0
      AND c.automod_status IS NULL
      ${includeBacklog ? '' : 'AND (p.tracked_at IS NULL OR c.created_time >= p.tracked_at)'}
    ORDER BY a.severity DESC, c.created_time ASC
  `).all(...postIds);
}

// ---------- runs & actions ----------

function startRun(trigger, dryRun) {
  return db.prepare('INSERT INTO runs (trigger, status, dry_run) VALUES (?, ?, ?)').run(trigger, 'running', dryRun ? 1 : 0).lastInsertRowid;
}

function finishRun(id, patch) {
  const fields = ['status', 'elapsed_ms', 'posts_checked', 'new_comments', 'analyzed', 'deleted', 'hidden', 'failed', 'skipped', 'meta_calls', 'error', 'notes'];
  const sets = ['finished_at = ?'];
  const vals = [now()];
  for (const f of fields) {
    if (patch[f] !== undefined) { sets.push(`${f} = ?`); vals.push(f === 'notes' && patch[f] != null ? JSON.stringify(patch[f]) : patch[f]); }
  }
  db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getRun(id);
}

// Any run still "running" at boot was cut off by a restart.
function failOrphanRuns() {
  return db.prepare("UPDATE runs SET status = 'error', error = 'interrupted (server restarted)', finished_at = ? WHERE status = 'running'").run(now()).changes;
}

function parseRun(r) {
  if (!r) return null;
  let notes = null;
  try { notes = r.notes ? JSON.parse(r.notes) : null; } catch { notes = null; }
  return { ...r, notes };
}

function getRun(id) {
  return parseRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
}

function listRuns(limit = 30) {
  return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(Math.min(200, limit)).map(parseRun);
}

function lastFinishedRun() {
  return parseRun(db.prepare("SELECT * FROM runs WHERE status != 'running' ORDER BY id DESC LIMIT 1").get());
}

function logAction(a) {
  return db.prepare(`
    INSERT INTO actions (source, run_id, action, comment_id, post_id, from_name, message_preview, category, severity, reason, dry_run, success, error)
    VALUES (@source, @run_id, @action, @comment_id, @post_id, @from_name, @message_preview, @category, @severity, @reason, @dry_run, @success, @error)
  `).run({
    source: a.source,
    run_id: a.run_id ?? null,
    action: a.action,
    comment_id: a.comment_id ?? null,
    post_id: a.post_id ?? null,
    from_name: a.from_name ?? null,
    message_preview: a.message ? String(a.message).slice(0, 300) : null,
    category: a.category ?? null,
    severity: a.severity ?? null,
    reason: a.reason ? String(a.reason).slice(0, 300) : null,
    dry_run: a.dry_run ? 1 : 0,
    success: a.success ? 1 : 0,
    error: a.error ? String(a.error).slice(0, 300) : null,
  }).lastInsertRowid;
}

function listActions({ runId = null, limit = 100 } = {}) {
  if (runId) return db.prepare('SELECT * FROM actions WHERE run_id = ? ORDER BY id ASC').all(runId);
  return db.prepare('SELECT * FROM actions ORDER BY id DESC LIMIT ?').all(Math.min(500, limit));
}

// ---------- blocked users ----------

function upsertBlocked({ psid, name, reason }) {
  db.prepare(`INSERT INTO blocked_users (psid, name, reason) VALUES (?, ?, ?)
    ON CONFLICT(psid) DO UPDATE SET name = COALESCE(excluded.name, blocked_users.name), reason = excluded.reason, blocked_at = ?, unblocked_at = NULL`)
    .run(psid, name, reason, now());
}

function markUnblocked(psid) {
  db.prepare('UPDATE blocked_users SET unblocked_at = ? WHERE psid = ?').run(now(), psid);
}

function listBlocked() {
  return db.prepare('SELECT * FROM blocked_users WHERE unblocked_at IS NULL ORDER BY blocked_at DESC').all();
}

// ---------- safety counters ----------

function getDailyCallCount(day) {
  return db.prepare('SELECT calls FROM daily_call_counter WHERE day = ?').get(day)?.calls ?? 0;
}

function incrementDailyCallCount(day) {
  db.prepare('INSERT INTO daily_call_counter (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = calls + 1').run(day);
}

function getCooldown(endpoint) {
  return db.prepare('SELECT * FROM endpoint_cooldowns WHERE endpoint = ?').get(endpoint) || null;
}

function setCooldown(endpoint, until, reason, consecutive) {
  db.prepare(`INSERT INTO endpoint_cooldowns (endpoint, cooldown_until, reason, consecutive_errors) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET cooldown_until = excluded.cooldown_until, reason = excluded.reason, consecutive_errors = excluded.consecutive_errors`)
    .run(endpoint, until, reason, consecutive);
}

function clearCooldown(endpoint) {
  db.prepare('DELETE FROM endpoint_cooldowns WHERE endpoint = ?').run(endpoint);
}

function activeCooldowns() {
  return db.prepare('SELECT * FROM endpoint_cooldowns WHERE cooldown_until > ?').all(now());
}

export const store = {
  db,
  getSetting, setSetting,
  upsertPost, listPosts, getPost, listTrackedPosts, setTracked: (ids) => setTrackedTx(ids), setPostSynced, savePostAnalysis, deletePost,
  upsertComments: (postId, rows) => upsertCommentsTx(postId, rows), knownCommentIds, reconcileDeleted,
  getComment, commentsForPost, setCommentHidden, markCommentDeleted, setCommentLiked, setCommentReply,
  markHandledByHuman, setAutomodStatus, inbox, inboxCounts,
  unanalyzedForPost, saveAnalysis, automodCandidates,
  startRun, finishRun, failOrphanRuns, getRun, listRuns, lastFinishedRun, logAction, listActions,
  upsertBlocked, markUnblocked, listBlocked,
  getDailyCallCount, incrementDailyCallCount, getCooldown, setCooldown, clearCooldown, activeCooldowns,
};
