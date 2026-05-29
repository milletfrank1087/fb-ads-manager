import { fb } from './fbClient.js';
import { maskToken } from './env.js';
import { log } from './logger.js';

const TARGET_PAGE_ID = (process.env.FB_TARGET_PAGE_ID || '113297813778299').trim();
const TTL_MS = 60 * 60 * 1000;

const cache = { token: null, pageId: null, pageName: null, mintedAtMs: 0 };

async function mint() {
  const res = await fb.get(`/${TARGET_PAGE_ID}`, { fields: 'access_token,name' }, 'GET:/page/mint');
  if (!res.ok) {
    log.error('pageToken.mint.failed', {
      error: res.error?.message || res.error || res.message || 'mint_failed',
      code: res.error?.code ?? null,
      blocked: res.blocked || false,
    });
    return { ok: false, error: res.error?.message || res.error || res.message || 'mint_failed', code: res.error?.code ?? null };
  }
  const body = res.body || {};
  if (!body.access_token) {
    log.error('pageToken.mint.no_token_field', { pageId: body.id ?? null, name: body.name ?? null });
    return { ok: false, error: 'no_access_token_in_response' };
  }
  cache.token = body.access_token;
  cache.pageId = body.id || TARGET_PAGE_ID;
  cache.pageName = body.name || null;
  cache.mintedAtMs = Date.now();
  log.info('pageToken.minted', {
    pageId: cache.pageId,
    pageName: cache.pageName,
    tokenMasked: maskToken(body.access_token),
    tokenLen: body.access_token.length,
  });
  return { ok: true, token: cache.token, pageId: cache.pageId, pageName: cache.pageName };
}

export const pageToken = {
  targetPageId: TARGET_PAGE_ID,

  async get({ force = false } = {}) {
    if (!force && cache.token && Date.now() - cache.mintedAtMs < TTL_MS) {
      return { ok: true, token: cache.token, pageId: cache.pageId, pageName: cache.pageName, cached: true };
    }
    return mint();
  },

  invalidate(reason) {
    log.warn('pageToken.invalidated', {
      reason,
      hadToken: Boolean(cache.token),
      ageSec: cache.mintedAtMs ? Math.round((Date.now() - cache.mintedAtMs) / 1000) : null,
    });
    cache.token = null;
    cache.mintedAtMs = 0;
  },

  snapshot() {
    return {
      hasToken: Boolean(cache.token),
      pageId: cache.pageId,
      pageName: cache.pageName,
      ageSec: cache.mintedAtMs ? Math.round((Date.now() - cache.mintedAtMs) / 1000) : null,
      ttlSec: Math.round(TTL_MS / 1000),
      targetPageId: TARGET_PAGE_ID,
    };
  },
};
