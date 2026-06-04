import crypto from 'node:crypto';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config, maskToken } from './env.js';
import { log } from './logger.js';
import { safety } from './safety.js';
import { store } from './store.js';
import { pageToken } from './pageToken.js';

const proxyAgent = new HttpsProxyAgent(config.proxyUrl);

const http = axios.create({
  baseURL: config.graphBase,
  timeout: config.timeoutMs,
  httpsAgent: proxyAgent,
  proxy: false,
  validateStatus: () => true,
  headers: {
    'User-Agent': config.userAgent,
    'Accept': 'application/json',
  },
});

let lastCallAt = 0;
let callCounter = 0;

// A non-2xx with an EMPTY body returned faster than a real Meta round-trip (~600ms+) is a
// proxy/egress refusal that never reached Meta — see the http_error branch. Because the request
// provably did NOT reach Meta, retrying is safe even for writes (no double-apply risk). Bounded.
const PROXY_REJECT_MAX_MS = 400;
const PROXY_REJECT_MAX_RETRIES = 2;

function appSecretProof(token) {
  return crypto.createHmac('sha256', config.appSecret).update(token).digest('hex');
}

function maxPct(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  return Math.max(0, ...['call_count', 'total_time', 'total_cputime'].map((k) => Number(obj[k] || 0)));
}

function bucMaxPct(buc) {
  if (!buc || typeof buc !== 'object') return { pct: 0, etr: 0 };
  let pct = 0;
  let etr = 0;
  for (const arr of Object.values(buc)) {
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (!e || typeof e !== 'object') continue;
      pct = Math.max(pct, ...['call_count', 'total_time', 'total_cputime'].map((k) => Number(e[k] || 0)));
      const t = Number(e.estimated_time_to_regain_access || 0);
      if (Number.isFinite(t) && t > etr) etr = t;
    }
  }
  return { pct, etr };
}

function parseJsonHeader(headers, name) {
  const raw = headers?.[name] || headers?.[name.toLowerCase()];
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function captureUsage(method, where, response) {
  const headers = response?.headers || {};
  const xAppUsage = parseJsonHeader(headers, 'x-app-usage');
  const xBuc = parseJsonHeader(headers, 'x-business-use-case-usage');
  const xAdAcct = parseJsonHeader(headers, 'x-ad-account-usage');
  const xInsightsThrottle = parseJsonHeader(headers, 'x-fb-ads-insights-throttle');

  const appMaxPct = maxPct(xAppUsage);
  const bucInfo = bucMaxPct(xBuc);
  const insightsAppPct = Number(xInsightsThrottle?.app_id_util_pct || 0);
  const insightsAccPct = Number(xInsightsThrottle?.acc_id_util_pct || 0);
  const tier = xInsightsThrottle?.ads_api_access_tier || null;

  const sample = {
    ts: new Date().toISOString(),
    where,
    method,
    httpStatus: response?.status ?? null,
    xAppUsage,
    xBusinessUseCaseUsage: xBuc,
    xAdAccountUsage: xAdAcct,
    xFbAdsInsightsThrottle: xInsightsThrottle,
    appMaxPct,
    bucMaxPct: bucInfo.pct,
    insightsAppPct,
    insightsAccPct,
    adsApiAccessTier: tier,
  };
  try {
    store.insertUsageSample(sample);
  } catch (err) {
    log.error('fb.usage.persist_failed', { error: String(err) });
  }
  return { sample, bucInfo, appMaxPct };
}

async function throttle(usageHint) {
  const gap = Date.now() - lastCallAt;
  const jitter = Math.floor(Math.random() * 200);
  const minGap = config.minGapMs + jitter;
  if (gap < minGap) {
    await new Promise((r) => setTimeout(r, minGap - gap));
  }
  if (usageHint?.appMaxPct >= 90 || usageHint?.bucMaxPct >= 90 || usageHint?.insightsMaxPct >= 90) {
    log.warn('fb.preemptive_backoff', { wait_s: 60, ...usageHint });
    await new Promise((r) => setTimeout(r, 60_000));
  } else if (usageHint?.appMaxPct >= 80 || usageHint?.bucMaxPct >= 80 || usageHint?.insightsMaxPct >= 80) {
    log.warn('fb.elevated_usage', { wait_s: 5, ...usageHint });
    await new Promise((r) => setTimeout(r, 5_000));
  }
  lastCallAt = Date.now();
}

let lastUsageHint = { appMaxPct: 0, bucMaxPct: 0, insightsMaxPct: 0 };

async function resolveToken(tokenKind) {
  if (tokenKind === 'page') {
    const r = await pageToken.get();
    if (!r.ok) return { ok: false, error: 'page_token_unavailable', detail: r };
    return { ok: true, token: r.token };
  }
  return { ok: true, token: config.systemToken };
}

async function rawRequest(method, relativePath, { params, data, endpointKey, safetyMethod, tokenKind = 'sysuser', _retryPageToken = false } = {}) {
  const ep = endpointKey || `${method}:${relativePath}`;
  const pre = safety.preflight(ep, safetyMethod || method);
  if (!pre.ok) {
    log.warn('fb.preflight.blocked', { endpoint: ep, error: pre.error, message: pre.message });
    return { ok: false, blocked: true, ...pre };
  }
  await throttle(lastUsageHint);
  safety.recordCall();
  callCounter += 1;

  const tokRes = await resolveToken(tokenKind);
  if (!tokRes.ok) {
    log.error('fb.token.unavailable', { endpoint: ep, tokenKind, detail: tokRes.detail });
    return { ok: false, error: tokRes.error, detail: tokRes.detail };
  }
  const token = tokRes.token;
  const ap = appSecretProof(token);

  const reqConfig = {
    method,
    url: relativePath.startsWith('/') ? relativePath : `/${relativePath}`,
  };
  if (method === 'GET' || method === 'DELETE') {
    reqConfig.params = { access_token: token, appsecret_proof: ap, ...(params || {}) };
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined || v === null) continue;
        reqConfig.params[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
  } else {
    const body = new URLSearchParams();
    body.append('access_token', token);
    body.append('appsecret_proof', ap);
    for (const [k, v] of Object.entries(data || {})) {
      if (v === undefined || v === null) continue;
      body.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    reqConfig.data = body.toString();
    reqConfig.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  }

  let response;
  let elapsedMs = 0;
  let attempt = 0;
  for (;;) {
    const t0 = Date.now();
    try {
      response = await http.request(reqConfig);
    } catch (err) {
      log.error('fb.transport_error', { endpoint: ep, error: String(err.message || err), attempt });
      safety.recordError(ep, { message: String(err.message || err) });
      return { ok: false, transportError: true, error: String(err.message || err) };
    }
    elapsedMs = Date.now() - t0;

    const st = response.status;
    const b = response.data;
    const emptyBody = b == null || (typeof b === 'string' && b.trim() === '');
    const metaEnvelope = b && typeof b === 'object' && b.error;
    const proxyReject = (st < 200 || st >= 300) && emptyBody && !metaEnvelope && elapsedMs < PROXY_REJECT_MAX_MS;
    if (proxyReject && attempt < PROXY_REJECT_MAX_RETRIES) {
      attempt += 1;
      const backoffMs = 300 * attempt + Math.floor(Math.random() * 150);
      log.warn('fb.proxy_retry', { endpoint: ep, status: st, elapsedMs, attempt, backoffMs });
      safety.recordCall();
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }
    if (attempt > 0 && st >= 200 && st < 300) {
      log.info('fb.proxy_retry.recovered', { endpoint: ep, attempt });
    }
    break;
  }

  const { sample, bucInfo, appMaxPct } = captureUsage(method, ep, response);
  lastUsageHint = {
    appMaxPct,
    bucMaxPct: bucInfo.pct,
    insightsMaxPct: Math.max(Number(sample.insightsAppPct || 0), Number(sample.insightsAccPct || 0)),
  };

  const body = response.data;
  const isError = body && typeof body === 'object' && body.error;
  if (isError) {
    const e = body.error;
    if (tokenKind === 'page' && Number(e.code) === 190 && !_retryPageToken) {
      pageToken.invalidate(`error_190_on_${ep}`);
      log.warn('fb.page_token.retry_after_invalidate', { endpoint: ep });
      return rawRequest(method, relativePath, {
        params, data, endpointKey, safetyMethod, tokenKind, _retryPageToken: true,
      });
    }
    safety.recordError(ep, {
      code: e.code,
      subcode: e.error_subcode,
      httpStatus: response.status,
      estimatedTimeToRegainAccess: bucInfo.etr,
      message: e.message,
    });
    log.error('fb.api_error', {
      endpoint: ep,
      http: response.status,
      code: e.code,
      subcode: e.error_subcode,
      message: (e.message || '').slice(0, 160),
      elapsedMs,
      tokenKind,
    });
    return { ok: false, apiError: true, error: e, httpStatus: response.status, body };
  }
  if (response.status < 200 || response.status >= 300) {
    let rawBody = '';
    if (typeof body === 'string') rawBody = body;
    else if (body != null) { try { rawBody = JSON.stringify(body); } catch { rawBody = String(body); } }
    const snippet = rawBody.slice(0, 300);
    // A non-2xx with an EMPTY body that returns FAST (sub-~100ms) is the signature of a rejection at
    // the PROXY / egress layer, NOT Meta: a real Graph call round-trips in ~600-5000ms through the
    // proxy, and Meta's own errors always return a JSON {error:{...}} envelope (handled above as
    // fb.api_error). An empty body + tiny elapsedMs = the proxy refused the request before it ever
    // reached Meta (transient egress-IP refusal / source not authorised), which is intermittent and
    // usually succeeds on retry. Capture the hop-identifying headers so we can tell proxy vs Meta.
    const hdrs = response.headers || {};
    const viaHdr = hdrs.via || hdrs.Via || null;
    const srvHdr = hdrs.server || hdrs.Server || null;
    const fastEmpty = !snippet && elapsedMs < 100;
    const message = snippet
      ? `Graph HTTP ${response.status}: ${snippet}`
      : fastEmpty
        ? `HTTP ${response.status} with an empty body in ${elapsedMs}ms — rejected at the PROXY/egress layer before reaching Meta (a real Graph call round-trips in ~600ms+ and Meta errors carry a JSON body). Likely a transient proxy/egress-IP refusal; usually succeeds on retry. Not a rate limit, permission, or account issue.`
        : `HTTP ${response.status} with an empty body in ${elapsedMs}ms (no Graph error envelope). Edge/proxy rejection rather than a Graph business error.`;
    safety.recordError(ep, { httpStatus: response.status, message: `HTTP ${response.status}` });
    log.error('fb.http_error', { endpoint: ep, status: response.status, elapsedMs, bodySnippet: snippet || '(empty)', via: viaHdr, server: srvHdr });
    return { ok: false, httpStatus: response.status, status: response.status, body, error: { httpStatus: response.status, message }, message };
  }

  safety.recordSuccess(ep);
  log.info('fb.api', {
    endpoint: ep,
    method,
    http: response.status,
    elapsedMs,
    callNo: callCounter,
    appPct: appMaxPct.toFixed(1),
    bucPct: bucInfo.pct.toFixed(1),
    insightsPct: Math.max(sample.insightsAppPct || 0, sample.insightsAccPct || 0).toFixed(1),
    tier: sample.adsApiAccessTier,
  });
  return { ok: true, body, httpStatus: response.status, sample, elapsedMs };
}

export const fb = {
  async get(path, params, endpointKey, opts = {}) {
    return rawRequest('GET', path, { params, endpointKey, tokenKind: opts.tokenKind });
  },

  async moderate(method, path, data, endpointKey) {
    return rawRequest(method, path, { data, endpointKey, safetyMethod: 'MODERATE', tokenKind: 'page' });
  },

  async manage(method, path, data, endpointKey) {
    return rawRequest(method, path, { data, endpointKey, safetyMethod: 'MANAGE', tokenKind: 'sysuser' });
  },

  async batch(ops, endpointKey = 'POST:/batch', opts = {}) {
    if (!ops || ops.length === 0) return { ok: true, body: [], parsed: {} };
    if (ops.length > 50) {
      const a = await this.batch(ops.slice(0, 50), endpointKey, opts);
      const b = await this.batch(ops.slice(50), endpointKey, opts);
      if (!a.ok) return a;
      if (!b.ok) return b;
      return { ok: true, body: [...(a.body || []), ...(b.body || [])], parsed: { ...(a.parsed || {}), ...(b.parsed || {}) } };
    }
    const payload = {
      include_headers: 'true',
      batch: ops.map((o) => ({ method: o.method, relative_url: o.relative_url.replace(/^\/+/, ''), name: o.name })),
    };
    const subMethods = new Set(ops.map((o) => (o.method || 'GET').toUpperCase()));
    const allReads = subMethods.size === 1 && subMethods.has('GET');
    log.info('fb.batch.start', { count: ops.length, names: ops.map((o) => o.name), allReads, tokenKind: opts.tokenKind || 'sysuser' });
    const t0 = Date.now();
    const res = await rawRequest('POST', '/', {
      data: payload,
      endpointKey,
      safetyMethod: allReads ? 'POST_BATCH' : 'POST',
      tokenKind: opts.tokenKind,
    });
    const elapsedMs = Date.now() - t0;
    if (!res.ok) {
      log.error('fb.batch.outer_error', { elapsedMs });
      return res;
    }
    const items = Array.isArray(res.body) ? res.body : [];
    const parsed = {};
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < ops.length; i += 1) {
      const o = ops[i];
      const item = items[i];
      if (!item) {
        parsed[o.name] = { ok: false, missing: true };
        fail += 1;
        continue;
      }
      const code = Number(item.code || 0);
      let body;
      try {
        body = typeof item.body === 'string' ? JSON.parse(item.body) : item.body;
      } catch {
        body = { _raw: typeof item.body === 'string' ? item.body.slice(0, 300) : null };
      }
      if (Array.isArray(item.headers) && item.headers.length) {
        const headersObj = {};
        for (const h of item.headers) {
          if (h?.name) headersObj[h.name.toLowerCase()] = h.value;
        }
        try {
          captureUsage('GET', `batch.sub:${o.name}`, { status: code, headers: headersObj });
        } catch (err) {
          log.warn('fb.batch.subheader_capture_failed', { name: o.name, error: String(err) });
        }
      }
      const isOk = code >= 200 && code < 300 && body && !body.error;
      parsed[o.name] = { ok: isOk, code, body };
      if (isOk) ok += 1;
      else fail += 1;
    }
    log.info('fb.batch.done', { count: ops.length, ok, fail, elapsedMs });
    return { ok: true, parsed, body: items, elapsedMs };
  },

  async getAll(path, params, endpointKey, maxPages = 20, opts = {}) {
    const items = [];
    let res = await this.get(path, params, endpointKey, opts);
    if (!res.ok) return res;
    for (let i = 0; i < maxPages; i += 1) {
      if (!res.ok || !res.body) break;
      const data = res.body.data;
      if (Array.isArray(data)) items.push(...data);
      const next = res.body?.paging?.next;
      if (!next) break;
      const u = new URL(next);
      const nextParams = Object.fromEntries(u.searchParams.entries());
      res = await this.get(`${u.pathname.replace(/^\/+(v[0-9.]+\/)?/, '/')}`.replace(/^\//, ''), nextParams, endpointKey, opts);
    }
    return { ok: true, body: { data: items } };
  },

  meta() {
    return {
      proxy: `${config.proxyHost}:${config.proxyPort}`,
      version: config.graphVersion,
      tokenMasked: maskToken(config.systemToken),
      readonly: config.readonly,
      primaryAccountId: config.primaryAccountId,
      timezone: config.primaryAccountTz,
    };
  },
};
