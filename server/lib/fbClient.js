import crypto from 'node:crypto';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config, maskToken } from './env.js';
import { log } from './logger.js';
import { safety } from './safety.js';
import { pageToken } from './pageToken.js';

const http = axios.create({
  baseURL: config.graphBase,
  timeout: config.timeoutMs,
  validateStatus: () => true,
  headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
  ...(config.proxyUrl ? { httpsAgent: new HttpsProxyAgent(config.proxyUrl), proxy: false } : {}),
});

log.info('fb.client.init', { proxy: config.proxyUrl ? `${config.proxyHost}:${config.proxyPort}` : 'none (direct connection)' });

// A non-2xx with an empty body that returns this fast never reached Meta (proxy/egress refusal),
// so retrying cannot double-apply a write.
const PROXY_REJECT_MAX_MS = 400;
const PROXY_REJECT_MAX_RETRIES = 2;

let callCounter = 0;
let usagePct = 0;

// Every request waits its turn here, so the minimum gap holds even when callers run concurrently.
let queue = Promise.resolve();
let lastCallAt = 0;
function throttleSlot() {
  const slot = queue.then(async () => {
    const gap = config.minGapMs + Math.floor(Math.random() * 200);
    const wait = lastCallAt + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (usagePct >= 90) {
      log.warn('fb.backoff', { usagePct, waitS: 60 });
      await new Promise((r) => setTimeout(r, 60_000));
    } else if (usagePct >= 80) {
      await new Promise((r) => setTimeout(r, 5_000));
    }
    lastCallAt = Date.now();
  });
  queue = slot.catch(() => {});
  return slot;
}

function appSecretProof(token) {
  return crypto.createHmac('sha256', config.appSecret).update(token).digest('hex');
}

function parseHeader(headers, name) {
  const raw = headers?.[name];
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

// Highest utilisation % across x-app-usage / x-business-use-case-usage, plus Meta's
// estimated minutes until access returns.
function readUsage(headers) {
  let pct = 0;
  let eta = 0;
  const pick = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of ['call_count', 'total_time', 'total_cputime']) pct = Math.max(pct, Number(o[k] || 0));
    eta = Math.max(eta, Number(o.estimated_time_to_regain_access || 0));
  };
  pick(parseHeader(headers, 'x-app-usage'));
  const buc = parseHeader(headers, 'x-business-use-case-usage');
  if (buc) for (const arr of Object.values(buc)) if (Array.isArray(arr)) arr.forEach(pick);
  return { pct, eta };
}

async function resolveToken(tokenKind) {
  if (tokenKind !== 'page') return { ok: true, token: config.systemToken };
  const r = await pageToken.get();
  return r.ok ? { ok: true, token: r.token } : { ok: false, error: 'page_token_unavailable', message: r.error };
}

async function request(method, path, { params, data, endpoint, kind = 'READ', tokenKind = 'sysuser', retried = false } = {}) {
  const ep = endpoint || `${method}:${path}`;
  const pre = safety.preflight(ep, kind);
  if (!pre.ok) {
    log.warn('fb.blocked', { endpoint: ep, error: pre.error });
    return { ok: false, blocked: true, ...pre };
  }
  const tok = await resolveToken(tokenKind);
  if (!tok.ok) return { ok: false, error: tok.error, message: tok.message };

  const auth = { access_token: tok.token, appsecret_proof: appSecretProof(tok.token) };
  const req = { method, url: path.startsWith('/') ? path : `/${path}` };
  if (method === 'GET' || method === 'DELETE') {
    req.params = { ...auth, ...(params || {}) };
  } else {
    const body = new URLSearchParams(auth);
    for (const [k, v] of Object.entries(data || {})) {
      if (v !== undefined && v !== null) body.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    req.data = body.toString();
    req.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  }

  let res;
  let elapsedMs = 0;
  for (let attempt = 0; ; attempt += 1) {
    await throttleSlot();
    safety.recordCall();
    callCounter += 1;
    const t0 = Date.now();
    try {
      res = await http.request(req);
    } catch (err) {
      const message = String(err.message || err);
      log.error('fb.transport_error', { endpoint: ep, error: message });
      safety.recordError(ep, { message });
      return { ok: false, transportError: true, error: 'transport_error', message };
    }
    elapsedMs = Date.now() - t0;
    const empty = res.data == null || (typeof res.data === 'string' && !res.data.trim());
    const proxyReject = (res.status < 200 || res.status >= 300) && empty && elapsedMs < PROXY_REJECT_MAX_MS;
    if (!proxyReject || attempt >= PROXY_REJECT_MAX_RETRIES) break;
    log.warn('fb.proxy_retry', { endpoint: ep, status: res.status, elapsedMs, attempt: attempt + 1 });
  }

  const usage = readUsage(res.headers);
  usagePct = usage.pct;
  const body = res.data;

  if (body && typeof body === 'object' && body.error) {
    const e = body.error;
    if (tokenKind === 'page' && Number(e.code) === 190 && !retried) {
      pageToken.invalidate(`190 on ${ep}`);
      return request(method, path, { params, data, endpoint, kind, tokenKind, retried: true });
    }
    safety.recordError(ep, { code: e.code, subcode: e.error_subcode, httpStatus: res.status, etaMinutes: usage.eta, message: e.message });
    log.error('fb.api_error', { endpoint: ep, http: res.status, code: e.code, subcode: e.error_subcode, message: (e.message || '').slice(0, 160), elapsedMs });
    return { ok: false, apiError: true, error: e, message: e.message, httpStatus: res.status };
  }
  if (res.status < 200 || res.status >= 300) {
    const message = `HTTP ${res.status} with no Graph error body (${elapsedMs}ms) — proxy/edge rejection.`;
    safety.recordError(ep, { httpStatus: res.status, message });
    log.error('fb.http_error', { endpoint: ep, status: res.status, elapsedMs });
    return { ok: false, httpStatus: res.status, error: 'http_error', message };
  }

  safety.recordSuccess(ep);
  log.info('fb.api', { endpoint: ep, http: res.status, elapsedMs, callNo: callCounter, usagePct: usage.pct });
  return { ok: true, body, elapsedMs };
}

export const fb = {
  get(path, params, endpoint, { tokenKind } = {}) {
    return request('GET', path, { params, endpoint, kind: 'READ', tokenKind });
  },

  // Writes always use the Page token and are gated by FB_ALLOW_COMMENT_MODERATION.
  write(method, path, data, endpoint) {
    return request(method, path, { data, params: method === 'DELETE' ? data : undefined, endpoint, kind: 'WRITE', tokenKind: 'page' });
  },

  // Read-only batch (GET sub-ops only). Returns parsed[name] = { ok, code, body }.
  async batch(ops, endpoint, { tokenKind } = {}) {
    if (!ops.length) return { ok: true, parsed: {} };
    if (ops.some((o) => (o.method || 'GET') !== 'GET')) throw new Error('fb.batch is read-only');
    const parsed = {};
    for (let i = 0; i < ops.length; i += 50) {
      const chunk = ops.slice(i, i + 50);
      const res = await request('POST', '/', {
        data: { batch: chunk.map((o) => ({ method: 'GET', relative_url: o.relative_url.replace(/^\/+/, ''), name: o.name })) },
        endpoint, kind: 'READ', tokenKind,
      });
      if (!res.ok) return res;
      const items = Array.isArray(res.body) ? res.body : [];
      chunk.forEach((o, j) => {
        const item = items[j];
        if (!item) { parsed[o.name] = { ok: false, code: 0, body: null }; return; }
        let body = null;
        try { body = typeof item.body === 'string' ? JSON.parse(item.body) : item.body; } catch { body = null; }
        const code = Number(item.code || 0);
        parsed[o.name] = { ok: code >= 200 && code < 300 && body && !body.error, code, body };
      });
    }
    return { ok: true, parsed };
  },

  meta() {
    return {
      proxy: config.proxyUrl ? `${config.proxyHost}:${config.proxyPort}` : null,
      graphVersion: config.graphVersion,
      token: maskToken(config.systemToken),
      pageId: config.targetPageId,
    };
  },
};
