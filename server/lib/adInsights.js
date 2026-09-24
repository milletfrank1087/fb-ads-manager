// Read-only campaign insights for the GFM campaign app's profit cockpit (campaign/lib/ads-manager.js).
// It polls GET /api/dashboard and POST /api/refresh; the response shape below is its contract.
// Results live in memory: one Graph batch call per refresh covers every allowed ad account.
import { fb } from './fbClient.js';
import { config } from './env.js';
import { log } from './logger.js';

export const VALID_DATE_PRESETS = new Set([
  'today', 'yesterday', 'this_week_mon_today', 'last_7d', 'last_14d', 'last_28d', 'last_30d',
  'last_90d', 'this_month', 'last_month', 'maximum',
]);

// Minimum age before a refresh hits Meta again; within it the cached result is reused.
const REUSE_MS = { today: 5 * 60_000, yesterday: 20 * 60_000, last_7d: 30 * 60_000 };
const DEFAULT_REUSE_MS = 60 * 60_000;

const CAMPAIGN_FIELDS = 'id,name,account_id,status,effective_status,objective,start_time,stop_time,created_time,updated_time';
const INSIGHTS_FIELDS = 'campaign_id,spend,reach,impressions,cpm,inline_link_clicks,cost_per_inline_link_click,actions,action_values,cost_per_action_type,purchase_roas';
const MAX_CAMPAIGN_PAGES = 5;

const cache = new Map(); // `${accountId}|${preset}` -> { rows, campaigns, fetchedAt }
const inFlight = new Map(); // preset -> Promise

export const isAllowedAccount = (id) => config.adAccountIds.includes(id);
export const primaryAccountId = () => config.adAccountIds[0] || null;

const num = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};

function sumActions(arr, types) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((t, a) => (types.includes(a?.action_type) && Number.isFinite(Number(a.value)) ? t + Number(a.value) : t), 0);
}

function firstAction(arr, types) {
  if (!Array.isArray(arr)) return null;
  for (const type of types) {
    const hit = arr.find((a) => a?.action_type === type);
    if (hit) return num(hit.value);
  }
  return null;
}

function normalizeInsight(r, fetchedAt) {
  const spend = num(r.spend) ?? 0;
  const purchases = sumActions(r.actions, ['omni_purchase']);
  const purchaseValue = sumActions(r.action_values, ['omni_purchase']);
  return {
    spend,
    reach: num(r.reach),
    impressions: num(r.impressions),
    cpm: num(r.cpm),
    inline_link_clicks: num(r.inline_link_clicks),
    cost_per_inline_link_click: num(r.cost_per_inline_link_click),
    link_clicks: sumActions(r.actions, ['link_click']),
    purchases_total: purchases,
    purchase_value_total: purchaseValue,
    purchase_roas_total: firstAction(r.purchase_roas, ['omni_purchase']) ?? (spend > 0 ? purchaseValue / spend : null),
    cost_per_purchase: firstAction(r.cost_per_action_type, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']),
    insights_fetched_at: fetchedAt,
  };
}

async function remainingCampaignPages(acct, after) {
  const out = [];
  for (let page = 1; after && page < MAX_CAMPAIGN_PAGES; page += 1) {
    const r = await fb.get(`/${acct}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: 200, after }, 'GET:/ads-insights/campaigns', { budget: 'ads' });
    if (!r.ok) break;
    out.push(...(r.body?.data || []));
    after = r.body?.paging?.next ? r.body.paging.cursors?.after : null;
  }
  return out;
}

async function fetchPreset(preset) {
  const accounts = config.adAccountIds;
  const ops = accounts.flatMap((acct, i) => [
    { name: `c${i}`, method: 'GET', relative_url: `${acct}/campaigns?fields=${encodeURIComponent(CAMPAIGN_FIELDS)}&limit=200` },
    { name: `i${i}`, method: 'GET', relative_url: `${acct}/insights?level=campaign&date_preset=${preset}&fields=${encodeURIComponent(INSIGHTS_FIELDS)}&limit=500` },
  ]);
  const t0 = Date.now();
  const res = await fb.batch(ops, 'POST:/ads-insights/batch', { budget: 'ads' });
  if (!res.ok) return { ok: false, error: typeof res.error === 'string' ? res.error : 'graph_error', message: res.message };

  const fetchedAt = new Date().toISOString();
  const failed = [];
  for (const [i, acct] of accounts.entries()) {
    const c = res.parsed[`c${i}`];
    const ins = res.parsed[`i${i}`];
    if (!c?.ok || !ins?.ok) {
      failed.push({ account: acct, message: (c?.body || ins?.body)?.error?.message || 'sub-request failed' });
      continue; // keep this account's previous cache entry
    }
    let campaigns = c.body?.data || [];
    if (c.body?.paging?.next) campaigns = campaigns.concat(await remainingCampaignPages(acct, c.body.paging.cursors?.after));
    campaigns = campaigns.map((camp) => ({ ...camp, account_id: acct })); // Graph omits the act_ prefix; the campaign app stores it
    if (ins.body?.paging?.next) log.warn('ads.insights.truncated', { account: acct, preset });

    const byCampaign = new Map((ins.body?.data || []).map((r) => [String(r.campaign_id), normalizeInsight(r, fetchedAt)]));
    const rows = campaigns
      .map((camp) => ({ ...camp, campaign_id: camp.id, ...(byCampaign.get(String(camp.id)) || { spend: null, insights_fetched_at: null }) }))
      .sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1));
    cache.set(`${acct}|${preset}`, { rows, campaigns, fetchedAt });
  }
  if (failed.length) log.warn('ads.insights.partial', { preset, failed });
  log.info('ads.insights.refreshed', { preset, accounts: accounts.length - failed.length, elapsedMs: Date.now() - t0 });
  return failed.length === accounts.length
    ? { ok: false, error: 'all_accounts_failed', failed }
    : { ok: true, fetchedAt, failed };
}

// Refreshes every allowed account for a preset, unless the last fetch is younger than the reuse window.
export async function refresh(preset) {
  const newest = Math.max(0, ...config.adAccountIds.map((a) => Date.parse(cache.get(`${a}|${preset}`)?.fetchedAt || 0)));
  if (Date.now() - newest < (REUSE_MS[preset] ?? DEFAULT_REUSE_MS)) return { ok: true, cached: true, fetchedAt: new Date(newest).toISOString() };
  if (!inFlight.has(preset)) {
    inFlight.set(preset, fetchPreset(preset).finally(() => inFlight.delete(preset)));
  }
  return inFlight.get(preset);
}

// Cached payload for one account; fetches first if nothing is cached yet.
export async function dashboard(accountId, preset) {
  let hit = cache.get(`${accountId}|${preset}`);
  if (!hit) {
    const r = await refresh(preset);
    hit = cache.get(`${accountId}|${preset}`);
    if (!hit) return { ok: false, error: r.error || 'no_data', message: r.message, failed: r.failed };
  }
  return {
    ok: true,
    datePreset: preset,
    level: 'campaign',
    accountId,
    account: { id: accountId },
    rows: hit.rows,
    campaigns: hit.campaigns,
    lastInsightsFetchedAt: hit.fetchedAt,
  };
}
