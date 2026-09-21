import { fb } from './fbClient.js';
import { config } from './env.js';
import { safety } from './safety.js';
import { store } from './store.js';
import { log } from './logger.js';
import {
  VALID_DATE_PRESETS,
  CAMPAIGN_ENTITY_FIELDS,
  ADSET_ENTITY_FIELDS,
  AD_ENTITY_FIELDS,
  INSIGHTS_FIELDS,
  insightsHadDeliveryFilter,
  normalizeInsightsRow,
} from './insights.js';

export async function refreshDashboard({ datePreset = 'today', accountId, onlyHadDelivery = true } = {}) {
  const acct = accountId || config.primaryAccountId;
  if (!safety.isAccountAllowed(acct)) {
    const allAllowed = [config.primaryAccountId, ...(config.additionalAccountIds || [])].join(', ');
    return { ok: false, error: 'account_not_allowed', message: `Only these accounts can be queried: ${allAllowed}` };
  }
  if (!VALID_DATE_PRESETS.has(datePreset)) {
    return { ok: false, error: 'invalid_date_preset', message: `date_preset must be one of: ${[...VALID_DATE_PRESETS].join(', ')}` };
  }

  const runId = store.startRun(datePreset);
  const startedAtMs = Date.now();
  let httpCalls = 0;
  let campaignsCount = 0;
  try {
    const acctRes = await fb.get(
      `/${acct}`,
      {
        fields: 'id,name,currency,timezone_name,account_status,amount_spent,spend_cap,business',
      },
      `GET:/act/account`,
    );
    if (!acctRes.ok) {
      store.finishRun(runId, 'error', httpCalls + 1, 0, acctRes.error?.message || acctRes.message || 'account fetch failed');
      return { ok: false, error: 'account_fetch_failed', detail: acctRes };
    }
    httpCalls += 1;
    store.upsertAccount(acctRes.body);

    const batchOps = [
      {
        name: 'campaigns',
        method: 'GET',
        relative_url: `${acct}/campaigns?fields=${encodeURIComponent(CAMPAIGN_ENTITY_FIELDS)}&limit=100`,
      },
      {
        name: 'insights',
        method: 'GET',
        relative_url:
          `${acct}/insights?level=campaign` +
          `&date_preset=${encodeURIComponent(datePreset)}` +
          `&fields=${encodeURIComponent(INSIGHTS_FIELDS)}` +
          (onlyHadDelivery ? `&filtering=${encodeURIComponent(insightsHadDeliveryFilter('campaign'))}` : '') +
          `&limit=200`,
      },
    ];

    const batchRes = await fb.batch(batchOps, `POST:/batch/dashboard`);
    httpCalls += 1;
    if (!batchRes.ok) {
      store.finishRun(runId, 'error', httpCalls, 0, batchRes.error?.message || batchRes.message || 'batch failed');
      return { ok: false, error: 'batch_failed', detail: batchRes };
    }

    const campaignsResp = batchRes.parsed.campaigns;
    if (!campaignsResp?.ok) {
      store.finishRun(runId, 'error', httpCalls, 0, campaignsResp?.body?.error?.message || 'campaigns sub-op failed');
      return { ok: false, error: 'campaigns_sub_failed', detail: campaignsResp };
    }
    let campaignsRows = campaignsResp.body?.data || [];

    if (campaignsResp.body?.paging?.next) {
      log.warn('fb.campaigns.pagination_needed', { account: acct });
      const rest = await fb.getAll(`${acct}/campaigns`, { fields: CAMPAIGN_ENTITY_FIELDS, limit: 100, after: campaignsResp.body.paging.cursors?.after }, 'GET:/act/campaigns', 10);
      if (rest.ok && rest.body?.data) {
        campaignsRows = campaignsRows.concat(rest.body.data);
      }
    }

    store.upsertCampaigns(acct, campaignsRows);
    campaignsCount = campaignsRows.length;

    const insightsResp = batchRes.parsed.insights;
    const insightsRows = insightsResp?.ok ? insightsResp.body?.data || [] : [];
    const normalized = insightsRows.map((r) => normalizeInsightsRow(r, 'campaign')).filter((r) => r.entityId);
    store.replaceInsightsForPreset(acct, 'campaign', datePreset, normalized);

    const elapsedMs = Date.now() - startedAtMs;
    store.finishRun(runId, 'success', httpCalls, campaignsCount, null);
    log.info('refresh.complete', {
      account: acct,
      preset: datePreset,
      httpCalls,
      campaigns: campaignsCount,
      insights: normalized.length,
      elapsedMs,
    });
    return { ok: true, runId, datePreset, httpCalls, campaignsCount, insightsCount: normalized.length, elapsedMs };
  } catch (err) {
    log.error('refresh.exception', { error: String(err.message || err), stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
    store.finishRun(runId, 'error', httpCalls, campaignsCount, String(err.message || err));
    return { ok: false, error: 'exception', message: String(err.message || err) };
  }
}

const SUMMABLE_COLS = [
  'spend', 'reach', 'impressions', 'inline_link_clicks', 'unique_inline_link_clicks',
  'post_comments', 'post_engagements', 'link_clicks',
  'landing_page_views_total', 'landing_page_views_app', 'landing_page_views_website',
  'atc_total', 'atc_app', 'atc_website', 'atc_offline', 'atc_meta',
  'ic_total', 'ic_app', 'ic_website', 'ic_offline', 'ic_meta',
  'purchases_total', 'purchases_app', 'purchases_website', 'purchases_offline', 'purchases_meta',
  'purchase_value_total', 'purchase_value_app', 'purchase_value_website', 'purchase_value_offline', 'purchase_value_meta',
];

function safeDiv(num, den) {
  return den > 0 ? num / den : null;
}

export async function refreshAllLevels({ datePreset = 'today', accountId, onlyHadDelivery = false } = {}) {
  const startedAtMs = Date.now();
  const results = {};
  let httpCalls = 0;

  const c = await refreshDashboard({ datePreset, accountId, onlyHadDelivery });
  httpCalls += c.httpCalls || 0;
  results.campaign = c;
  if (!c.ok) {
    return { ok: false, error: 'campaign_refresh_failed', detail: c, results };
  }

  const a = await refreshLevel({ level: 'adset', datePreset, accountId, onlyHadDelivery });
  httpCalls += a.httpCalls || 0;
  results.adset = a;
  if (!a.ok) {
    log.warn('refresh.all.adset_failed', { error: a.error });
  }

  const d = await refreshLevel({ level: 'ad', datePreset, accountId, onlyHadDelivery });
  httpCalls += d.httpCalls || 0;
  results.ad = d;
  if (!d.ok) {
    log.warn('refresh.all.ad_failed', { error: d.error });
  }

  const elapsedMs = Date.now() - startedAtMs;
  log.info('refresh.all.complete', { datePreset, httpCalls, elapsedMs, campaigns: c.campaignsCount, adsets: a.entitiesCount, ads: d.entitiesCount });
  return { ok: true, datePreset, httpCalls, elapsedMs, results };
}

export async function refreshLevel({ level, datePreset = 'today', accountId, campaignId, adsetId, onlyHadDelivery = false } = {}) {
  if (level === 'campaign') {
    return refreshDashboard({ datePreset, accountId, onlyHadDelivery });
  }
  const acct = accountId || config.primaryAccountId;
  if (!safety.isAccountAllowed(acct)) {
    const allAllowed = [config.primaryAccountId, ...(config.additionalAccountIds || [])].join(', ');
    return { ok: false, error: 'account_not_allowed', message: `Only these accounts can be queried: ${allAllowed}` };
  }
  if (!VALID_DATE_PRESETS.has(datePreset)) {
    return { ok: false, error: 'invalid_date_preset' };
  }
  if (!['adset', 'ad'].includes(level)) {
    return { ok: false, error: 'invalid_level', message: `level must be campaign|adset|ad` };
  }

  const startedAtMs = Date.now();
  let httpCalls = 0;

  const fields = level === 'adset' ? ADSET_ENTITY_FIELDS : AD_ENTITY_FIELDS;
  const insightsLevel = level;

  let entitiesPath;
  if (level === 'adset') {
    if (campaignId) entitiesPath = `${campaignId}/adsets`;
    else entitiesPath = `${acct}/adsets`;
  } else {
    if (adsetId) entitiesPath = `${adsetId}/ads`;
    else if (campaignId) entitiesPath = `${campaignId}/ads`;
    else entitiesPath = `${acct}/ads`;
  }

  const insightsFiltering = [];
  if (level === 'adset' && campaignId) insightsFiltering.push({ field: 'campaign.id', operator: 'IN', value: [campaignId] });
  if (level === 'ad' && adsetId) insightsFiltering.push({ field: 'adset.id', operator: 'IN', value: [adsetId] });
  else if (level === 'ad' && campaignId) insightsFiltering.push({ field: 'campaign.id', operator: 'IN', value: [campaignId] });
  if (onlyHadDelivery) insightsFiltering.push(JSON.parse(insightsHadDeliveryFilter(level))[0]);

  const insightsUrl =
    `${acct}/insights?level=${insightsLevel}` +
    `&date_preset=${encodeURIComponent(datePreset)}` +
    `&fields=${encodeURIComponent(INSIGHTS_FIELDS)}` +
    (insightsFiltering.length ? `&filtering=${encodeURIComponent(JSON.stringify(insightsFiltering))}` : '') +
    `&limit=200`;

  const batchOps = [
    { name: 'entities', method: 'GET', relative_url: `${entitiesPath}?fields=${encodeURIComponent(fields)}&limit=200` },
    { name: 'insights', method: 'GET', relative_url: insightsUrl },
  ];

  const batchRes = await fb.batch(batchOps, `POST:/batch/${level}`);
  httpCalls += 1;
  if (!batchRes.ok) {
    return { ok: false, error: 'batch_failed', detail: batchRes };
  }

  const entitiesResp = batchRes.parsed.entities;
  if (!entitiesResp?.ok) {
    return { ok: false, error: `${level}_sub_failed`, detail: entitiesResp };
  }
  let entityRows = entitiesResp.body?.data || [];

  if (entitiesResp.body?.paging?.next) {
    log.warn(`fb.${level}.pagination_needed`, { account: acct, campaignId, adsetId });
    const after = entitiesResp.body.paging.cursors?.after;
    const rest = await fb.getAll(entitiesPath, { fields, limit: 200, after }, `GET:/${level}.paged`, 10);
    httpCalls += rest.httpCalls || 1;
    if (rest.ok && rest.body?.data) entityRows = entityRows.concat(rest.body.data);
  }

  if (level === 'adset') store.upsertAdsets(acct, entityRows);
  else store.upsertAds(acct, entityRows);

  const insightsResp = batchRes.parsed.insights;
  const insightsRows = insightsResp?.ok ? insightsResp.body?.data || [] : [];
  const normalized = insightsRows.map((r) => normalizeInsightsRow(r, level)).filter((r) => r.entityId);
  store.replaceInsightsForPreset(acct, level, datePreset, normalized);

  const elapsedMs = Date.now() - startedAtMs;
  log.info('refresh.level.complete', { level, account: acct, preset: datePreset, httpCalls, entities: entityRows.length, insights: normalized.length, elapsedMs });
  return { ok: true, level, datePreset, httpCalls, entitiesCount: entityRows.length, insightsCount: normalized.length, elapsedMs };
}

export function buildDashboardPayload(datePreset = 'today', { level = 'campaign', campaignId, adsetId, accountId } = {}) {
  const { account, rows, lastRun } = store.getLevelData(accountId || config.primaryAccountId, level, datePreset, { campaignId, adsetId });

  let lastInsightsFetchedAt = null;
  let oldestInsightsFetchedAt = null;
  let rowsWithoutInsights = 0;
  for (const r of rows) {
    const ts = r.insights_fetched_at;
    if (!ts) {
      if (r.effective_status === 'ACTIVE') rowsWithoutInsights += 1;
      continue;
    }
    if (!lastInsightsFetchedAt || ts > lastInsightsFetchedAt) lastInsightsFetchedAt = ts;
    if (!oldestInsightsFetchedAt || ts < oldestInsightsFetchedAt) oldestInsightsFetchedAt = ts;
  }

  const totals = Object.fromEntries(SUMMABLE_COLS.map((c) => [c, 0]));
  for (const c of rows) {
    for (const col of SUMMABLE_COLS) {
      totals[col] += c[col] || 0;
    }
  }

  const spend = totals.spend;
  const reach = totals.reach;
  const impressions = totals.impressions;
  const inlineLinkClicks = totals.inline_link_clicks;
  const uniqueLinkClicks = totals.unique_inline_link_clicks;

  return {
    account,
    level,
    parentCampaignId: campaignId || null,
    parentAdsetId: adsetId || null,
    rows,
    campaigns: level === 'campaign' ? rows : undefined,
    lastRun,
    lastInsightsFetchedAt,
    oldestInsightsFetchedAt,
    rowsWithoutInsights,
    totals: {
      spend,
      reach,
      impressions,
      frequency: safeDiv(impressions, reach),
      postComments: totals.post_comments,
      postEngagements: totals.post_engagements,
      linkClicks: totals.link_clicks,
      cpm: safeDiv(spend, impressions) * 1000 || 0,
      uniqueLinkClickCtr: safeDiv(uniqueLinkClicks, reach) * 100 || 0,
      uniqueInlineLinkClicks: uniqueLinkClicks,
      inlineLinkClicks,
      costPerInlineLinkClick: safeDiv(spend, inlineLinkClicks),
      landingPageViewsTotal: totals.landing_page_views_total,
      landingPageViewsApp: totals.landing_page_views_app,
      landingPageViewsWebsite: totals.landing_page_views_website,
      costPerLandingPageView: safeDiv(spend, totals.landing_page_views_total),
      atcTotal: totals.atc_total,
      atcApp: totals.atc_app,
      atcWebsite: totals.atc_website,
      atcOffline: totals.atc_offline,
      atcMeta: totals.atc_meta,
      costPerAddToCart: safeDiv(spend, totals.atc_total),
      icTotal: totals.ic_total,
      icApp: totals.ic_app,
      icWebsite: totals.ic_website,
      icOffline: totals.ic_offline,
      icMeta: totals.ic_meta,
      costPerInitiateCheckout: safeDiv(spend, totals.ic_total),
      purchasesTotal: totals.purchases_total,
      purchasesApp: totals.purchases_app,
      purchasesWebsite: totals.purchases_website,
      purchasesOffline: totals.purchases_offline,
      purchasesMeta: totals.purchases_meta,
      costPerPurchase: safeDiv(spend, totals.purchases_total),
      purchaseValueTotal: totals.purchase_value_total,
      purchaseValueApp: totals.purchase_value_app,
      purchaseValueWebsite: totals.purchase_value_website,
      purchaseValueOffline: totals.purchase_value_offline,
      purchaseValueMeta: totals.purchase_value_meta,
      purchaseRoasTotal: safeDiv(totals.purchase_value_total, spend),
      purchaseRoasWebsite: safeDiv(totals.purchase_value_website, spend),
      purchaseRoasApp: safeDiv(totals.purchase_value_app, spend),
    },
  };
}
