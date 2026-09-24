import { fb } from './fbClient.js';
import { store } from './store.js';
import { config } from './env.js';
import { log } from './logger.js';

export const COMMENT_FIELDS = [
  'id', 'message', 'created_time', 'like_count', 'is_hidden', 'can_hide', 'can_remove', 'user_likes',
  'from{id,name}', 'parent{id}', 'attachment{type,url}', 'permalink_url',
].join(',');

// Meta returns "2026-09-23T15:51:53+0000"; store ISO so string comparison with tracked_at works.
function isoTime(t) {
  const d = new Date(t || 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Maps a raw Graph comment list to rows, linking each comment to the Page's own reply (if any).
export function normalizeComments(raw) {
  const pageId = String(config.targetPageId);
  const rows = (raw || []).map((c) => ({
    id: c.id,
    parent_id: c.parent?.id ?? null,
    message: c.message ?? '',
    from_id: c.from?.id ?? null,
    from_name: c.from?.name ?? null,
    created_time: isoTime(c.created_time),
    like_count: Number(c.like_count || 0),
    is_hidden: c.is_hidden ? 1 : 0,
    can_hide: c.can_hide === false ? 0 : 1,
    can_remove: c.can_remove === false ? 0 : 1,
    user_likes: c.user_likes ? 1 : 0,
    permalink_url: c.permalink_url ?? null,
    attachment_type: c.attachment?.type ?? null,
    attachment_url: c.attachment?.url ?? null,
    is_page_author: String(c.from?.id || '') === pageId ? 1 : 0,
    my_reply_id: null,
  }));
  const replyByParent = new Map();
  for (const r of rows) if (r.is_page_author && r.parent_id && !replyByParent.has(r.parent_id)) replyByParent.set(r.parent_id, r.id);
  for (const r of rows) if (replyByParent.has(r.id)) r.my_reply_id = replyByParent.get(r.id);
  return rows;
}

function errText(res) {
  return res?.error?.message || res?.message || (typeof res?.error === 'string' ? res.error : 'failed');
}

// Runs one write, records it in the action log, and marks manual actions as human-handled.
async function perform(action, commentId, run, { source = 'manual', runId = null, reason = null, dryRun = false } = {}) {
  const row = store.getComment(commentId);
  const entry = {
    source, run_id: runId, action, comment_id: commentId, post_id: row?.post_id, from_name: row?.from_name,
    message: row?.message, category: row?.category, severity: row?.severity, reason, dry_run: dryRun,
  };
  if (dryRun) {
    store.logAction({ ...entry, success: true });
    return { ok: true, dryRun: true };
  }
  const res = await run();
  // Deleting a comment that is already gone (#100 / subcode 33) counts as done.
  const gone = action === 'delete' && !res.ok && Number(res.error?.code) === 100 && Number(res.error?.error_subcode) === 33;
  const ok = res.ok || gone;
  store.logAction({ ...entry, success: ok, error: ok ? null : errText(res) });
  if (ok && source === 'manual') store.markHandledByHuman(commentId);
  if (!ok) log.warn('comment.action.failed', { action, commentId, source, error: errText(res) });
  return ok ? { ok: true, res } : { ok: false, blocked: !!res.blocked, error: res.error, message: errText(res) };
}

export async function hide(id, opts) {
  const r = await perform('hide', id, () => fb.write('POST', `/${id}`, { is_hidden: true }, 'POST:/comment/hide'), opts);
  if (r.ok && !r.dryRun) store.setCommentHidden(id, true);
  return r;
}

export async function unhide(id, opts) {
  const r = await perform('unhide', id, () => fb.write('POST', `/${id}`, { is_hidden: false }, 'POST:/comment/hide'), opts);
  if (r.ok && !r.dryRun) store.setCommentHidden(id, false);
  return r;
}

export async function remove(id, opts = {}) {
  const r = await perform('delete', id, () => fb.write('DELETE', `/${id}`, null, 'DELETE:/comment'), opts);
  if (r.ok && !r.dryRun) store.markCommentDeleted(id, opts.source === 'automod' ? 'automod' : 'manual');
  return r;
}

export async function like(id, opts) {
  const r = await perform('like', id, () => fb.write('POST', `/${id}/likes`, null, 'POST:/comment/likes'), opts);
  if (r.ok) store.setCommentLiked(id, true);
  return r;
}

export async function unlike(id, opts) {
  const r = await perform('unlike', id, () => fb.write('DELETE', `/${id}/likes`, null, 'DELETE:/comment/likes'), opts);
  if (r.ok) store.setCommentLiked(id, false);
  return r;
}

export async function reply(id, message, opts) {
  const r = await perform('reply', id, () => fb.write('POST', `/${id}/comments`, { message }, 'POST:/comment/reply'), { ...opts, reason: message });
  if (r.ok && r.res?.body?.id) store.setCommentReply(id, r.res.body.id);
  return r;
}

// Blocking needs the commenter's Page-scoped ID, which Meta usually withholds (App Review +
// "Business Asset User Profile Access" feature). Without it there is nothing to block.
export async function block(id, opts = {}) {
  const row = store.getComment(id);
  if (!row?.from_id || row.is_page_author) {
    return { ok: false, error: 'no_psid', message: 'Meta did not return this commenter’s ID, so they cannot be blocked.' };
  }
  const r = await perform('block', id, () => fb.write('POST', `/${config.targetPageId}/blocked`, { psid: row.from_id }, 'POST:/page/blocked'), opts);
  if (r.ok && !r.dryRun) store.upsertBlocked({ psid: row.from_id, name: row.from_name, reason: opts.reason || null });
  return r;
}

export async function unblock(psid) {
  const res = await fb.write('DELETE', `/${config.targetPageId}/blocked`, { psid }, 'DELETE:/page/blocked');
  store.logAction({ source: 'manual', action: 'unblock', reason: psid, success: res.ok, error: res.ok ? null : errText(res) });
  if (!res.ok) return { ok: false, blocked: !!res.blocked, message: errText(res) };
  store.markUnblocked(psid);
  return { ok: true };
}

export const ACTIONS = { hide, unhide, delete: remove, like, unlike, block };
