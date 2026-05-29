import { fb } from './fbClient.js';
import { store } from './store.js';
import { config } from './env.js';
import { log } from './logger.js';

// NOTE: deliberately NO nested `comments{...}` (replies) here. With filter=stream the
// API already returns replies as flat items carrying parent{id}, so we reconstruct the
// page's own reply via linkMyReplies() instead of double-nesting — that keeps each
// comment node small enough to field-expand 25+ posts inside a single batch request.
export const COMMENT_FIELDS = [
  'id',
  'message',
  'created_time',
  'like_count',
  'comment_count',
  'is_hidden',
  'can_hide',
  'can_remove',
  'can_reply_privately',
  'user_likes',
  'from{id,name,picture}',
  'parent{id}',
  'attachment',
  'permalink_url',
].join(',');

const URL_RE = /(https?:\/\/|www\.)|\b[a-z0-9-]+\.(com|net|org|gr|io|co|shop|store|link|info|xyz|ru|me)\b/i;
const CONTACT_RE = /(\bwhats?app\b|\btelegram\b|\bviber\b|\bdm\b|\binbox\b|@[a-z0-9_.]+|\+?\d[\d\s().-]{7,}\d)/i;
const SPAM_KEYWORDS = [
  'free money', 'easy money', 'make money', 'work from home', 'investment',
  'crypto', 'bitcoin', 'forex', 'click here', 'click the link', 'congratulations you',
  'you won', 'winner', 'giveaway', 'promo code', 'discount code', 'cheap',
  'earn $', 'earn money', 'guaranteed', 'limited offer',
];

export function detectFlags(message) {
  const reasons = [];
  const text = (message || '').toString();
  const lower = text.toLowerCase();
  if (URL_RE.test(text)) reasons.push('link');
  if (CONTACT_RE.test(text)) reasons.push('contact');
  if (SPAM_KEYWORDS.some((k) => lower.includes(k))) reasons.push('spam_keyword');
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 8 && letters === letters.toUpperCase()) reasons.push('all_caps');
  if (/(.)\1{6,}/.test(text)) reasons.push('repetitive');
  return { flagged: reasons.length > 0, reasons };
}

function pictureUrl(c) {
  return c?.from?.picture?.data?.url || null;
}

/**
 * Given a post's full (paginated) flat comment stream, mark each parent comment with
 * the id of the Page's own reply to it (myReplyId). Works off parent_id + from_id===pageId,
 * so it needs no extra nested API fields. Mutates and returns the same array.
 */
export function linkMyReplies(normalized) {
  const pageId = config.targetPageId;
  if (!pageId || !Array.isArray(normalized)) return normalized;
  const replyByParent = new Map();
  for (const c of normalized) {
    if (c.parentId && c.fromId && String(c.fromId) === String(pageId) && !replyByParent.has(c.parentId)) {
      replyByParent.set(c.parentId, c.id);
    }
  }
  for (const c of normalized) {
    if (replyByParent.has(c.id)) c.myReplyId = replyByParent.get(c.id);
  }
  return normalized;
}

export function normalizeComment(c) {
  const { flagged, reasons } = detectFlags(c.message);
  return {
    id: c.id,
    parentId: c.parent?.id ?? null,
    message: c.message ?? '',
    fromId: c.from?.id ?? null,
    fromName: c.from?.name ?? null,
    fromPictureUrl: pictureUrl(c),
    createdTime: c.created_time ?? null,
    likeCount: Number(c.like_count || 0),
    commentCount: Number(c.comment_count || 0),
    isHidden: Boolean(c.is_hidden),
    canHide: c.can_hide === false ? false : true,
    canRemove: c.can_remove === false ? false : true,
    canReplyPrivately: Boolean(c.can_reply_privately),
    userLikes: Boolean(c.user_likes),
    permalinkUrl: c.permalink_url ?? null,
    attachmentType: c.attachment?.type ?? null,
    attachmentUrl: c.attachment?.url ?? null,
    attachmentJson: c.attachment ? JSON.stringify(c.attachment).slice(0, 4000) : null,
    hasUrl: URL_RE.test(c.message || ''),
    myReplyId: null,
    flagged,
    flagReasons: reasons,
  };
}

/** Map a raw comments array → normalized list with page-reply linkage applied. */
export function normalizeCommentList(rawList) {
  return linkMyReplies((rawList || []).map(normalizeComment));
}

// ---------- write actions (all gated by FB_ALLOW_COMMENT_MODERATION via fb.moderate) ----------

function isGoneError(res) {
  const e = res?.error;
  return e && Number(e.code) === 100 && Number(e.error_subcode) === 33;
}

async function audit(action, commentId, run, { payload = null } = {}) {
  const row = commentId ? store.getCommentById(commentId) : null;
  try {
    const res = await run();
    const softOk = action === 'delete' && !res.ok && isGoneError(res);
    const ok = res.ok || softOk;
    store.logModeration({
      action,
      commentId,
      postId: row?.post_id || null,
      commenterPsid: row?.from_id || null,
      commenterName: row?.from_name || null,
      messagePreview: row?.message || null,
      payload,
      response: ok ? (res.body ?? (softOk ? { soft_success: true } : null)) : (res.error || res.message || null),
      success: ok,
      errorMessage: ok ? null : (res.error?.message || res.error || res.message || 'failed'),
    });
    return { res, ok, softOk, row };
  } catch (err) {
    store.logModeration({ action, commentId, postId: row?.post_id || null, commenterPsid: row?.from_id || null, commenterName: row?.from_name || null, messagePreview: row?.message || null, payload, success: false, errorMessage: String(err.message || err) });
    throw err;
  }
}

export async function hide(commentId) {
  log.warn('comments.hide.request', { commentId });
  const { res, ok } = await audit('hide', commentId, () => fb.moderate('POST', `/${commentId}`, { is_hidden: true }, 'POST:/comment/hide'));
  if (res.blocked) return { ok: false, blocked: true, error: res.error, message: res.message };
  if (!ok) return { ok: false, error: res.error?.message || res.error || res.message || 'hide_failed' };
  store.setCommentHidden(commentId, true);
  return { ok: true, action: 'hide' };
}

export async function unhide(commentId) {
  log.warn('comments.unhide.request', { commentId });
  const { res, ok } = await audit('unhide', commentId, () => fb.moderate('POST', `/${commentId}`, { is_hidden: false }, 'POST:/comment/hide'));
  if (res.blocked) return { ok: false, blocked: true, error: res.error, message: res.message };
  if (!ok) return { ok: false, error: res.error?.message || res.error || res.message || 'unhide_failed' };
  store.setCommentHidden(commentId, false);
  return { ok: true, action: 'unhide' };
}

export async function remove(commentId) {
  log.warn('comments.delete.request', { commentId });
  const { res, ok, softOk } = await audit('delete', commentId, () => fb.moderate('DELETE', `/${commentId}`, null, 'DELETE:/comment'));
  if (res.blocked) return { ok: false, blocked: true, error: res.error, message: res.message };
  if (!ok) return { ok: false, error: res.error?.message || res.error || res.message || 'delete_failed' };
  store.markCommentDeleted(commentId);
  log.warn('comments.delete.done', { commentId, softOk: softOk || false });
  return { ok: true, action: 'delete', softSuccess: softOk || undefined };
}

export async function like(commentId) {
  const { res, ok } = await audit('like', commentId, () => fb.moderate('POST', `/${commentId}/likes`, null, 'POST:/comment/likes'));
  if (res.blocked) return { ok: false, blocked: true, error: res.error, message: res.message };
  if (!ok) return { ok: false, error: res.error?.message || res.error || res.message || 'like_failed' };
  store.setCommentUserLikes(commentId, true);
  return { ok: true, action: 'like' };
}

export async function unlike(commentId) {
  const { res, ok } = await audit('unlike', commentId, () => fb.moderate('DELETE', `/${commentId}/likes`, null, 'DELETE:/comment/likes'));
  if (res.blocked) return { ok: false, blocked: true, error: res.error, message: res.message };
  if (!ok) return { ok: false, error: res.error?.message || res.error || res.message || 'unlike_failed' };
  store.setCommentUserLikes(commentId, false);
  return { ok: true, action: 'unlike' };
}

export async function reply(commentId, message) {
  log.info('comments.reply.request', { commentId, len: (message || '').length });
  const { res, ok } = await audit('reply', commentId, () => fb.moderate('POST', `/${commentId}/comments`, { message }, 'POST:/comment/reply'), { payload: { message } });
  if (res.blocked) return { ok: false, blocked: true, error: res.error, message: res.message };
  if (!ok) return { ok: false, error: res.error?.message || res.error || res.message || 'reply_failed' };
  const replyId = res.body?.id || null;
  if (replyId) store.setCommentReplyId(commentId, replyId);
  return { ok: true, action: 'reply', replyId };
}

export async function block({ psid, name = null, reason = null }) {
  if (!psid) return { ok: false, error: 'no_psid', message: 'No commenter id available to block (anonymous/privacy-restricted).' };
  const pageId = config.targetPageId;
  const res = await fb.moderate('POST', `/${pageId}/blocked`, { psid }, 'POST:/page/blocked');
  const ok = res.ok && (res.body?.[psid] === true || res.body?.success === true || res.body?.success === undefined);
  store.logModeration({ action: 'block', commenterPsid: psid, commenterName: name, payload: { psid, reason }, response: res.body || res.error || null, success: !!ok, errorMessage: ok ? null : (res.error?.message || res.error || res.message || 'block_failed') });
  if (res.blocked) return { ok: false, blocked: true, error: res.error, message: res.message };
  if (!ok) return { ok: false, error: res.error?.message || res.error || res.message || 'block_failed' };
  store.upsertBlocked({ psid, name, reason });
  return { ok: true, action: 'block' };
}

/**
 * Block the author of a stored comment. Resolves the PSID from the comment row — note
 * the Page `blocked` edge needs a Page-Scoped ID, which Meta only returns on `from.id`
 * when the app has Business Asset User Profile Access. When it's missing (the common
 * privacy-restricted case), there is nothing to block and we say so explicitly.
 */
export async function blockByComment({ commentId, reason = null }) {
  const row = commentId ? store.getCommentById(commentId) : null;
  const psid = row?.from_id || null;
  if (!psid) {
    return { ok: false, error: 'no_psid', message: 'No commenter id available to block (privacy-restricted / anonymous commenter).' };
  }
  return block({ psid, name: row?.from_name || null, reason });
}

export async function unblock(psid) {
  if (!psid) return { ok: false, error: 'no_psid' };
  const pageId = config.targetPageId;
  const res = await fb.moderate('DELETE', `/${pageId}/blocked`, { psid }, 'DELETE:/page/blocked');
  const ok = res.ok && (res.body?.[psid] === true || res.body?.success === true || res.body?.success === undefined);
  store.logModeration({ action: 'unblock', commenterPsid: psid, payload: { psid }, response: res.body || res.error || null, success: !!ok, errorMessage: ok ? null : (res.error?.message || res.error || res.message || 'unblock_failed') });
  if (res.blocked) return { ok: false, blocked: true, error: res.error, message: res.message };
  if (!ok) return { ok: false, error: res.error?.message || res.error || res.message || 'unblock_failed' };
  store.markUnblocked(psid);
  return { ok: true, action: 'unblock' };
}

export async function deleteAndBlock({ commentId, psid = null, name = null, reason = null }) {
  const row = commentId ? store.getCommentById(commentId) : null;
  const resolvedPsid = psid || row?.from_id || null;
  if (!resolvedPsid) {
    const del = await remove(commentId);
    return { ...del, blocked: false, note: 'no_psid_deleted_only' };
  }
  const blk = await block({ psid: resolvedPsid, name: name || row?.from_name || null, reason });
  if (!blk.ok) return { ok: false, blocked: false, deleted: false, error: blk.error, message: blk.message };
  const del = await remove(commentId);
  return { ok: del.ok, blocked: true, deleted: del.ok, action: 'delete-and-block' };
}
