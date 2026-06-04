import { fb } from './fbClient.js';
import { store } from './store.js';
import { safety } from './safety.js';
import { config } from './env.js';
import { log } from './logger.js';

const VALID_LEVELS = new Set(['campaign', 'adset', 'ad']);
const VALID_STATUSES = new Set(['ACTIVE', 'PAUSED']);
const BUDGET_LEVELS = new Set(['campaign', 'adset']);

function errorMessageOf(result) {
  if (result?.error?.message) return result.error.message;
  if (result?.message) return result.message;
  if (typeof result?.error === 'string') return result.error;
  return 'unknown_error';
}

export async function setStatus({ level, id, status }) {
  if (!VALID_LEVELS.has(level)) return { ok: false, error: 'invalid_level', message: `Unknown level "${level}".` };
  const next = (status || '').toString().toUpperCase();
  if (!VALID_STATUSES.has(next)) return { ok: false, error: 'invalid_status', message: 'Status must be ACTIVE or PAUSED.' };
  if (!id) return { ok: false, error: 'missing_id', message: 'Entity id is required.' };

  const before = store.getEntity(level, id);
  const beforeStatus = before?.status ?? null;
  log.info('ad.status.attempt', { level, id, from: beforeStatus, to: next, name: before?.name });

  const result = await fb.manage('POST', `/${id}`, { status: next }, `POST:/${level}/status`);

  if (!result.ok) {
    store.logAdAction({
      action: 'status', level, entity_id: id, entity_name: before?.name ?? null,
      before_value: beforeStatus, after_value: next,
      payload_json: { status: next }, response_json: result.error || result,
      success: 0, error_message: errorMessageOf(result),
    });
    log.warn('ad.status.failed', { level, id, error: errorMessageOf(result), blocked: !!result.blocked });
    return { ok: false, ...result, message: errorMessageOf(result) };
  }

  store.setEntityStatus(level, id, next);
  store.logAdAction({
    action: 'status', level, entity_id: id, entity_name: before?.name ?? null,
    before_value: beforeStatus, after_value: next,
    payload_json: { status: next }, response_json: result.body,
    success: 1, error_message: null,
  });
  log.info('ad.status.ok', { level, id, from: beforeStatus, to: next });
  return { ok: true, level, id, status: next, previousStatus: beforeStatus };
}

export async function rename({ level, id, name }) {
  if (!VALID_LEVELS.has(level)) return { ok: false, error: 'invalid_level', message: `Unknown level "${level}".` };
  if (!id) return { ok: false, error: 'missing_id', message: 'Entity id is required.' };
  const next = (name ?? '').toString().trim();
  if (!next) return { ok: false, error: 'empty_name', message: 'Name cannot be empty.' };
  if (next.length > 400) return { ok: false, error: 'name_too_long', message: 'Name must be 400 characters or fewer.' };

  const before = store.getEntity(level, id);
  const beforeName = before?.name ?? null;
  if (beforeName === next) return { ok: true, level, id, name: next, previousName: beforeName, unchanged: true };
  log.info('ad.rename.attempt', { level, id, from: beforeName, to: next });

  const result = await fb.manage('POST', `/${id}`, { name: next }, `POST:/${level}/rename`);

  if (!result.ok) {
    store.logAdAction({
      action: 'rename', level, entity_id: id, entity_name: beforeName,
      before_value: beforeName, after_value: next,
      payload_json: { name: next }, response_json: result.error || result,
      success: 0, error_message: errorMessageOf(result),
    });
    log.warn('ad.rename.failed', { level, id, error: errorMessageOf(result), blocked: !!result.blocked });
    return { ok: false, ...result, message: errorMessageOf(result) };
  }

  store.setEntityName(level, id, next);
  store.logAdAction({
    action: 'rename', level, entity_id: id, entity_name: next,
    before_value: beforeName, after_value: next,
    payload_json: { name: next }, response_json: result.body,
    success: 1, error_message: null,
  });
  log.info('ad.rename.ok', { level, id, from: beforeName, to: next });
  return { ok: true, level, id, name: next, previousName: beforeName };
}

export async function setBudget({ level, id, dailyBudget, lifetimeBudget }) {
  if (!BUDGET_LEVELS.has(level)) return { ok: false, error: 'invalid_level', message: 'Budgets can only be set on campaigns or ad sets.' };
  if (!id) return { ok: false, error: 'missing_id', message: 'Entity id is required.' };

  const data = {};
  let kind = null;
  let afterValue = null;
  if (dailyBudget !== undefined && dailyBudget !== null && dailyBudget !== '') {
    const cents = Math.round(Number(dailyBudget));
    if (!Number.isFinite(cents) || cents <= 0) return { ok: false, error: 'invalid_budget', message: 'Daily budget must be a positive number (minor units).' };
    data.daily_budget = cents;
    kind = 'daily_budget';
    afterValue = String(cents);
  } else if (lifetimeBudget !== undefined && lifetimeBudget !== null && lifetimeBudget !== '') {
    const cents = Math.round(Number(lifetimeBudget));
    if (!Number.isFinite(cents) || cents <= 0) return { ok: false, error: 'invalid_budget', message: 'Lifetime budget must be a positive number (minor units).' };
    data.lifetime_budget = cents;
    kind = 'lifetime_budget';
    afterValue = String(cents);
  } else {
    return { ok: false, error: 'no_budget', message: 'Provide daily_budget or lifetime_budget (minor units).' };
  }

  // Anti-suspension guard: Meta caps budget edits at ~4/hour per ad set; exceeding it can
  // trigger a 1-hour lockout AND flag the account. Refuse locally before we ever hit Meta.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const recentBudgetEdits = store.countRecentAdActions('budget', id, oneHourAgo);
  if (recentBudgetEdits >= 4) {
    log.warn('ad.budget.rate_guard', { level, id, recentBudgetEdits });
    return {
      ok: false, error: 'budget_rate_limit',
      message: `Meta limits budget changes to ~4 per hour per entity (already ${recentBudgetEdits} in the last hour). Wait before changing this budget again to avoid an account flag.`,
    };
  }

  const before = store.getEntity(level, id);

  // ABO/CBO guard: a campaign only accepts a budget when it's CBO (Advantage+ campaign budget).
  // ABO campaigns hold the budget on each ad set, so POSTing a campaign budget returns Meta's
  // opaque "(#100) Invalid parameter". Detect it locally (no campaign-level budget on record) and
  // return an actionable message instead of bouncing off Meta.
  if (level === 'campaign') {
    const hasCampaignBudget = (before?.daily_budget != null && Number(before.daily_budget) > 0)
      || (before?.lifetime_budget != null && Number(before.lifetime_budget) > 0);
    if (!hasCampaignBudget) {
      log.warn('ad.budget.abo_campaign', { id, name: before?.name });
      return {
        ok: false, error: 'abo_campaign',
        message: 'This is an ABO campaign — its budget lives on the ad sets, not the campaign. Open the campaign\u2019s ad sets and edit each ad set\u2019s budget instead. (Campaign-level budgets only apply to CBO / Advantage+ campaigns.)',
      };
    }
  }

  const beforeValue = kind === 'daily_budget' ? (before?.daily_budget ?? null) : (before?.lifetime_budget ?? null);
  log.info('ad.budget.attempt', { level, id, kind, from: beforeValue, to: afterValue, name: before?.name });

  const result = await fb.manage('POST', `/${id}`, data, `POST:/${level}/budget`);

  if (!result.ok) {
    store.logAdAction({
      action: 'budget', level, entity_id: id, entity_name: before?.name ?? null,
      before_value: beforeValue != null ? String(beforeValue) : null, after_value: afterValue,
      payload_json: data, response_json: result.error || result,
      success: 0, error_message: errorMessageOf(result),
    });
    log.warn('ad.budget.failed', { level, id, error: errorMessageOf(result), blocked: !!result.blocked });
    return { ok: false, ...result, message: errorMessageOf(result) };
  }

  store.setEntityBudget(level, id, { [kind]: Number(afterValue) });
  store.logAdAction({
    action: 'budget', level, entity_id: id, entity_name: before?.name ?? null,
    before_value: beforeValue != null ? String(beforeValue) : null, after_value: afterValue,
    payload_json: data, response_json: result.body,
    success: 1, error_message: null,
  });
  log.info('ad.budget.ok', { level, id, kind, from: beforeValue, to: afterValue });
  return { ok: true, level, id, kind, value: Number(afterValue), previousValue: beforeValue };
}

// Min-ROAS is intentionally excluded: per Meta docs it is a one-way switch (you can't move an ad set
// off LOWEST_COST_WITH_MIN_ROAS to another strategy), so we never let the advisor strand an entity on it.
const VALID_BID_STRATEGIES = new Set(['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_BID_CAP']);

// Set the bid strategy (cost control) on a campaign or ad set. For this all-ABO account the cap lives
// on the AD SET (POST /{adset_id} {bid_strategy, bid_amount}); on a CBO campaign it lives on the
// campaign. bid_amount is in MINOR UNITS (cents). CRITICAL: changing bid strategy is a SIGNIFICANT
// EDIT that resets the learning phase on a live entity — callers must steer this onto a fresh PAUSED
// copy (the two-governor method), never a working winner. Verified against Meta Marketing API docs +
// Business Help Center (2026): bid-strategy change = guaranteed learning reset.
export async function setBidStrategy({ level, id, strategy, bidAmount }) {
  if (level !== 'campaign' && level !== 'adset') return { ok: false, error: 'invalid_level', message: 'Bid strategy can only be set on a campaign or ad set.' };
  if (!id) return { ok: false, error: 'missing_id', message: 'Entity id is required.' };
  const strat = (strategy || '').toString().toUpperCase();
  if (!VALID_BID_STRATEGIES.has(strat)) {
    return { ok: false, error: 'invalid_strategy', message: `strategy must be one of ${[...VALID_BID_STRATEGIES].join(', ')}.` };
  }
  const needsCap = strat === 'COST_CAP' || strat === 'LOWEST_COST_WITH_BID_CAP';
  const data = { bid_strategy: strat };
  let capCents = null;
  if (needsCap) {
    capCents = Math.round(Number(bidAmount));
    if (!Number.isFinite(capCents) || capCents <= 0) return { ok: false, error: 'invalid_bid_amount', message: `${strat} requires a positive bid_amount in minor units (e.g. 1500 = $15).` };
    data.bid_amount = capCents;
  }

  // Anti-suspension guard: constant bid edits flag the account, same as budgets. Cap at ~4/hour/entity.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const recentBidEdits = store.countRecentAdActions('bid', id, oneHourAgo);
  if (recentBidEdits >= 4) {
    log.warn('ad.bid.rate_guard', { level, id, recentBidEdits });
    return { ok: false, error: 'bid_rate_limit', message: `Already ${recentBidEdits} bid changes on this entity in the last hour — wait before changing again (constant bid edits flag the account).` };
  }

  const before = store.getEntity(level, id);
  const afterLabel = needsCap ? `${strat}@${capCents}` : strat;
  log.info('ad.bid.attempt', { level, id, strategy: strat, bidAmount: capCents, name: before?.name });

  const result = await fb.manage('POST', `/${id}`, data, `POST:/${level}/bid`);

  if (!result.ok) {
    store.logAdAction({
      action: 'bid', level, entity_id: id, entity_name: before?.name ?? null,
      before_value: null, after_value: afterLabel,
      payload_json: data, response_json: result.error || result,
      success: 0, error_message: errorMessageOf(result),
    });
    log.warn('ad.bid.failed', { level, id, error: errorMessageOf(result), blocked: !!result.blocked });
    return { ok: false, ...result, message: errorMessageOf(result) };
  }

  store.logAdAction({
    action: 'bid', level, entity_id: id, entity_name: before?.name ?? null,
    before_value: null, after_value: afterLabel,
    payload_json: data, response_json: result.body, success: 1, error_message: null,
  });
  log.info('ad.bid.ok', { level, id, strategy: strat, bidAmount: capCents });
  return { ok: true, level, id, strategy: strat, bidAmount: capCents };
}

// ---------- READ: account write-capability diagnostic ----------

// Meta numeric enums (account_status / disable_reason) decoded to labels for the operator.
const ACCOUNT_STATUS_LABELS = {
  1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT', 9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE',
  101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED',
};
const DISABLE_REASON_LABELS = {
  0: 'NONE', 1: 'ADS_INTEGRITY_POLICY', 2: 'ADS_IP_REVIEW', 3: 'RISK_PAYMENT',
  4: 'GRAY_ACCOUNT_SHUT_DOWN', 5: 'ADS_AFC_REVIEW', 6: 'BUSINESS_INTEGRITY_RAR',
  7: 'PERMANENT_CLOSE', 8: 'UNUSED_RESELLER_ACCOUNT', 9: 'UNUSED_ACCOUNT',
};

// Pure read (GET — allowed even in FB_READONLY). Answers "can this token actually write to this
// account, and is the account healthy?" — rules account/permission causes in or out for a 403.
// NOTE: an empty-body 403 returned in ~tens of ms is NOT a Meta rejection at all — it's the
// proxy/egress layer refusing the request before it reaches Meta (see fbClient http_error branch);
// that is unrelated to account health or token tasks, which this probe confirms are fine.
export async function getAccountCapability() {
  const acct = config.primaryAccountId;
  const res = await fb.get(`/${acct}`, {
    fields: 'id,name,account_status,disable_reason,user_tasks,currency,timezone_name',
  }, 'GET:/account/capability');
  if (!res.ok) return { ok: false, ...res, message: errorMessageOf(res) };

  const b = res.body || {};
  const tasks = Array.isArray(b.user_tasks) ? b.user_tasks : [];
  const canWrite = tasks.includes('MANAGE') || tasks.includes('ADVERTISE');
  const status = Number(b.account_status);
  const disable = Number(b.disable_reason);
  return {
    ok: true,
    accountId: b.id || acct,
    name: b.name ?? null,
    accountStatus: status,
    accountStatusLabel: ACCOUNT_STATUS_LABELS[status] || `UNKNOWN(${b.account_status})`,
    disableReason: disable,
    disableReasonLabel: DISABLE_REASON_LABELS[disable] ?? `UNKNOWN(${b.disable_reason})`,
    userTasks: tasks,
    canWrite,
    currency: b.currency ?? null,
    timezone: b.timezone_name ?? null,
    healthy: status === 1 && disable === 0 && canWrite,
  };
}

// ---------- READ intelligence (no writes — safe on live campaigns) ----------

// Whitelisted breakdown presets. Restricting to valid combinations avoids the malformed-call
// pattern that Meta's anomaly detection flags.
export const BREAKDOWN_PRESETS = {
  age_gender: 'age,gender',
  country: 'country',
  region: 'region',
  platform: 'publisher_platform',
  placement: 'publisher_platform,platform_position',
  device: 'impression_device',
  hourly: 'hourly_stats_aggregated_by_advertiser_time_zone',
};

const INSIGHT_FIELDS = 'spend,impressions,reach,clicks,ctr,cpc,cpm,actions,action_values';

const PURCHASE_ACTION_TYPES = new Set([
  'purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase',
  'onsite_web_purchase', 'web_in_store_purchase',
]);

function extractPurchases(row) {
  let purchases = 0;
  let value = 0;
  for (const a of row.actions || []) {
    if (PURCHASE_ACTION_TYPES.has(a.action_type)) purchases = Math.max(purchases, Number(a.value) || 0);
  }
  for (const a of row.action_values || []) {
    if (PURCHASE_ACTION_TYPES.has(a.action_type)) value = Math.max(value, Number(a.value) || 0);
  }
  return { purchases, purchase_value: value };
}

export async function getBreakdowns({ level, id, datePreset = 'last_7d', breakdown = 'age_gender' }) {
  if (!VALID_LEVELS.has(level)) return { ok: false, error: 'invalid_level' };
  if (!id) return { ok: false, error: 'missing_id' };
  const bd = BREAKDOWN_PRESETS[breakdown];
  if (!bd) return { ok: false, error: 'invalid_breakdown', message: `Unknown breakdown "${breakdown}".` };

  const res = await fb.get(`/${id}/insights`, {
    fields: INSIGHT_FIELDS,
    breakdowns: bd,
    date_preset: datePreset,
    limit: 500,
  }, `GET:/${level}/insights/breakdown`);

  if (!res.ok) return { ok: false, ...res, message: errorMessageOf(res) };
  const dims = bd.split(',');
  const rows = (res.body?.data || []).map((r) => {
    const { purchases, purchase_value } = extractPurchases(r);
    const out = {
      spend: Number(r.spend) || 0,
      impressions: Number(r.impressions) || 0,
      reach: Number(r.reach) || 0,
      clicks: Number(r.clicks) || 0,
      ctr: r.ctr != null ? Number(r.ctr) : null,
      cpc: r.cpc != null ? Number(r.cpc) : null,
      cpm: r.cpm != null ? Number(r.cpm) : null,
      purchases,
      purchase_value,
      roas: purchase_value && Number(r.spend) ? purchase_value / Number(r.spend) : null,
    };
    for (const d of dims) out[d] = r[d] ?? '—';
    return out;
  });
  rows.sort((a, b) => b.spend - a.spend);
  return { ok: true, level, id, breakdown, dims, datePreset, rows };
}

export async function getAdPreview({ adId, adFormat = 'DESKTOP_FEED_STANDARD' }) {
  if (!adId) return { ok: false, error: 'missing_id' };
  const res = await fb.get(`/${adId}/previews`, { ad_format: adFormat }, 'GET:/ad/previews');
  if (!res.ok) return { ok: false, ...res, message: errorMessageOf(res) };
  const body = res.body?.data?.[0]?.body || null;
  if (!body) return { ok: false, error: 'no_preview', message: 'Meta returned no preview for this ad/format.' };
  return { ok: true, adId, adFormat, iframe: body };
}

const ACTIVITY_FIELDS = 'event_type,translated_event_type,actor_name,object_id,object_name,object_type,extra_data,event_time';

/**
 * Change history. The `activities` edge is not valid on campaign/adset/ad nodes (returns #100),
 * so we read the account-level feed (/act_X/activities) — which Meta DOES expose — and filter to
 * the requested entity client-side. With no id, returns the whole recent account feed.
 */
export async function getActivities({ id = null, limit = 100 } = {}) {
  const params = {
    fields: ACTIVITY_FIELDS,
    limit: Math.max(1, Math.min(300, limit)),
  };
  if (config.businessId) params.business_id = config.businessId;
  const res = await fb.get(`/${config.primaryAccountId}/activities`, params, 'GET:/act/activities');
  if (!res.ok) return { ok: false, ...res, message: errorMessageOf(res) };

  let rows = (res.body?.data || []).map((r) => {
    let extra = r.extra_data || null;
    if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch { /* keep string */ } }
    return {
      event_type: r.event_type,
      label: r.translated_event_type || r.event_type,
      actor: r.actor_name || null,
      object_id: r.object_id || null,
      object_name: r.object_name || null,
      object_type: r.object_type || null,
      extra,
      time: r.event_time || null,
    };
  });
  if (id) rows = rows.filter((r) => String(r.object_id) === String(id));
  return { ok: true, id, rows };
}

// ---------- READ: audiences & targeting (grounds lookalike/scaling advice) ----------

// Audience size: Meta is retiring `approximate_count` for lower/upper bounds, and new/inactive
// lookalikes return -1 (no size). Render an honest label rather than a misleading number.
function audienceSizeLabel(lo, hi) {
  const l = Number(lo); const h = Number(hi);
  if (l === -1 || h === -1) return 'n/a (inactive/new)';
  if (!Number.isFinite(l) && !Number.isFinite(h)) return null;
  if (Number.isFinite(l) && Number.isFinite(h)) return l === h ? String(l) : `${l.toLocaleString()}–${h.toLocaleString()}`;
  return String(Number.isFinite(l) ? l : h);
}

export async function listCustomAudiences({ limit = 200 } = {}) {
  const acct = config.primaryAccountId;
  const res = await fb.get(`/${acct}/customaudiences`, {
    fields: 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,lookalike_spec,retention_days,operation_status,delivery_status,time_updated,description',
    limit: Math.max(1, Math.min(500, limit)),
  }, 'GET:/account/customaudiences');
  if (!res.ok) return { ok: false, ...res, message: errorMessageOf(res) };

  const audiences = (res.body?.data || []).map((a) => {
    const spec = a.lookalike_spec || null;
    const origin = Array.isArray(spec?.origin) && spec.origin.length ? (spec.origin[0].name || spec.origin[0].id) : null;
    const country = spec ? (spec.country || (Array.isArray(spec?.location_spec?.geo_locations?.countries) ? spec.location_spec.geo_locations.countries.join(',') : null)) : null;
    return {
      id: a.id,
      name: a.name || null,
      subtype: a.subtype || null,
      size: audienceSizeLabel(a.approximate_count_lower_bound, a.approximate_count_upper_bound),
      lookalike: spec ? { ratio: spec.ratio != null ? Number(spec.ratio) : null, country, origin } : null,
      retentionDays: a.retention_days ?? null,
      status: a.operation_status?.description || a.operation_status?.code || a.delivery_status?.description || null,
      updated: a.time_updated || null,
    };
  });
  return { ok: true, accountId: acct, audiences };
}

export async function getAdSetTargeting({ id }) {
  if (!id) return { ok: false, error: 'missing_id', message: 'Ad set id is required.' };
  const res = await fb.get(`/${id}`, { fields: 'name,targeting' }, 'GET:/adset/targeting');
  if (!res.ok) return { ok: false, ...res, message: errorMessageOf(res) };
  return { ok: true, id, name: res.body?.name || null, targeting: res.body?.targeting || null };
}

// ---------- WRITE: duplicate (creates a PAUSED copy — never edits the source) ----------

// `costCap` (MINOR UNITS / cents, optional) implements the two-governor method in one approval:
// after the PAUSED copy is created, apply a Cost/Bid cap to the COPY (never the source). The source
// is left untouched on its existing strategy. Applying a cap to a brand-new copy resets no learning
// (it has none yet), so this is safe by construction.
export async function duplicate({ level, id, deepCopy = true, costCap = null, bidStrategy = 'COST_CAP' }) {
  if (level !== 'campaign' && level !== 'adset') {
    return { ok: false, error: 'invalid_level', message: 'Only campaigns or ad sets can be duplicated.' };
  }
  if (!id) return { ok: false, error: 'missing_id' };

  const before = store.getEntity(level, id);
  const data = { status_option: 'PAUSED', deep_copy: !!deepCopy };
  log.info('ad.duplicate.attempt', { level, id, name: before?.name, deepCopy, costCap });

  const result = await fb.manage('POST', `/${id}/copies`, data, `POST:/${level}/copies`);

  if (!result.ok) {
    store.logAdAction({
      action: 'duplicate', level, entity_id: id, entity_name: before?.name ?? null,
      before_value: null, after_value: null, payload_json: data,
      response_json: result.error || result, success: 0, error_message: errorMessageOf(result),
    });
    log.warn('ad.duplicate.failed', { level, id, error: errorMessageOf(result), blocked: !!result.blocked });
    return { ok: false, ...result, message: errorMessageOf(result) };
  }

  const b = result.body || {};
  const newId = b.copied_campaign_id || b.copied_adset_id || b.id || b.ad_object_ids?.[0]?.copied_id || null;
  store.logAdAction({
    action: 'duplicate', level, entity_id: id, entity_name: before?.name ?? null,
    before_value: null, after_value: newId ? String(newId) : 'created',
    payload_json: data, response_json: result.body, success: 1, error_message: null,
  });
  log.info('ad.duplicate.ok', { level, id, newId });

  // Two-governor: cap the fresh copy (best-effort — the copy already exists PAUSED regardless).
  let cap = null;
  if (newId && costCap != null && Number(costCap) > 0) {
    const capRes = await setBidStrategy({ level, id: newId, strategy: bidStrategy, bidAmount: costCap });
    cap = capRes.ok
      ? { applied: true, strategy: capRes.strategy, bidAmount: capRes.bidAmount }
      : { applied: false, error: capRes.message || 'cap failed' };
    log.info('ad.duplicate.cap', { newId, ok: capRes.ok, error: capRes.ok ? null : capRes.message });
  }
  return { ok: true, level, sourceId: id, newId, status: 'PAUSED', cap };
}

export function adMgmtState() {
  return {
    allowAdManagement: safety.isAdManagementAllowed(),
    readonly: safety.isReadonly(),
    killSwitch: safety.isKillSwitchActive(),
  };
}
