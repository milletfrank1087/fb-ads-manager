import { fb } from './fbClient.js';
import { store } from './store.js';
import { config } from './env.js';
import { log } from './logger.js';

const POST_FIELDS = 'id,message,created_time,permalink_url,full_picture';
const LIVE_AD_STATUSES = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'PREAPPROVED'];

const pagePrefix = () => `${config.targetPageId}_`;

function postRow(p, source, extra = {}) {
  return {
    id: p.id,
    source,
    message: p.message ?? null,
    permalink_url: p.permalink_url ?? null,
    picture_url: p.full_picture ?? null,
    created_time: p.created_time ? new Date(p.created_time).toISOString() : null,
    ...extra,
  };
}

const AD_FIELDS = 'id,name,effective_status,campaign{name},creative{effective_object_story_id,object_story_id}';
const AD_FILTER = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: LIVE_AD_STATUSES }]);

// Every ad account the system-user token can see (one Page is often advertised from several
// accounts). FB_AD_ACCOUNT_IDS narrows it to a comma-separated list if set.
async function adAccounts() {
  const res = await fb.get('/me/adaccounts', { fields: 'id,name,account_status', limit: 100 }, 'GET:/me/adaccounts');
  if (!res.ok) return { ok: false, message: res.message || 'ad accounts read failed' };
  let accounts = res.body?.data || [];
  const only = (process.env.FB_AD_ACCOUNT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (only.length) accounts = accounts.filter((a) => only.includes(a.id));
  return { ok: true, accounts };
}

// Ads (all accounts, one batch) → the Page posts they promote (incl. dark posts), grouped so one
// post lists all its ads. An ad only counts as running if its account is active (status 1).
// Any ad creative that is currently ACTIVE or delivered impressions/spend in the last 14 days
// is automatically tracked when first discovered.
async function discoverAdPosts() {
  const acc = await adAccounts();
  if (!acc.ok) return acc;
  if (!acc.accounts.length) return { ok: true, count: 0, accounts: 0 };

  const active14dAdIds = new Set();
  const insRes = await fb.batch(
    acc.accounts.map((a, i) => ({ name: `i${i}`, relative_url: `${a.id}/insights?level=ad&date_preset=last_14d&fields=ad_id,impressions,spend&limit=500` })),
    'GET:/act/insights_14d',
  );
  if (insRes.ok) {
    for (const [i] of acc.accounts.entries()) {
      const rows = insRes.parsed[`i${i}`]?.body?.data || [];
      for (const r of rows) {
        if (Number(r.impressions || 0) > 0 || Number(r.spend || 0) > 0) active14dAdIds.add(r.ad_id);
      }
    }
  }

  const ads = [];
  const res = await fb.batch(
    acc.accounts.map((a, i) => ({ name: `a${i}`, relative_url: `${a.id}/ads?fields=${encodeURIComponent(AD_FIELDS)}&filtering=${encodeURIComponent(AD_FILTER)}&limit=200` })),
    'GET:/act/ads',
  );
  if (!res.ok) return { ok: false, message: res.message || 'ads read failed' };
  for (const [i, a] of acc.accounts.entries()) {
    const sub = res.parsed[`a${i}`];
    if (!sub?.ok) { log.warn('posts.discover.account_failed', { account: a.id, error: sub?.body?.error?.message }); continue; }
    const accountActive = Number(a.account_status) === 1;
    const push = (rows) => ads.push(...rows.map((ad) => ({ ...ad, accountName: a.name, accountActive })));
    push(sub.body?.data || []);
    let next = sub.body?.paging?.next ? sub.body.paging.cursors?.after : null;
    for (let page = 1; next && page < 5; page += 1) {
      const more = await fb.get(`/${a.id}/ads`, { fields: AD_FIELDS, filtering: AD_FILTER, limit: 200, after: next }, 'GET:/act/ads');
      if (!more.ok) break;
      push(more.body?.data || []);
      next = more.body?.paging?.next ? more.body.paging.cursors?.after : null;
    }
  }

  const byPost = new Map();
  for (const ad of ads) {
    const postId = ad.creative?.effective_object_story_id || ad.creative?.object_story_id;
    if (!postId || !postId.startsWith(pagePrefix())) continue;
    const g = byPost.get(postId) || { ads: new Set(), campaigns: new Set(), active: false, active14d: false };
    g.ads.add(ad.name);
    if (ad.campaign?.name) g.campaigns.add(ad.campaign.name);
    const isNowActive = ad.effective_status === 'ACTIVE' && ad.accountActive;
    if (isNowActive) g.active = true;
    if (isNowActive || active14dAdIds.has(ad.id)) g.active14d = true;
    byPost.set(postId, g);
  }

  const ids = [...byPost.keys()];
  const seen = new Set(ids);
  const existingIds = new Set(store.listPosts().map((p) => p.id));
  for (const p of store.listPosts()) {
    if (p.source === 'ad' && !seen.has(p.id)) store.db.prepare("UPDATE posts SET ad_status = 'ENDED' WHERE id = ?").run(p.id);
  }
  const meta = await fb.batch(
    ids.map((id, i) => ({ name: `p${i}`, relative_url: `${id}?fields=${POST_FIELDS}` })),
    'GET:/posts/meta',
    { tokenKind: 'page' },
  );
  if (!meta.ok) return { ok: false, message: meta.message || 'post read failed' };
  const autoTrackStmt = store.db.prepare('UPDATE posts SET tracked = 1, tracked_at = COALESCE(tracked_at, ?) WHERE id = ? AND tracked = 0');
  const nowIso = new Date().toISOString();
  const hadNoTracked = store.listTrackedPosts().length === 0;
  let autoTracked = 0;
  ids.forEach((id, i) => {
    const g = byPost.get(id);
    const body = meta.parsed[`p${i}`]?.ok ? meta.parsed[`p${i}`].body : { id };
    const isNew = !existingIds.has(id);
    store.upsertPost(postRow({ ...body, id }, 'ad', {
      ad_names: [...g.ads].join(' · '),
      campaign_names: [...g.campaigns].join(' · '),
      ad_status: g.active ? 'ACTIVE' : 'PAUSED',
    }));
    if (g.active14d && (isNew || hadNoTracked)) {
      autoTrackStmt.run(nowIso, id);
      autoTracked += 1;
    }
  });
  return { ok: true, count: ids.length, autoTracked };
}

async function discoverPagePosts() {
  const res = await fb.get(`/${config.targetPageId}/published_posts`, { fields: POST_FIELDS, limit: 50 }, 'GET:/page/published_posts', { tokenKind: 'page' });
  if (!res.ok) return { ok: false, message: res.message || 'page posts read failed' };
  const posts = res.body?.data || [];
  for (const p of posts) store.upsertPost(postRow(p, 'page'));
  return { ok: true, count: posts.length };
}

export async function discover() {
  const ads = await discoverAdPosts();
  const page = await discoverPagePosts();
  log.info('posts.discover', { ads: ads.count ?? ads.message, page: page.count ?? page.message });
  return { ok: ads.ok || page.ok, ads, page };
}

// Accepts "{pageId}_{postId}", a bare numeric post id, or a Facebook URL.
function parsePostRef(input) {
  const s = String(input || '').trim();
  if (!s) return { error: 'Paste a post link or ID.' };
  if (/^\d+_\d+$/.test(s)) return { id: s };
  if (/^\d+$/.test(s)) return { id: `${pagePrefix()}${s}` };
  const numeric = s.match(/(?:story_fbid=|fbid=|\/posts\/|\/videos\/|\/permalink\/)(\d{6,})/);
  if (numeric) return { id: `${pagePrefix()}${numeric[1]}` };
  const pfbid = s.match(/pfbid[0-9A-Za-z]+/);
  if (pfbid) {
    const known = store.listPosts().find((p) => (p.permalink_url || '').includes(pfbid[0]));
    if (known) return { id: known.id };
    return { error: 'That link uses a pfbid code that can’t be converted. Click "Refresh list" first, or paste the numeric post ID.' };
  }
  return { error: 'Couldn’t find a post ID in that text.' };
}

export async function addManual(input) {
  const ref = parsePostRef(input);
  if (ref.error) return { ok: false, message: ref.error };
  if (!ref.id.startsWith(pagePrefix())) return { ok: false, message: 'That post belongs to a different Page.' };
  const res = await fb.get(`/${ref.id}`, { fields: POST_FIELDS }, 'GET:/posts/manual', { tokenKind: 'page' });
  if (!res.ok) return { ok: false, message: res.message || 'Could not read that post with the Page token.' };
  store.upsertPost(postRow({ ...res.body, id: ref.id }, store.getPost(ref.id)?.source || 'manual'));
  const tracked = store.listTrackedPosts().map((p) => p.id);
  store.setTracked([...new Set([...tracked, ref.id])]);
  return { ok: true, post: store.getPost(ref.id) };
}
