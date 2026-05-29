import { fb } from './fbClient.js';
import { config } from './env.js';
import { log } from './logger.js';
import { getLastAnalysis, analyzeStrategy } from './strategist.js';
import { getBreakdowns as adGetBreakdowns, getActivities as adGetActivities, getAdPreview as adGetPreview, setStatus as adSetStatus, setBudget as adSetBudget, duplicate as adDuplicate, BREAKDOWN_PRESETS } from './adManager.js';
import { INSIGHTS_FIELDS, normalizeInsightsRow } from './insights.js';
import { store } from './store.js';

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

const VALID_WINDOWS = new Set(['today', 'yesterday', 'last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d']);
const ANALYZE_WINDOWS = new Set(['last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d']);
const VALID_BREAKDOWNS = new Set(['none', ...Object.keys(BREAKDOWN_PRESETS)]);

// Tier 2 = write tools. They never execute inside the chat — they build an approval PROPOSAL the
// operator must approve. Execution happens later via executeStrategyWrite (gated by
// FB_ALLOW_ADVISOR_WRITES + adManager's own allowAdManagement/rate guards).
const WRITE_TOOLS = new Set(['pause_entity', 'resume_entity', 'set_budget', 'duplicate_entity']);

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
          name: { type: 'string', description: 'Substring of the campaign or ad set name to pull (case-insensitive). Map the operator\'s words to a real entity name from the snapshot — e.g. "the French campaign" -> the campaign whose name contains "France". Omit for account-level.' },
          window: { type: 'string', enum: ['today', 'yesterday', 'last_7d', 'last_14d', 'last_28d', 'last_30d', 'last_90d'], description: 'Date window. Map natural language: "yesterday" -> yesterday, "this week" -> last_7d. Default last_7d.' },
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
  // ---------- Tier 2: WRITE tools (propose-only; operator must approve before anything executes) ----------
  {
    type: 'function',
    function: {
      name: 'pause_entity',
      description: 'PROPOSE turning OFF (pausing) a campaign or ad set. This does NOT execute — it creates an approval request the operator must confirm. Use when a confident decision says to stop a loser. Resolve by name substring.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['campaign', 'adset'], description: 'campaign or adset' },
          name: { type: 'string', description: 'Substring of the entity name to pause.' },
          reason: { type: 'string', description: 'Short why (shown to the operator on the approval card).' },
        },
        required: ['level', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_entity',
      description: 'PROPOSE turning ON (activating) a paused campaign or ad set. Propose-only; needs operator approval. Resolve by name substring.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['campaign', 'adset'], description: 'campaign or adset' },
          name: { type: 'string', description: 'Substring of the entity name to activate.' },
          reason: { type: 'string', description: 'Short why (shown on the approval card).' },
        },
        required: ['level', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_budget',
      description: 'PROPOSE a new DAILY budget for an ad set (or a CBO campaign). Propose-only; needs operator approval. Keep the change within ~20% of the current budget per the playbook (bigger jumps reset learning). For this all-ABO account, target the AD SET, not the campaign. Resolve by name substring.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['adset', 'campaign'], description: 'Usually adset for this account (ABO).' },
          name: { type: 'string', description: 'Substring of the ad set / campaign name.' },
          daily_budget: { type: 'number', description: 'New daily budget in the account currency units (e.g. 120 = $120/day). NOT cents.' },
          reason: { type: 'string', description: 'Short why (shown on the approval card).' },
        },
        required: ['level', 'name', 'daily_budget'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'duplicate_entity',
      description: 'PROPOSE duplicating a campaign or ad set into a PAUSED copy (the source is never touched). Propose-only; needs operator approval. Use for surf-scaling / testing a cost cap on a copy. Resolve by name substring.',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['campaign', 'adset'], description: 'campaign or adset' },
          name: { type: 'string', description: 'Substring of the entity name to duplicate.' },
          reason: { type: 'string', description: 'Short why (shown on the approval card).' },
        },
        required: ['level', 'name'],
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
  const window = ANALYZE_WINDOWS.has(args.window) ? args.window : 'last_30d';
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

// ---------- Tier 2 write tools: build an approval PROPOSAL (no execution) ----------

let approvalSeq = 0;
const newApprovalId = () => `appr_${Date.now().toString(36)}_${(approvalSeq += 1)}`;

// Resolve a write target strictly (write tools must hit the RIGHT entity). Returns the snapshot
// entity object too, so the proposal can show current status/budget.
function resolveWriteTarget(level, name) {
  const last = getLastAnalysis();
  if (!last) return { error: 'no_analysis', message: 'Run an analysis first.' };
  const arr = level === 'adset' ? (last.adsets || []) : (last.campaigns || []);
  const needle = String(name || '').toLowerCase().trim();
  if (!needle) return { error: 'missing_name', message: 'Provide the entity name.' };
  const exact = arr.find((e) => (e.name || '').toLowerCase() === needle);
  const matches = exact ? [exact] : arr.filter((e) => (e.name || '').toLowerCase().includes(needle));
  if (!matches.length) return { error: 'entity_not_found', message: `No ${level} matching "${name}" in the snapshot.` };
  matches.sort((a, b) => nz(b.spend) - nz(a.spend));
  return { entity: matches[0], ambiguous: matches.length > 1 };
}

function proposePause(args, toActive) {
  const level = args.level === 'adset' ? 'adset' : 'campaign';
  const r = resolveWriteTarget(level, args.name);
  if (r.error) return { ok: false, error: r.error, message: r.message };
  const e = r.entity;
  const cur = e.status || 'UNKNOWN';
  const want = toActive ? 'ACTIVE' : 'PAUSED';
  if (cur === want) return { ok: false, error: 'no_change', message: `${e.name} is already ${want}.` };
  return {
    ok: true,
    approval: {
      id: newApprovalId(), tool: toActive ? 'resume_entity' : 'pause_entity',
      action: toActive ? 'Resume (turn ON)' : 'Pause (turn OFF)',
      level, entityId: e.id, entityName: e.name + (r.ambiguous ? ' (closest match)' : ''),
      current: { status: cur }, change: { field: 'status', from: cur, to: want },
      risk: toActive ? 'medium' : 'destructive',
      reason: (args.reason || '').toString().slice(0, 300),
      summary: `${toActive ? 'Activate' : 'Pause'} ${level} "${e.name}" (currently ${cur})`,
      args: { level, id: e.id, name: e.name, status: want },
      warning: toActive ? 'Activating restarts spend immediately.' : 'Pausing stops delivery immediately and can reset learning when re-enabled.',
    },
  };
}

function proposeSetBudget(args) {
  const level = args.level === 'campaign' ? 'campaign' : 'adset';
  const dollars = Number(args.daily_budget);
  if (!Number.isFinite(dollars) || dollars <= 0) return { ok: false, error: 'invalid_budget', message: 'daily_budget must be a positive number (account currency, not cents).' };
  const r = resolveWriteTarget(level, args.name);
  if (r.error) return { ok: false, error: r.error, message: r.message };
  const e = r.entity;
  if (level === 'campaign' && e.isCBO === false) {
    return { ok: false, error: 'abo_campaign', message: `"${e.name}" is an ABO campaign — budget lives on its ad sets. Propose set_budget on the AD SET instead.` };
  }
  const curDaily = e.dailyBudget != null ? Number(e.dailyBudget) : null;
  const changePct = curDaily ? round(((dollars - curDaily) / curDaily) * 100, 1) : null;
  let warning = 'Meta limits ~4 budget edits/hour/entity; bigger than ~20% jumps reset the learning phase.';
  if (changePct != null && Math.abs(changePct) > 20) warning = `This is a ${changePct > 0 ? '+' : ''}${changePct}% change — over the ~20% the playbook recommends; it will likely reset learning. ` + warning;
  return {
    ok: true,
    approval: {
      id: newApprovalId(), tool: 'set_budget', action: 'Set daily budget',
      level, entityId: e.id, entityName: e.name + (r.ambiguous ? ' (closest match)' : ''),
      current: { dailyBudget: curDaily }, change: { field: 'daily_budget', from: curDaily != null ? `$${curDaily}/day` : 'unknown', to: `$${dollars}/day`, pct: changePct },
      risk: (changePct != null && Math.abs(changePct) > 20) ? 'high' : 'medium',
      reason: (args.reason || '').toString().slice(0, 300),
      summary: `Set ${level} "${e.name}" daily budget to $${dollars}/day${curDaily != null ? ` (from $${curDaily})` : ''}`,
      args: { level, id: e.id, name: e.name, daily_budget: dollars },
      warning,
    },
  };
}

function proposeDuplicate(args) {
  const level = args.level === 'adset' ? 'adset' : 'campaign';
  const r = resolveWriteTarget(level, args.name);
  if (r.error) return { ok: false, error: r.error, message: r.message };
  const e = r.entity;
  return {
    ok: true,
    approval: {
      id: newApprovalId(), tool: 'duplicate_entity', action: 'Duplicate (paused copy)',
      level, entityId: e.id, entityName: e.name + (r.ambiguous ? ' (closest match)' : ''),
      current: { status: e.status || null }, change: { field: 'duplicate', from: e.name, to: `${e.name} - Copy (PAUSED)` },
      risk: 'low',
      reason: (args.reason || '').toString().slice(0, 300),
      summary: `Duplicate ${level} "${e.name}" into a new PAUSED copy (source untouched)`,
      args: { level, id: e.id, name: e.name, deep_copy: true },
      warning: 'Creates a PAUSED copy. The original is never modified. You turn the copy on yourself.',
    },
  };
}

const PROPOSERS = {
  pause_entity: (a) => proposePause(a, false),
  resume_entity: (a) => proposePause(a, true),
  set_budget: proposeSetBudget,
  duplicate_entity: proposeDuplicate,
};

// ---------- Tier 2 EXECUTION (only after operator approval; gated) ----------

export function advisorWritesEnabled() { return config.allowAdvisorWrites === true; }

export function isWriteTool(name) { return WRITE_TOOLS.has(name); }

// Executes a previously-approved write. Re-validates the entity still exists (drift guard) and
// runs through adManager (which enforces allowAdManagement + the budget rate guard + audit log).
export async function executeStrategyWrite(name, args = {}) {
  if (!WRITE_TOOLS.has(name)) return { ok: false, error: 'not_a_write_tool', message: `${name} is not an approvable write.` };
  if (!config.allowAdvisorWrites) {
    return { ok: false, error: 'advisor_writes_disabled', message: 'Advisor writes are disabled. Set FB_ALLOW_ADVISOR_WRITES=1 and restart to let approvals execute. (Nothing was sent to Meta.)' };
  }
  const level = args.level === 'adset' ? 'adset' : 'campaign';
  const id = (args.id || '').toString();
  if (!id) return { ok: false, error: 'missing_id', message: 'Approved action is missing the entity id.' };
  // Drift guard: the entity must still exist in our store; surface its current value.
  const ent = store.getEntity(level, id);
  if (!ent) return { ok: false, error: 'entity_gone', message: 'That entity is no longer in the local snapshot — re-analyze and re-propose before approving.' };

  const t0 = Date.now();
  let result;
  if (name === 'pause_entity') result = await adSetStatus({ level, id, status: 'PAUSED' });
  else if (name === 'resume_entity') result = await adSetStatus({ level, id, status: 'ACTIVE' });
  else if (name === 'set_budget') result = await adSetBudget({ level, id, dailyBudget: Math.round(Number(args.daily_budget) * 100) });
  else if (name === 'duplicate_entity') result = await adDuplicate({ level, id, deepCopy: args.deep_copy !== false });
  else return { ok: false, error: 'unknown_write', message: name };

  log.info('strategy.write.executed', { name, level, id, ok: result?.ok === true, blocked: !!result?.blocked, elapsedMs: Date.now() - t0 });
  return result;
}

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
  const t0 = Date.now();

  // Write tools never execute here — they build an approval proposal. If the proposal can't be
  // built (e.g. entity not found / no-op), it is returned as a normal tool result so the model can
  // react and rephrase (denial-as-feedback), without surfacing an approval card.
  if (WRITE_TOOLS.has(name)) {
    try {
      const prop = PROPOSERS[name](args || {});
      if (prop.ok) {
        log.info('strategy.tool.proposed', { name, entity: prop.approval.entityName, risk: prop.approval.risk });
        const result = { ok: true, proposed: true, approval: prop.approval };
        // Tell the model the proposal is staged; it should stop and let the operator decide.
        const content = JSON.stringify({ ok: true, proposed_for_approval: true, action: prop.approval.summary });
        return { result, content, approval: prop.approval };
      }
      log.info('strategy.tool.propose_rejected', { name, error: prop.error, elapsedMs: Date.now() - t0 });
      const result = { ok: false, error: prop.error, message: prop.message };
      return { result, content: JSON.stringify(result) };
    } catch (err) {
      log.warn('strategy.tool.propose_failed', { name, error: String(err.message || err) });
      const result = { ok: false, error: 'propose_error', message: String(err.message || err) };
      return { result, content: JSON.stringify(result) };
    }
  }

  const fn = EXECUTORS[name];
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
