import { fb } from './fbClient.js';
import { config } from './env.js';
import { log } from './logger.js';
import { getLastAnalysis, analyzeStrategy } from './strategist.js';
import { getBreakdowns as adGetBreakdowns, getActivities as adGetActivities, getAdPreview as adGetPreview, BREAKDOWN_PRESETS } from './adManager.js';
import { INSIGHTS_FIELDS, normalizeInsightsRow } from './insights.js';

// ============================================================================
// Tier 1 READ-ONLY tools for the conversational advisor.
//
// These let the AI FETCH what it needs mid-chat instead of being limited to the
// snapshot it was handed. Every tool here is read-only and safe to auto-run (no
// approval needed) — it never writes to Meta. Write tools (duplicate, budget,
// pause) are Tier 2 and will be gated behind per-action operator approval.
//
// The LLM (analyzer.js) emits OpenRouter function calls; server.js injects
// STRATEGY_TOOLS (the JSON schema) + runStrategyTool (the executor) into the
// chat orchestrator. This module is the ONLY place that turns a tool name +
// args into a real Meta read.
// ============================================================================

const nz = (n) => (Number.isFinite(n) ? n : 0);
const div = (a, b) => (b > 0 ? a / b : null);
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

const VALID_WINDOWS = new Set(['last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d']);
const VALID_BREAKDOWNS = new Set(['none', ...Object.keys(BREAKDOWN_PRESETS)]);

// ---------- tool schema (OpenRouter / OpenAI function-calling format) ----------

export const STRATEGY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_fresh_insights',
      description: 'Fetch LIVE performance metrics from Meta for the account, a campaign, or an ad set — newer than the cached snapshot. Use this whenever the operator asks about current numbers, a specific entity, or a breakdown (e.g. "how is men vs women doing this week", "Portugal\'s last-7d CPA"). Returns spend, conversions, CPA, ROAS, CPM, CTR, frequency (and per-segment rows when a breakdown is given).',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['account', 'campaign', 'adset'], description: 'Scope of the pull. Use "account" for the whole account, otherwise name the entity.' },
          name: { type: 'string', description: 'Substring of the campaign or ad set name to pull (case-insensitive). Omit for account-level.' },
          window: { type: 'string', enum: ['last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d'], description: 'Date window. Default last_7d.' },
          breakdown: { type: 'string', enum: ['none', 'age_gender', 'country', 'platform', 'placement', 'device', 'hourly'], description: 'Segment the pull. Default none (totals only).' },
        },
        required: ['level'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_change_history',
      description: 'Fetch the recent CHANGE HISTORY (edits, budget/status/targeting changes, who changed what and when) for the account or a specific entity. Use this to answer "what changed before CPA spiked?" or to check whether a recent edit reset the learning phase.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Substring of a campaign or ad set name to filter to. Omit for the whole account feed.' },
          limit: { type: 'integer', description: 'Max events to return (default 25, max 100).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_ad_preview',
      description: 'Render the ACTUAL creative of an ad (so the operator can see it inline in the chat) and report its placement/format. Use when discussing a creative refresh or critiquing a specific ad. Resolve the ad by a substring of its name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Substring of the ad name to preview (case-insensitive).' },
          format: { type: 'string', enum: ['DESKTOP_FEED_STANDARD', 'MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'FACEBOOK_STORY_MOBILE'], description: 'Preview format. Default MOBILE_FEED_STANDARD.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 're_analyze',
      description: 'Re-run the full account analysis for a window so the snapshot is fresh (re-pulls all campaigns, ad sets, segments, decisions). Use when the operator wants the very latest read or asks you to "refresh" / "re-check today". Slower than get_fresh_insights — prefer get_fresh_insights for a single entity.',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'string', enum: ['last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d'], description: 'Window to analyze. Default last_30d.' },
        },
      },
    },
  },
];

// ---------- helpers ----------

function resolveEntity(name, preferLevel) {
  const last = getLastAnalysis();
  if (!last || !name) return null;
  const needle = String(name).toLowerCase().trim();
  if (!needle) return null;
  const camps = Array.isArray(last.campaigns) ? last.campaigns : [];
  const sets = Array.isArray(last.adsets) ? last.adsets : [];
  const matchIn = (arr, level) => {
    const exact = arr.find((e) => (e.name || '').toLowerCase() === needle);
    if (exact) return { level, id: exact.id, name: exact.name };
    const partial = arr.filter((e) => (e.name || '').toLowerCase().includes(needle));
    if (partial.length) {
      partial.sort((a, b) => nz(b.spend) - nz(a.spend));
      return { level, id: partial[0].id, name: partial[0].name, ambiguous: partial.length > 1 };
    }
    return null;
  };
  if (preferLevel === 'adset') return matchIn(sets, 'adset') || matchIn(camps, 'campaign');
  if (preferLevel === 'campaign') return matchIn(camps, 'campaign') || matchIn(sets, 'adset');
  return matchIn(camps, 'campaign') || matchIn(sets, 'adset');
}

function summarizeTotals(rows, level) {
  const agg = { spend: 0, purchases: 0, value: 0, impressions: 0, reach: 0, linkClicks: 0, lpv: 0 };
  for (const r of rows) {
    const m = normalizeInsightsRow(r, level === 'account' ? 'campaign' : level);
    agg.spend += nz(m.spend);
    agg.purchases += nz(m.purchasesTotal);
    agg.value += nz(m.purchaseValueTotal);
    agg.impressions += nz(m.impressions);
    agg.reach += nz(m.reach);
    agg.linkClicks += nz(m.linkClicks);
    agg.lpv += nz(m.landingPageViewsTotal);
  }
  const conv = agg.purchases || agg.lpv || agg.linkClicks;
  const convLabel = agg.purchases ? 'purchases' : (agg.lpv ? 'landing-page views' : 'link clicks');
  return {
    spend: round(agg.spend),
    [convLabel === 'purchases' ? 'purchases' : 'conversions']: round(conv),
    conversion_metric: convLabel,
    cpa: round(div(agg.spend, conv)),
    roas: agg.value ? round(div(agg.value, agg.spend)) : null,
    value: agg.value ? round(agg.value) : null,
    impressions: agg.impressions,
    reach: agg.reach,
    cpm: round(div(agg.spend, agg.impressions) * 1000),
    ctr_pct: round(div(agg.linkClicks, agg.impressions) * 100, 3),
    frequency: round(div(agg.impressions, agg.reach)),
  };
}

// ---------- executors ----------

async function getFreshInsights(args) {
  const window = VALID_WINDOWS.has(args.window) ? args.window : 'last_7d';
  const breakdown = VALID_BREAKDOWNS.has(args.breakdown) ? args.breakdown : 'none';
  let level = ['account', 'campaign', 'adset'].includes(args.level) ? args.level : (args.name ? 'campaign' : 'account');

  let targetId = config.primaryAccountId;
  let targetName = 'whole account';
  if (level !== 'account' && args.name) {
    const ent = resolveEntity(args.name, level);
    if (!ent) return { ok: false, error: 'entity_not_found', message: `No campaign or ad set matching "${args.name}" in the current snapshot. Check the name, or re-analyze first.` };
    level = ent.level; targetId = ent.id; targetName = ent.name + (ent.ambiguous ? ' (closest match)' : '');
  } else {
    level = 'account';
  }

  if (breakdown !== 'none') {
    const preset = BREAKDOWN_PRESETS[breakdown];
    if (level === 'account') {
      const res = await fb.get(`/${targetId}/insights`, {
        fields: 'spend,impressions,reach,clicks,ctr,cpc,cpm,actions,action_values',
        breakdowns: preset, date_preset: window, limit: 300,
      }, 'GET:/strategy-tool/insights-breakdown');
      if (!res.ok) return { ok: false, error: 'fetch_failed', message: res.message || 'Meta read failed.' };
      const dims = preset.split(',');
      const rows = (res.body?.data || []).map((r) => {
        const m = normalizeInsightsRow(r, 'campaign');
        const conv = nz(m.purchasesTotal) || nz(m.landingPageViewsTotal) || nz(m.linkClicks);
        const seg = dims.map((d) => r[d] ?? '—').join(' · ');
        return { segment: seg, spend: round(nz(m.spend)), conversions: conv, cpa: round(div(nz(m.spend), conv)), roas: m.purchaseValueTotal ? round(div(nz(m.purchaseValueTotal), nz(m.spend))) : null, cpm: round(m.cpm), impressions: nz(m.impressions) };
      }).filter((r) => r.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 14);
      return { ok: true, entity: targetName, level, window, breakdown, rows };
    }
    const res = await adGetBreakdowns({ level, id: targetId, datePreset: window, breakdown });
    if (!res.ok) return { ok: false, error: 'fetch_failed', message: res.message || 'Meta read failed.' };
    const rows = (res.rows || []).map((r) => ({
      segment: res.dims.map((d) => r[d] ?? '—').join(' · '),
      spend: round(r.spend), conversions: r.purchases, cpa: round(div(r.spend, r.purchases)),
      roas: r.roas != null ? round(r.roas) : null, cpm: round(r.cpm), impressions: r.impressions,
    })).filter((r) => r.spend > 0).slice(0, 14);
    return { ok: true, entity: targetName, level, window, breakdown, rows };
  }

  // totals only
  const res = await fb.get(`/${targetId}/insights`, {
    fields: INSIGHTS_FIELDS, date_preset: window, limit: 1,
  }, 'GET:/strategy-tool/insights');
  if (!res.ok) return { ok: false, error: 'fetch_failed', message: res.message || 'Meta read failed.' };
  const rows = res.body?.data || [];
  if (!rows.length) return { ok: true, entity: targetName, level, window, totals: null, note: 'No spend in this window.' };
  return { ok: true, entity: targetName, level, window, totals: summarizeTotals(rows, level) };
}

async function getChangeHistory(args) {
  let id = null; let scope = 'whole account';
  if (args.name) {
    const ent = resolveEntity(args.name);
    if (!ent) return { ok: false, error: 'entity_not_found', message: `No campaign or ad set matching "${args.name}".` };
    id = ent.id; scope = ent.name;
  }
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 25));
  const res = await adGetActivities({ id, limit: id ? 200 : limit });
  if (!res.ok) return { ok: false, error: 'fetch_failed', message: res.message || 'Meta read failed.' };
  const rows = (res.rows || []).slice(0, limit).map((r) => ({
    when: r.time, change: r.label, by: r.actor, entity: r.object_name || r.object_id,
    detail: r.extra && typeof r.extra === 'object'
      ? Object.entries(r.extra).slice(0, 4).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; ')
      : (typeof r.extra === 'string' ? r.extra.slice(0, 160) : null),
  }));
  return { ok: true, scope, count: rows.length, changes: rows };
}

async function getAdPreviewTool(args) {
  if (!args.name) return { ok: false, error: 'missing_name', message: 'Provide a substring of the ad name to preview.' };
  const needle = String(args.name).toLowerCase().trim();
  // The snapshot doesn't carry ad IDs, so resolve via a single account ads read.
  const res = await fb.get(`/${config.primaryAccountId}/ads`, {
    fields: 'id,name,effective_status,adset{name},campaign{name}', limit: 400,
  }, 'GET:/strategy-tool/ads');
  if (!res.ok) return { ok: false, error: 'fetch_failed', message: res.message || 'Could not list ads.' };
  const ads = res.body?.data || [];
  const exact = ads.find((a) => (a.name || '').toLowerCase() === needle);
  const matches = exact ? [exact] : ads.filter((a) => (a.name || '').toLowerCase().includes(needle));
  if (!matches.length) return { ok: false, error: 'ad_not_found', message: `No ad name contains "${args.name}".` };
  matches.sort((a, b) => (a.effective_status === 'ACTIVE' ? -1 : 1));
  const ad = matches[0];
  const format = ['DESKTOP_FEED_STANDARD', 'MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'FACEBOOK_STORY_MOBILE'].includes(args.format) ? args.format : 'MOBILE_FEED_STANDARD';
  const prev = await adGetPreview({ adId: ad.id, adFormat: format });
  if (!prev.ok) return { ok: false, error: 'preview_failed', message: prev.message || 'Meta returned no preview.' };
  return {
    ok: true, adName: ad.name, status: ad.effective_status,
    campaign: ad.campaign?.name || null, adset: ad.adset?.name || null,
    format, iframe: prev.iframe,
    note: 'The creative preview is now shown inline to the operator. You cannot see the image; describe what to check (hook, first 3s, offer clarity) and ask the operator what it shows if needed.',
  };
}

async function reAnalyze(args) {
  const window = VALID_WINDOWS.has(args.window) ? args.window : 'last_30d';
  const res = await analyzeStrategy({ window });
  if (!res.ok) return { ok: false, error: 'analyze_failed', message: res.message || 'Re-analysis failed.' };
  return {
    ok: true, window, refreshed: true,
    totals: res.totals, kpi: res.kpi?.label,
    counts: res.counts, medianKpiCpa: res.medianKpiCpa, medianRoas: res.medianRoas,
    note: 'Snapshot refreshed. Use get_fresh_insights for any specific entity; the next message will be grounded on this new snapshot.',
  };
}

const EXECUTORS = {
  get_fresh_insights: getFreshInsights,
  get_change_history: getChangeHistory,
  get_ad_preview: getAdPreviewTool,
  re_analyze: reAnalyze,
};

// Caps the JSON that goes back into the model context (keeps the prompt lean).
function capResult(result, max = 3500) {
  let s;
  try { s = JSON.stringify(result); } catch { return '{"ok":false,"error":"unserializable"}'; }
  if (s.length <= max) return s;
  // iframe blobs are huge and useless to the model — drop before truncating.
  if (result && typeof result === 'object' && result.iframe) {
    const { iframe, ...rest } = result;
    s = JSON.stringify({ ...rest, iframe: '[shown to operator, omitted from model context]' });
    if (s.length <= max) return s;
  }
  return s.slice(0, max) + '…(truncated)';
}

export async function runStrategyTool(name, args) {
  const fn = EXECUTORS[name];
  const t0 = Date.now();
  if (!fn) {
    log.warn('strategy.tool.unknown', { name });
    return { result: { ok: false, error: 'unknown_tool', message: `No tool named ${name}.` }, content: `{"ok":false,"error":"unknown_tool:${name}"}` };
  }
  try {
    const result = await fn(args || {});
    log.info('strategy.tool.ok', { name, args: JSON.stringify(args || {}).slice(0, 200), ok: result?.ok !== false, elapsedMs: Date.now() - t0 });
    return { result, content: capResult(result) };
  } catch (err) {
    log.warn('strategy.tool.failed', { name, error: String(err.message || err), elapsedMs: Date.now() - t0 });
    const result = { ok: false, error: 'tool_error', message: String(err.message || err) };
    return { result, content: JSON.stringify(result) };
  }
}
