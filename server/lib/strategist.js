import { fb } from './fbClient.js';
import { config } from './env.js';
import { log } from './logger.js';
import {
  INSIGHTS_FIELDS,
  CAMPAIGN_ENTITY_FIELDS,
  ADSET_ENTITY_FIELDS,
  normalizeInsightsRow,
} from './insights.js';
import { buildDecisionDigest } from './decisions.js';

// Suggest-only strategy advisor. Pulls a 30/90-day read snapshot in ONE batched call,
// then derives learning-phase health, performance patterns (day-of-week / hour / placement /
// age-gender), creative-fatigue and scaling/stop-loss signals, and a ranked action list.
// It NEVER writes to Meta — every output is a recommendation the operator applies manually.

const WINDOW_DAYS = { last_7d: 7, last_14d: 14, last_28d: 28, last_30d: 30, last_90d: 90 };
const LEARNING_EVENTS_PER_WEEK = 50;       // Meta's learning-phase threshold
const MIN_EVENTS_FOR_PATTERN = 20;         // noise guard before we claim a day/hour/segment pattern
const MIN_EVENTS_PER_BUCKET = 3;           // a single weekday/hour bucket needs at least this
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let lastAnalysis = null;
export function getLastAnalysis() { return lastAnalysis; }

const nz = (n) => (Number.isFinite(n) ? n : 0);
const div = (a, b) => (b > 0 ? a / b : null);
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

function emptyAgg() {
  return { spend: 0, purchases: 0, value: 0, impressions: 0, reach: 0, clicks: 0, lpv: 0, linkClicks: 0, atc: 0, count: 0 };
}
function addMetrics(agg, m) {
  agg.spend += nz(m.spend);
  agg.purchases += nz(m.purchasesTotal);
  agg.value += nz(m.purchaseValueTotal);
  agg.impressions += nz(m.impressions);
  agg.reach += nz(m.reach);
  agg.clicks += nz(m.inlineLinkClicks);
  agg.lpv += nz(m.landingPageViewsTotal);
  agg.linkClicks += nz(m.linkClicks);
  agg.atc += nz(m.atcTotal);
  agg.count += 1;
}
function derive(agg) {
  return {
    spend: round(agg.spend), purchases: agg.purchases, value: round(agg.value),
    impressions: agg.impressions, clicks: agg.clicks, lpv: agg.lpv, linkClicks: agg.linkClicks, atc: agg.atc,
    cpa: round(div(agg.spend, agg.purchases)),
    roas: round(div(agg.value, agg.spend)),
    ctr: round(div(agg.clicks, agg.impressions) * 100, 3),
    cpl: round(div(agg.spend, agg.lpv)),
    cpm: round(div(agg.spend, agg.impressions) * 1000),
  };
}

// Which KPI carries signal for this account (donations may not fire purchases).
function pickKpi(totals) {
  if (totals.purchases >= 10) return { kind: 'purchase', label: 'purchases' };
  if (totals.lpv >= 10) return { kind: 'landing_page_view', label: 'landing-page views' };
  if (totals.atc >= 10) return { kind: 'add_to_cart', label: 'adds to cart' };
  return { kind: 'link_click', label: 'link clicks' };
}
function kpiCount(agg, kpi) {
  if (kpi.kind === 'purchase') return nz(agg.purchases);
  if (kpi.kind === 'landing_page_view') return nz(agg.lpv);
  if (kpi.kind === 'add_to_cart') return nz(agg.atc);
  return nz(agg.linkClicks || agg.clicks);
}
function kpiCpa(agg, kpi) { return div(nz(agg.spend), kpiCount(agg, kpi)); }

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function fmtMoney(n) { return n == null ? '—' : `$${round(n, 2)}`; }

// ---------- main ----------

export async function analyzeStrategy({ window = 'last_30d' } = {}) {
  const days = WINDOW_DAYS[window] || 30;
  const acct = config.primaryAccountId;
  const dailyWindow = days >= 30 ? 'last_90d' : window; // need more samples for weekday reliability
  const dailyDays = WINDOW_DAYS[dailyWindow] || 90;

  const bdFields = 'spend,impressions,actions,action_values';

  // reach windows for Net New Reach / saturation (3 single-row pulls)
  const isoUTC = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 864e5);
  const d60 = new Date(now.getTime() - 60 * 864e5);
  const rng = (since, until) => encodeURIComponent(JSON.stringify({ since: isoUTC(since), until: isoUTC(until) }));
  const activeAdFilter = encodeURIComponent(JSON.stringify([{ field: 'ad.effective_status', operator: 'IN', value: ['ACTIVE'] }]));

  const ops = [
    { name: 'acct_daily', method: 'GET', relative_url: `${acct}/insights?date_preset=${dailyWindow}&time_increment=1&fields=spend,impressions,reach,inline_link_clicks,actions,action_values&limit=200` },
    { name: 'camp_agg', method: 'GET', relative_url: `${acct}/insights?level=campaign&date_preset=${window}&fields=${encodeURIComponent(INSIGHTS_FIELDS)}&limit=200` },
    { name: 'adset_agg', method: 'GET', relative_url: `${acct}/insights?level=adset&date_preset=${window}&fields=${encodeURIComponent(INSIGHTS_FIELDS)}&limit=400` },
    { name: 'campaigns', method: 'GET', relative_url: `${acct}/campaigns?fields=${encodeURIComponent(CAMPAIGN_ENTITY_FIELDS)}&limit=200` },
    { name: 'adsets', method: 'GET', relative_url: `${acct}/adsets?fields=${encodeURIComponent(ADSET_ENTITY_FIELDS)}&limit=400` },
    { name: 'bd_placement', method: 'GET', relative_url: `${acct}/insights?date_preset=${window}&breakdowns=publisher_platform,platform_position&fields=${bdFields}&limit=200` },
    { name: 'bd_agegender', method: 'GET', relative_url: `${acct}/insights?date_preset=${window}&breakdowns=age,gender&fields=${bdFields}&limit=200` },
    { name: 'bd_hourly', method: 'GET', relative_url: `${acct}/insights?date_preset=${window}&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone&fields=${bdFields}&limit=200` },
    { name: 'bd_country', method: 'GET', relative_url: `${acct}/insights?date_preset=${window}&breakdowns=country&fields=${bdFields}&limit=200` },
    { name: 'bd_device', method: 'GET', relative_url: `${acct}/insights?date_preset=${window}&breakdowns=impression_device&fields=${bdFields}&limit=200` },
    // ----- decision-grade additions -----
    { name: 'camp_daily', method: 'GET', relative_url: `${acct}/insights?level=campaign&date_preset=last_90d&time_increment=1&fields=campaign_id,campaign_name,spend,impressions,reach,inline_link_clicks,actions,action_values&limit=500` },
    { name: 'ad_ranking', method: 'GET', relative_url: `${acct}/insights?level=ad&date_preset=${window}&fields=ad_id,ad_name,campaign_name,adset_name,impressions,spend,frequency,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,actions&filtering=${activeAdFilter}&sort=impressions_descending&limit=200` },
    { name: 'reach_this30', method: 'GET', relative_url: `${acct}/insights?time_range=${rng(d30, now)}&fields=reach,frequency,impressions` },
    { name: 'reach_prior30', method: 'GET', relative_url: `${acct}/insights?time_range=${rng(d60, d30)}&fields=reach,frequency,impressions` },
    { name: 'reach_comb60', method: 'GET', relative_url: `${acct}/insights?time_range=${rng(d60, now)}&fields=reach,frequency,impressions` },
  ];

  const t0 = Date.now();
  const res = await fb.batch(ops, 'POST:/batch/strategy');
  if (!res.ok) {
    log.error('strategy.batch_failed', { error: res.error?.message || res.message });
    return { ok: false, error: 'batch_failed', message: res.message || 'Strategy data fetch failed', detail: res };
  }
  const sub = (name) => (res.parsed?.[name]?.ok ? (res.parsed[name].body?.data || []) : []);

  const dailyRows = sub('acct_daily');
  const campInsights = sub('camp_agg');
  const adsetInsights = sub('adset_agg');
  const campEntities = sub('campaigns');
  const adsetEntities = sub('adsets');
  const placementRows = sub('bd_placement');
  const ageGenderRows = sub('bd_agegender');
  const hourlyRows = sub('bd_hourly');
  const countryRows = sub('bd_country');
  const deviceRows = sub('bd_device');
  const campDailyRows = sub('camp_daily');
  const adRankingRows = sub('ad_ranking');
  const reachWindows = {
    this30: sub('reach_this30')?.[0] || null,
    prior30: sub('reach_prior30')?.[0] || null,
    combined60: sub('reach_comb60')?.[0] || null,
  };

  // ----- entity maps -----
  const campMeta = new Map();
  for (const c of campEntities) campMeta.set(c.id, c);
  const adsetMeta = new Map();
  for (const a of adsetEntities) adsetMeta.set(a.id, a);
  const campName = new Map();
  for (const r of campInsights) if (r.campaign_id) campName.set(r.campaign_id, r.campaign_name);
  for (const c of campEntities) if (!campName.has(c.id)) campName.set(c.id, c.name);

  // ----- account totals (from campaign aggregate) -----
  const totalsAgg = emptyAgg();
  for (const r of campInsights) addMetrics(totalsAgg, normalizeInsightsRow(r, 'campaign'));
  const totals = derive(totalsAgg);
  const kpi = pickKpi(totalsAgg);

  // ----- per-campaign metrics -----
  const campaigns = [];
  for (const r of campInsights) {
    const m = normalizeInsightsRow(r, 'campaign');
    const agg = emptyAgg(); addMetrics(agg, m);
    const meta = campMeta.get(r.campaign_id) || {};
    campaigns.push({
      id: r.campaign_id, name: r.campaign_name || meta.name || r.campaign_id,
      status: meta.effective_status || meta.status || null,
      objective: meta.objective || null, bidStrategy: meta.bid_strategy || null,
      isCBO: nz(Number(meta.daily_budget)) > 0 || nz(Number(meta.lifetime_budget)) > 0,
      frequency: round(div(m.impressions, m.reach)),
      ...derive(agg),
      kpiCount: kpiCount(agg, kpi), kpiCpa: round(kpiCpa(agg, kpi)),
    });
  }
  const activeCampaigns = campaigns.filter((c) => c.status === 'ACTIVE');
  const medianRoas = median(activeCampaigns.map((c) => c.roas).filter((n) => n != null));
  const medianKpiCpa = median(activeCampaigns.map((c) => c.kpiCpa).filter((n) => n != null));

  // ----- per-adset metrics + learning phase -----
  const adsets = [];
  for (const r of adsetInsights) {
    const m = normalizeInsightsRow(r, 'adset');
    const agg = emptyAgg(); addMetrics(agg, m);
    const meta = adsetMeta.get(r.adset_id) || {};
    const events = kpiCount(agg, kpi);
    const weeklyEvents = round((events * 7) / days, 1);
    const cpa = kpiCpa(agg, kpi);
    const dailyBudget = nz(Number(meta.daily_budget)) > 0 ? Number(meta.daily_budget) / 100 : null;
    const lifetimeBudget = nz(Number(meta.lifetime_budget)) > 0 ? Number(meta.lifetime_budget) / 100 : null;
    const minDailyToExit = cpa != null ? round((cpa * LEARNING_EVENTS_PER_WEEK) / 7) : null;
    adsets.push({
      id: r.adset_id, name: r.adset_name || meta.name || r.adset_id,
      campaignId: meta.campaign_id || r.campaign_id || null,
      campaignName: campName.get(meta.campaign_id || r.campaign_id) || null,
      status: meta.effective_status || meta.status || null,
      optimizationGoal: meta.optimization_goal || null,
      dailyBudget, lifetimeBudget,
      frequency: round(div(m.impressions, m.reach)),
      ...derive(agg),
      kpiCount: events, weeklyEvents, kpiCpa: round(cpa), minDailyToExit,
      learningLimited: weeklyEvents < LEARNING_EVENTS_PER_WEEK,
    });
  }
  const activeAdsets = adsets.filter((a) => a.status === 'ACTIVE');

  // ----- patterns: day-of-week + trend (account daily) -----
  const byWeekday = WEEKDAYS.map(() => emptyAgg());
  const sortedDaily = dailyRows
    .map((r) => ({ date: r.date_start, m: normalizeInsightsRow(r, 'campaign') }))
    .filter((d) => d.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of sortedDaily) {
    const wd = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    if (wd >= 0 && wd <= 6) addMetrics(byWeekday[wd], d.m);
  }
  const weekday = buildWeekdayPattern(byWeekday, kpi);

  // trend: first vs second half of the daily window
  const trend = buildTrend(sortedDaily, kpi);

  // ----- patterns: hourly / placement / age-gender (account breakdowns) -----
  const hourly = buildHourlyPattern(hourlyRows, kpi);
  const placement = buildSegmentPattern(placementRows, kpi, (r) => `${r.publisher_platform || '?'} · ${(r.platform_position || '').replace(/_/g, ' ')}`.trim());
  const ageGender = buildSegmentPattern(ageGenderRows, kpi, (r) => `${r.age || '?'} · ${r.gender || '?'}`);

  // ----- ranked actions -----
  const actions = [];
  const avgDailySpend = totals.spend != null ? totals.spend / days : 0;

  // tracking gap (very high value for donation accounts)
  if (totalsAgg.purchases === 0 && totalsAgg.value === 0 && totalsAgg.spend > 0 && kpi.kind !== 'purchase') {
    actions.push({
      severity: 'high', sev: 90, scope: 'account', strategy: 'fix_tracking', type: 'tracking',
      title: 'No purchase/value signal is being recorded',
      detail: `Across the window the account spent ${fmtMoney(totals.spend)} with 0 tracked purchases or conversion value. Analysis fell back to ${kpi.label}. Verify the Pixel / Conversions API and that ad sets optimize for the donation event — without a purchase signal, ROAS-based scaling is impossible.`,
      evidence: { spend: totals.spend, purchases: 0 },
    });
  }

  // learning-phase / stop-loss per active ad set
  for (const a of activeAdsets) {
    if (a.kpiCount === 0 && a.spend != null && a.spend >= Math.max(2 * (a.dailyBudget || avgDailySpend || 1), 30)) {
      actions.push({
        severity: 'high', sev: 80, scope: 'adset', entityId: a.id, entityName: a.name, campaignName: a.campaignName,
        strategy: 'pause', type: 'stop_loss',
        title: `Stop-loss: ${a.name} spent ${fmtMoney(a.spend)} with 0 ${kpi.label}`,
        detail: `This ad set has no ${kpi.label} over ${days} days despite ${fmtMoney(a.spend)} spend. Consider pausing it (or re-checking its optimization event/tracking) before it burns more budget.`,
        evidence: { spend: a.spend, events: 0 },
      });
      continue;
    }
    if (a.learningLimited && a.spend > 0) {
      const fix = a.minDailyToExit != null && a.dailyBudget != null && a.minDailyToExit > a.dailyBudget
        ? `Its budget (${fmtMoney(a.dailyBudget)}/day) is below the ~${fmtMoney(a.minDailyToExit)}/day needed to reach 50 ${kpi.label}/week at its current cost. Either raise the budget (≤20%/48h steps), consolidate it with sibling ad sets, or optimize for a higher-funnel event.`
        : `Consolidate it with sibling ad sets or optimize for a higher-funnel event so Meta gets ~50 ${kpi.label}/week of signal.`;
      actions.push({
        severity: a.weeklyEvents < LEARNING_EVENTS_PER_WEEK / 2 ? 'high' : 'medium',
        sev: a.weeklyEvents < LEARNING_EVENTS_PER_WEEK / 2 ? 70 : 50,
        scope: 'adset', entityId: a.id, entityName: a.name, campaignName: a.campaignName,
        strategy: 'consolidate', type: 'learning',
        title: `Learning Limited: ${a.name} (~${a.weeklyEvents} ${kpi.label}/wk vs 50 needed)`,
        detail: `${fix} Current ${kpi.label} cost ≈ ${fmtMoney(a.kpiCpa)}.`,
        evidence: { weeklyEvents: a.weeklyEvents, dailyBudget: a.dailyBudget, minDailyToExit: a.minDailyToExit, cpa: a.kpiCpa },
      });
    }
  }

  // scaling readiness + fatigue per active campaign
  for (const c of activeCampaigns) {
    const winningRoas = medianRoas != null && c.roas != null && c.roas >= medianRoas * 1.2 && c.roas >= 1;
    const winningCpa = medianKpiCpa != null && c.kpiCpa != null && c.kpiCpa <= medianKpiCpa * 0.8;
    if ((winningRoas || winningCpa) && (c.frequency == null || c.frequency < 2) && c.kpiCount >= 5) {
      actions.push({
        severity: 'medium', sev: 55, scope: 'campaign', entityId: c.id, entityName: c.name,
        strategy: c.isCBO ? 'scale_vertical' : 'scale_horizontal', type: 'scale',
        title: `Scale candidate: ${c.name}`,
        detail: c.isCBO
          ? `ROAS ${c.roas ?? '—'} / ${kpi.label} cost ${fmtMoney(c.kpiCpa)} beats the account median with frequency ${c.frequency ?? '—'}. Raise budget ~15-20% early in the day, then wait 48-72h before the next step.`
          : `ROAS ${c.roas ?? '—'} / ${kpi.label} cost ${fmtMoney(c.kpiCpa)} beats the account median with low frequency ${c.frequency ?? '—'}. Surf-scale it: raise the winning ad set ~15-20% (≤ once / 48-72h) and/or duplicate the winner into a fresh geo/audience (PAUSED, then turn on).`,
        evidence: { roas: c.roas, kpiCpa: c.kpiCpa, frequency: c.frequency, medianRoas: round(medianRoas) },
      });
    }
    if (c.frequency != null && c.frequency > 3 && c.spend >= 20) {
      actions.push({
        severity: 'medium', sev: 45, scope: 'campaign', entityId: c.id, entityName: c.name,
        strategy: 'creative_refresh', type: 'fatigue',
        title: `Fatigue risk: ${c.name} (frequency ${c.frequency})`,
        detail: `Average frequency is ${c.frequency} (>3 = the same people are seeing it repeatedly).${trend.ctrDeclining ? ' Account CTR is also trending down.' : ''} Refresh the creative or widen the audience before CPA climbs.`,
        evidence: { frequency: c.frequency, ctrDeclining: trend.ctrDeclining },
      });
    }
  }

  // day-of-week weighting suggestion (only when reliable)
  if (weekday.reliable && weekday.best && weekday.worst && weekday.best.day !== weekday.worst.day) {
    actions.push({
      severity: 'low', sev: 30, scope: 'account', strategy: 'daypart_weight', type: 'pattern',
      title: `Weight budget toward ${weekday.best.day} (best day)`,
      detail: `Over ${dailyDays} days, ${weekday.best.day} has the best ${weekday.metricLabel} (${weekday.best.valueLabel}) vs ${weekday.worst.day} (${weekday.worst.valueLabel}, worst). Gently shift a little budget toward ${weekday.best.day} and trim ${weekday.worst.day} — keep delivery steady; don't hard on/off schedule at this volume or you'll starve learning.`,
      evidence: { best: weekday.best, worst: weekday.worst },
    });
  }

  actions.sort((x, y) => (y.sev - x.sev) || ((y.evidence?.spend || 0) - (x.evidence?.spend || 0)));

  const learningSummary = {
    activeAdsets: activeAdsets.length,
    learningLimited: activeAdsets.filter((a) => a.learningLimited && a.spend > 0).length,
    zeroConversion: activeAdsets.filter((a) => a.status === 'ACTIVE' && a.kpiCount === 0 && a.spend > 0).length,
  };

  // ----- decision-grade digest (today-vs-normal, confidence-gated actions, segments) -----
  let decisions = null;
  try {
    decisions = buildDecisionDigest({
      kpi, totals, campaigns, adsets, medianRoas, medianKpiCpa,
      sortedDaily, campDailyRows, adRankingRows, reachWindows,
      ageGenderRows, placementRows, countryRows, deviceRows,
      weekday, hourly,
      capiDetected: null, // dataset_quality came back empty for this account; surfaced as advisory
    });
  } catch (e) {
    log.warn('strategy.decisions_failed', { error: e?.message || String(e) });
  }

  const digest = {
    window, dailyWindow,
    account: {
      spend: totals.spend, kpi: kpi.label, kpiKind: kpi.kind,
      purchases: totalsAgg.purchases, value: totals.value, roas: totals.roas, cpa: totals.cpa,
      activeCampaigns: activeCampaigns.length, activeAdsets: activeAdsets.length,
      medianRoas: round(medianRoas), medianKpiCpa: round(medianKpiCpa),
    },
    learning: learningSummary,
    patterns: { weekday, hourly, placementTop: placement.best, placementBottom: placement.worst, ageGenderTop: ageGender.best, trend },
    topActions: actions.slice(0, 15).map((a) => ({ severity: a.severity, strategy: a.strategy, type: a.type, scope: a.scope, entity: a.entityName || null, title: a.title, detail: a.detail })),
  };

  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    window, dailyWindow, days,
    elapsedMs: Date.now() - t0,
    kpi,
    totals: { ...totals, frequency: round(div(totalsAgg.impressions, totalsAgg.reach)) },
    medianRoas: round(medianRoas), medianKpiCpa: round(medianKpiCpa),
    counts: { campaigns: campaigns.length, activeCampaigns: activeCampaigns.length, adsets: adsets.length, activeAdsets: activeAdsets.length },
    learning: learningSummary,
    actions,
    patterns: { weekday, hourly, placement, ageGender, trend },
    campaigns: campaigns.sort((a, b) => nz(b.spend) - nz(a.spend)),
    adsets: adsets.sort((a, b) => nz(b.spend) - nz(a.spend)),
    digest,
    decisions,
    narrative: null,
    briefing: null,
  };
  lastAnalysis = result;
  log.info('strategy.analyzed', {
    window, actions: actions.length, learningLimited: learningSummary.learningLimited,
    decisions: decisions?.decisions?.length || 0, actionable: decisions?.counts?.actionable || 0,
    elapsedMs: result.elapsedMs, kpi: kpi.kind,
  });
  return result;
}

export function setNarrative(narrative) {
  if (lastAnalysis) lastAnalysis.narrative = narrative;
  return lastAnalysis;
}

export function setBriefing(briefing) {
  if (lastAnalysis) lastAnalysis.briefing = briefing;
  return lastAnalysis;
}

// ---------- pattern builders ----------

function buildWeekdayPattern(byWeekday, kpi) {
  const rows = byWeekday.map((agg, i) => {
    const events = kpiCount(agg, kpi);
    const cpa = kpiCpa(agg, kpi);
    const roas = div(agg.value, agg.spend);
    return { day: WEEKDAYS[i], spend: round(agg.spend), events, cpa: round(cpa), roas: round(roas) };
  });
  const totalEvents = rows.reduce((s, r) => s + r.events, 0);
  const usable = rows.filter((r) => r.events >= MIN_EVENTS_PER_BUCKET);
  const reliable = totalEvents >= MIN_EVENTS_FOR_PATTERN && usable.length >= 3;
  // rank by ROAS when value exists, else by CPA (lower = better)
  const useRoas = rows.some((r) => r.roas != null && r.roas > 0);
  let best = null; let worst = null; let metricLabel = useRoas ? 'ROAS' : `${kpi.label} cost`;
  if (reliable) {
    const ranked = [...usable].sort((a, b) => (useRoas ? (nz(b.roas) - nz(a.roas)) : (nz(a.cpa) - nz(b.cpa))));
    best = ranked[0]; worst = ranked[ranked.length - 1];
    if (best) best.valueLabel = useRoas ? `ROAS ${best.roas}` : `cost ${fmtMoney(best.cpa)}`;
    if (worst) worst.valueLabel = useRoas ? `ROAS ${worst.roas}` : `cost ${fmtMoney(worst.cpa)}`;
  }
  return { rows, reliable, metricLabel, best, worst, totalEvents };
}

function buildTrend(sortedDaily, kpi) {
  if (sortedDaily.length < 6) return { reliable: false };
  const mid = Math.floor(sortedDaily.length / 2);
  const firstAgg = emptyAgg(); const secondAgg = emptyAgg();
  sortedDaily.slice(0, mid).forEach((d) => addMetrics(firstAgg, d.m));
  sortedDaily.slice(mid).forEach((d) => addMetrics(secondAgg, d.m));
  const f = derive(firstAgg); const s = derive(secondAgg);
  const fCpa = kpiCpa(firstAgg, kpi); const sCpa = kpiCpa(secondAgg, kpi);
  const cpaChange = fCpa && sCpa ? round(((sCpa - fCpa) / fCpa) * 100, 1) : null;
  const ctrChange = f.ctr && s.ctr ? round(((s.ctr - f.ctr) / f.ctr) * 100, 1) : null;
  const roasChange = f.roas && s.roas ? round(((s.roas - f.roas) / f.roas) * 100, 1) : null;
  return {
    reliable: true,
    firstHalf: { cpa: round(fCpa), ctr: f.ctr, roas: f.roas },
    secondHalf: { cpa: round(sCpa), ctr: s.ctr, roas: s.roas },
    cpaChangePct: cpaChange, ctrChangePct: ctrChange, roasChangePct: roasChange,
    ctrDeclining: ctrChange != null && ctrChange < -15,
    cpaRising: cpaChange != null && cpaChange > 20,
  };
}

function buildHourlyPattern(rows, kpi) {
  const buckets = new Map();
  for (const r of rows) {
    const key = r.hourly_stats_aggregated_by_advertiser_time_zone || r.hourly_stats_aggregated_by_audience_time_zone;
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, emptyAgg());
    addMetrics(buckets.get(key), normalizeInsightsRow(r, 'campaign'));
  }
  const list = [...buckets.entries()].map(([hour, agg]) => ({
    hour, spend: round(agg.spend), events: kpiCount(agg, kpi), cpa: round(kpiCpa(agg, kpi)), roas: round(div(agg.value, agg.spend)),
  })).sort((a, b) => (a.hour < b.hour ? -1 : 1));
  const totalEvents = list.reduce((s, r) => s + r.events, 0);
  const usable = list.filter((r) => r.events >= MIN_EVENTS_PER_BUCKET);
  const reliable = totalEvents >= MIN_EVENTS_FOR_PATTERN && usable.length >= 3;
  const useRoas = list.some((r) => r.roas != null && r.roas > 0);
  let best = null; let worst = null;
  if (reliable) {
    const ranked = [...usable].sort((a, b) => (useRoas ? (nz(b.roas) - nz(a.roas)) : (nz(a.cpa) - nz(b.cpa))));
    best = ranked[0]; worst = ranked[ranked.length - 1];
  }
  return { rows: list, reliable, best, worst, totalEvents };
}

function buildSegmentPattern(rows, kpi, labelFn) {
  const buckets = new Map();
  for (const r of rows) {
    const label = labelFn(r);
    if (!buckets.has(label)) buckets.set(label, emptyAgg());
    addMetrics(buckets.get(label), normalizeInsightsRow(r, 'campaign'));
  }
  const list = [...buckets.entries()].map(([label, agg]) => ({
    label, spend: round(agg.spend), events: kpiCount(agg, kpi), cpa: round(kpiCpa(agg, kpi)), roas: round(div(agg.value, agg.spend)),
  })).filter((r) => r.spend > 0);
  const totalEvents = list.reduce((s, r) => s + r.events, 0);
  const usable = list.filter((r) => r.events >= MIN_EVENTS_PER_BUCKET);
  const reliable = totalEvents >= MIN_EVENTS_FOR_PATTERN && usable.length >= 2;
  const useRoas = list.some((r) => r.roas != null && r.roas > 0);
  let best = null; let worst = null;
  if (reliable) {
    const ranked = [...usable].sort((a, b) => (useRoas ? (nz(b.roas) - nz(a.roas)) : (nz(a.cpa) - nz(b.cpa))));
    best = ranked[0]; worst = ranked[ranked.length - 1];
  }
  list.sort((a, b) => nz(b.spend) - nz(a.spend));
  return { rows: list.slice(0, 12), reliable, best, worst, totalEvents };
}
