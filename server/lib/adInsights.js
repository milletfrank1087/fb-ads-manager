// Read-only campaign insights for the GFM campaign app's profit cockpit (campaign/lib/ads-manager.js).
// It polls GET /api/dashboard and POST /api/refresh; the response shape below is its contract.
// Results live in memory: one Graph batch call per refresh covers every allowed ad account.
//
// Every preset is a window of Europe/Athens calendar days ending today, matching the cockpit's
// payment ranges. Meta's own date_preset would not: its last_7d excludes today, and it follows each
// ad account's timezone. Accounts whose day boundaries differ from Athens are fetched per hour and
// re-bucketed into Athens days.
import { fb } from './fbClient.js';
import { config } from './env.js';
import { log } from './logger.js';

export const REPORT_TZ = 'Europe/Athens';
export const VALID_DATE_PRESETS = new Set([
  'today', 'yesterday', 'last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d', 'this_month', 'last_month',
]);

// Minimum age before a background refresh hits Meta again; manual { force: true } bypasses this.
const REUSE_MS = { today: 60_000, yesterday: 10 * 60_000, last_7d: 15 * 60_000, last_90d: 60 * 60_000 };
const DEFAULT_REUSE_MS = 15 * 60_000;

const CAMPAIGN_FIELDS = 'id,name,account_id,status,effective_status,objective,start_time,stop_time,created_time,updated_time,adsets.limit(3){promoted_object},ads.limit(5){creative{object_story_spec,asset_feed_spec}}';
const INSIGHTS_FIELDS = 'campaign_id,spend,reach,impressions,cpm,inline_link_clicks,cost_per_inline_link_click,actions,action_values,cost_per_action_type,purchase_roas';
const HOURLY_FIELDS = 'campaign_id,spend,impressions,inline_link_clicks,actions,action_values';
const HOURLY_BREAKDOWN = 'hourly_stats_aggregated_by_advertiser_time_zone';
const MAX_CAMPAIGN_PAGES = 5;
const MAX_INSIGHT_PAGES = 20;

function extractCampaignMeta(camp) {
  const pixelId = (camp.adsets?.data || [])
    .map((a) => a?.promoted_object?.pixel_id)
    .find(Boolean) || null;
  let destinationUrl = null;
  for (const ad of camp.ads?.data || []) {
    const spec = ad?.creative?.object_story_spec || {};
    const af = ad?.creative?.asset_feed_spec || {};
    const link =
      spec.video_data?.call_to_action?.value?.link ||
      spec.link_data?.link ||
      af.link_urls?.[0]?.website_url ||
      null;
    if (link) {
      destinationUrl = link;
      break;
    }
  }
  let destinationHost = null;
  let linkUtmCampaign = null;
  if (destinationUrl) {
    try {
      const u = new URL(destinationUrl);
      destinationHost = u.hostname.toLowerCase();
      const uc = u.searchParams.get('utm_campaign');
      if (uc && !uc.includes('{{')) linkUtmCampaign = uc.trim();
    } catch {
      // ignore malformed URL
    }
  }
  const { adsets, ads, ...rest } = camp;
  return {
    ...rest,
    pixel_id: pixelId ? String(pixelId) : null,
    destination_url: destinationUrl,
    destination_host: destinationHost,
    link_utm_campaign: linkUtmCampaign,
  };
}

const cache = new Map(); // `${accountId}|${preset}` -> { rows, campaigns, fetchedAt, range }
const inFlight = new Map(); // preset -> Promise
const accountTz = new Map(); // act_x -> timezone_name, learned from each batch

export const isAllowedAccount = (id) => config.adAccountIds.includes(id);
export const primaryAccountId = () => config.adAccountIds[0] || null;

// ---------- Athens calendar ----------

const DAY_MS = 86_400_000;
const dateInTz = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// Offset of `tz` from UTC in minutes at instant `ms` (+180 for Athens in summer).
function offsetMinutes(tz, ms) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}

export function athensWindow(preset, now = Date.now()) {
  const today = dateInTz(now, REPORT_TZ);
  const back = { today: 0, last_7d: 6, last_14d: 13, last_28d: 27, last_30d: 29, last_90d: 89 };
  if (preset in back) return { since: addDays(today, -back[preset]), until: today };
  if (preset === 'yesterday') return { since: addDays(today, -1), until: addDays(today, -1) };
  if (preset === 'this_month') return { since: `${today.slice(0, 8)}01`, until: today };
  if (preset === 'last_month') {
    const lastPrev = addDays(`${today.slice(0, 8)}01`, -1);
    return { since: `${lastPrev.slice(0, 8)}01`, until: lastPrev };
  }
  return null;
}

// True when the account's day boundaries equal Athens' across the window (e.g. Europe/Kyiv).
function sameDaysAsAthens(tz, win, now = Date.now()) {
  if (!tz) return false;
  return [Date.parse(`${win.since}T12:00:00Z`), Date.parse(`${win.until}T12:00:00Z`), now]
    .every((ms) => offsetMinutes(tz, ms) === offsetMinutes(REPORT_TZ, ms));
}

// Athens date of an hourly row: date_start + "23:00:00 - 23:59:59" are in the account's timezone.
function athensDateOfHour(row, tz) {
  const hour = Number(String(row[HOURLY_BREAKDOWN] || '0').slice(0, 2));
  const localAsUtc = Date.parse(`${row.date_start}T00:00:00Z`) + hour * 3_600_000;
  return dateInTz(localAsUtc - offsetMinutes(tz, localAsUtc) * 60_000, REPORT_TZ);
}

// ---------- normalisation ----------

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
    cost_per_purchase: firstAction(r.cost_per_action_type, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'])
      ?? (purchases > 0 ? spend / purchases : null),
    insights_fetched_at: fetchedAt,
  };
}

// Sums hourly rows per campaign into one row shaped like a plain insights row.
function sumHourlyRows(rows, tz, win) {
  const acc = new Map();
  for (const r of rows) {
    const day = tz ? athensDateOfHour(r, tz) : r.date_start;
    if (day < win.since || day > win.until) continue;
    const id = String(r.campaign_id);
    const a = acc.get(id) || { campaign_id: id, spend: 0, impressions: 0, inline_link_clicks: 0, actions: [], action_values: [] };
    a.spend += Number(r.spend) || 0;
    a.impressions += Number(r.impressions) || 0;
    a.inline_link_clicks += Number(r.inline_link_clicks) || 0;
    for (const key of ['actions', 'action_values']) {
      for (const x of r[key] || []) {
        const hit = a[key].find((y) => y.action_type === x.action_type);
        if (hit) hit.value = String(Number(hit.value) + Number(x.value || 0));
        else a[key].push({ action_type: x.action_type, value: String(x.value) });
      }
    }
    acc.set(id, a);
  }
  return [...acc.values()].map((a) => ({
    ...a,
    cpm: a.impressions > 0 ? (a.spend / a.impressions) * 1000 : null,
    cost_per_inline_link_click: a.inline_link_clicks > 0 ? a.spend / a.inline_link_clicks : null,
    reach: null, // reach does not add up across hours
  }));
}

// ---------- Graph requests ----------

// Plain totals when the account's days match Athens; otherwise hourly rows over a range padded by
// a day on each side (clamped to the account's today) so re-bucketing sees every edge hour.
function insightsRequest(acct, win) {
  const tz = accountTz.get(acct);
  const hourly = !sameDaysAsAthens(tz, win);
  const accountToday = tz ? dateInTz(Date.now(), tz) : win.until;
  const since = hourly ? addDays(win.since, -1) : win.since;
  const wanted = hourly ? addDays(win.until, 1) : win.until;
  const until = wanted > accountToday ? accountToday : wanted;
  const params = {
    level: 'campaign',
    time_range: JSON.stringify({ since, until }),
    fields: hourly ? HOURLY_FIELDS : INSIGHTS_FIELDS,
    limit: 500,
    // time_increment=1 keeps one row per day+hour; without it Meta merges each hour-of-day across the range.
    ...(hourly ? { breakdowns: HOURLY_BREAKDOWN, time_increment: 1 } : {}),
  };
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return { hourly, tz, path: `/${acct}/insights`, params, relative: `${acct}/insights?${qs}` };
}

async function remainingPages(path, params, after, endpoint, max) {
  const out = [];
  for (let page = 1; after && page < max; page += 1) {
    const r = await fb.get(path, { ...params, after }, endpoint, { budget: 'ads' });
    if (!r.ok) { log.warn('ads.insights.page_failed', { path }); break; }
    out.push(...(r.body?.data || []));
    after = r.body?.paging?.next ? r.body.paging.cursors?.after : null;
  }
  return out;
}

async function fetchPreset(preset) {
  const accounts = config.adAccountIds;
  const win = athensWindow(preset);
  const reqs = accounts.map((acct) => insightsRequest(acct, win));
  const ops = accounts.flatMap((acct, i) => [
    { name: `a${i}`, method: 'GET', relative_url: `${acct}?fields=timezone_name` },
    { name: `c${i}`, method: 'GET', relative_url: `${acct}/campaigns?fields=${encodeURIComponent(CAMPAIGN_FIELDS)}&limit=200` },
    { name: `i${i}`, method: 'GET', relative_url: reqs[i].relative },
  ]);
  const t0 = Date.now();
  const res = await fb.batch(ops, 'POST:/ads-insights/batch', { budget: 'ads' });
  if (!res.ok) return { ok: false, error: typeof res.error === 'string' ? res.error : 'graph_error', message: res.message };

  const fetchedAt = new Date().toISOString();
  const failed = [];
  for (const [i, acct] of accounts.entries()) {
    const tzName = res.parsed[`a${i}`]?.body?.timezone_name || null;
    if (tzName) accountTz.set(acct, tzName);
    const c = res.parsed[`c${i}`];
    const ins = res.parsed[`i${i}`];
    if (!c?.ok || !ins?.ok) {
      failed.push({ account: acct, message: (c?.body || ins?.body)?.error?.message || 'sub-request failed' });
      continue; // keep this account's previous cache entry
    }
    let campaigns = c.body?.data || [];
    if (c.body?.paging?.next) {
      campaigns = campaigns.concat(await remainingPages(`/${acct}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: 200 }, c.body.paging.cursors?.after, 'GET:/ads-insights/campaigns', MAX_CAMPAIGN_PAGES));
    }
    campaigns = campaigns.map((camp) => ({ ...extractCampaignMeta(camp), account_id: acct })); // Graph omits the act_ prefix; the campaign app stores it

    let insightRows = ins.body?.data || [];
    if (ins.body?.paging?.next) {
      insightRows = insightRows.concat(await remainingPages(reqs[i].path, reqs[i].params, ins.body.paging.cursors?.after, 'GET:/ads-insights/insights', MAX_INSIGHT_PAGES));
    }
    if (reqs[i].hourly) insightRows = sumHourlyRows(insightRows, tzName || reqs[i].tz, win);

    const byCampaign = new Map(insightRows.map((r) => [String(r.campaign_id), normalizeInsight(r, fetchedAt)]));
    const rows = campaigns
      .map((camp) => ({ ...camp, campaign_id: camp.id, ...(byCampaign.get(String(camp.id)) || { spend: null, insights_fetched_at: null }) }))
      .sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1));
    cache.set(`${acct}|${preset}`, { rows, campaigns, fetchedAt, range: win });
  }
  if (failed.length) log.warn('ads.insights.partial', { preset, failed });
  log.info('ads.insights.refreshed', {
    preset, since: win.since, until: win.until, hourlyAccounts: reqs.filter((r) => r.hourly).length,
    accounts: accounts.length - failed.length, elapsedMs: Date.now() - t0,
  });
  return failed.length === accounts.length
    ? { ok: false, error: 'all_accounts_failed', failed }
    : { ok: true, fetchedAt, range: win, failed };
}

// A cache entry only counts while its Athens window is still the current one (days roll over).
function currentEntry(acct, preset, win) {
  const hit = cache.get(`${acct}|${preset}`);
  return hit && hit.range?.since === win.since && hit.range?.until === win.until ? hit : null;
}

// Refreshes every allowed account for a preset, unless the last fetch is younger than the reuse window.
export async function refresh(preset, { force = false } = {}) {
  const win = athensWindow(preset);
  const newest = Math.max(0, ...config.adAccountIds.map((a) => Date.parse(currentEntry(a, preset, win)?.fetchedAt || 0)));
  if (!force && Date.now() - newest < (REUSE_MS[preset] ?? DEFAULT_REUSE_MS)) return { ok: true, cached: true, fetchedAt: new Date(newest).toISOString() };
  if (!inFlight.has(preset)) {
    inFlight.set(preset, fetchPreset(preset).finally(() => inFlight.delete(preset)));
  }
  return inFlight.get(preset);
}

// Cached payload for one account; fetches first if nothing current is cached.
export async function dashboard(accountId, preset) {
  const win = athensWindow(preset);
  let hit = currentEntry(accountId, preset, win);
  if (!hit) {
    const r = await refresh(preset);
    hit = currentEntry(accountId, preset, win);
    if (!hit) return { ok: false, error: r.error || 'no_data', message: r.message, failed: r.failed };
  }
  return {
    ok: true,
    datePreset: preset,
    level: 'campaign',
    accountId,
    account: { id: accountId },
    range: { since: hit.range.since, until: hit.range.until, timezone: REPORT_TZ },
    rows: hit.rows,
    campaigns: hit.campaigns,
    lastInsightsFetchedAt: hit.fetchedAt,
  };
}
