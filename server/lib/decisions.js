import { normalizeInsightsRow } from './insights.js';
import {
  nz, round, mean, stdev, pctChange, zScore,
  cpaWithCI, sampleConfidence, segmentVsBaseline, decisionConfidence,
} from './stats.js';

// Decision engine: turns the raw read snapshot into CONFIDENCE-GATED, suggest-only judgments.
// Core principle (from the research): never act on one day's fluctuation. Every verdict carries
// a confidence tier driven by conversion sample size + persistence (how many recent days the
// signal held) + a day-of-week-adjusted baseline, plus an explicit "what to wait for" when the
// data isn't yet conclusive.

const LEARNING_EVENTS_PER_WEEK = 50;
const CPA_KILL_MULT = 1.5;        // CPA this far above the account median = stop-loss candidate
const CPA_SCALE_MULT = 0.8;       // CPA this far below median = scale candidate
const ROAS_SCALE_MULT = 1.2;      // ROAS this far above median = scale candidate
const FREQ_FATIGUE = 3;           // average frequency above this = fatigue risk
const MIN_CONV_TO_JUDGE = 15;     // below this, a CPA/ROAS verdict is "watch, not act"

// ranking string → how bad (lower percentile = worse). Bottom 10% is the worst tier.
const RANK_SEVERITY = {
  BELOW_AVERAGE_10: { sev: 'high', pct: 'bottom 10%' },
  BELOW_AVERAGE_20: { sev: 'high', pct: 'bottom 20%' },
  BELOW_AVERAGE_35: { sev: 'medium', pct: 'bottom 35%' },
};

function kpiCount(m, kpi) {
  if (kpi.kind === 'purchase') return nz(m.purchasesTotal);
  if (kpi.kind === 'landing_page_view') return nz(m.landingPageViewsTotal);
  if (kpi.kind === 'add_to_cart') return nz(m.atcTotal);
  return nz(m.linkClicks || m.inlineLinkClicks);
}

function aggDaily(rows, kpi) {
  const a = { spend: 0, kpi: 0, value: 0, impressions: 0, reach: 0, clicks: 0, days: rows.length };
  for (const r of rows) {
    const m = r.m || r;
    a.spend += nz(m.spend); a.kpi += kpiCount(m, kpi); a.value += nz(m.purchaseValueTotal);
    a.impressions += nz(m.impressions); a.reach += nz(m.reach); a.clicks += nz(m.inlineLinkClicks);
  }
  a.cpa = a.kpi > 0 ? round(a.spend / a.kpi) : null;
  a.roas = a.spend > 0 && a.value > 0 ? round(a.value / a.spend) : null;
  a.ctr = a.impressions > 0 ? round((a.clicks / a.impressions) * 100, 3) : null;
  a.cpm = a.impressions > 0 ? round((a.spend / a.impressions) * 1000) : null;
  return a;
}

// ---------- account: today vs day-of-week-adjusted normal ----------

function buildToday(sortedDaily, kpi) {
  const todayUTC = new Date().toISOString().slice(0, 10);
  const completes = sortedDaily.filter((d) => d.date < todayUTC);
  if (completes.length < 8) return { reliable: false, note: 'Not enough history yet for a day-of-week baseline.' };

  const latest = completes[completes.length - 1];
  const wd = new Date(`${latest.date}T00:00:00Z`).getUTCDay();
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const sameWd = completes.filter((d) => new Date(`${d.date}T00:00:00Z`).getUTCDay() === wd && d.date !== latest.date);

  const todaySpend = nz(latest.m.spend);
  const todayConv = kpiCount(latest.m, kpi);
  const todayCpa = todayConv > 0 ? todaySpend / todayConv : null;
  const todayRoas = todaySpend > 0 && nz(latest.m.purchaseValueTotal) > 0 ? nz(latest.m.purchaseValueTotal) / todaySpend : null;

  const spendArr = sameWd.map((d) => nz(d.m.spend));
  const cpaArr = sameWd.map((d) => { const c = kpiCount(d.m, kpi); return c > 0 ? nz(d.m.spend) / c : null; }).filter(Number.isFinite);
  const convArr = sameWd.map((d) => kpiCount(d.m, kpi));
  const roasArr = sameWd.map((d) => { const s = nz(d.m.spend); const v = nz(d.m.purchaseValueTotal); return s > 0 && v > 0 ? v / s : null; }).filter(Number.isFinite);

  const reliable = sameWd.length >= 3;
  const out = {
    reliable, day: latest.date, weekday: WEEKDAYS[wd], nSameWeekday: sameWd.length,
    metrics: { spend: round(todaySpend), conv: todayConv, cpa: round(todayCpa), roas: round(todayRoas) },
    baseline: {
      spend: round(mean(spendArr)), conv: round(mean(convArr), 1),
      cpa: round(mean(cpaArr)), roas: round(mean(roasArr)),
    },
    z: {
      spend: zScore(todaySpend, mean(spendArr), stdev(spendArr)),
      conv: zScore(todayConv, mean(convArr), stdev(convArr)),
      cpa: todayCpa != null ? zScore(todayCpa, mean(cpaArr), stdev(cpaArr)) : null,
    },
  };
  // verdict: only call something "off" when it's >2 SD from same-weekday normal
  const flags = [];
  if (Number.isFinite(out.z.cpa) && out.z.cpa >= 2) flags.push(`CPA is ${out.z.cpa}σ above a normal ${out.weekday}`);
  if (Number.isFinite(out.z.cpa) && out.z.cpa <= -2) flags.push(`CPA is ${Math.abs(out.z.cpa)}σ below normal (cheaper than usual)`);
  if (Number.isFinite(out.z.conv) && out.z.conv <= -2) flags.push(`conversions are ${Math.abs(out.z.conv)}σ below a normal ${out.weekday}`);
  if (Number.isFinite(out.z.spend) && Math.abs(out.z.spend) >= 2) flags.push(`spend is ${out.z.spend}σ from normal`);
  out.verdict = flags.length ? 'anomalous' : 'normal';
  out.flags = flags;
  out.note = reliable
    ? (flags.length ? `Latest complete day (${out.weekday}) is unusual: ${flags.join('; ')}.` : `Latest complete day (${out.weekday}) is within the normal range for that weekday.`)
    : `Only ${sameWd.length} prior ${out.weekday}s on record — treat the comparison as directional.`;
  return out;
}

function buildTrend7(sortedDaily, kpi) {
  const todayUTC = new Date().toISOString().slice(0, 10);
  const completes = sortedDaily.filter((d) => d.date < todayUTC);
  if (completes.length < 14) return { reliable: false };
  const last7 = aggDaily(completes.slice(-7), kpi);
  const prior7 = aggDaily(completes.slice(-14, -7), kpi);
  const cpmChange = pctChange(prior7.cpm, last7.cpm);
  const ctrChange = pctChange(prior7.ctr, last7.ctr);
  // Earliest saturation tell (per playbook): CPM rising while CTR flat/holding precedes the CPA spike.
  const earlySaturation = cpmChange != null && cpmChange >= 15 && (ctrChange == null || ctrChange > -10);
  return {
    reliable: true,
    last7: { spend: round(last7.spend), conv: last7.kpi, cpa: last7.cpa, roas: last7.roas, ctr: last7.ctr, cpm: last7.cpm },
    prior7: { spend: round(prior7.spend), conv: prior7.kpi, cpa: prior7.cpa, roas: prior7.roas, ctr: prior7.ctr, cpm: prior7.cpm },
    cpaChangePct: pctChange(prior7.cpa, last7.cpa),
    roasChangePct: pctChange(prior7.roas, last7.roas),
    ctrChangePct: ctrChange,
    cpmChangePct: cpmChange,
    convChangePct: pctChange(prior7.kpi, last7.kpi),
    earlySaturation,
    note: earlySaturation ? 'CPM is rising while CTR holds — the earliest saturation signal, before CPA visibly spikes. Watch frequency and queue a creative refresh.' : null,
  };
}

// Concentration risk (per playbook counter-point): one campaign carrying too much of account spend
// is one fatigue cycle from a step-function "saturation cliff". Flag when any active campaign >40%.
function buildConcentration(campaigns) {
  const active = campaigns.filter((c) => c.status === 'ACTIVE' && nz(c.spend) > 0);
  const total = active.reduce((s, c) => s + nz(c.spend), 0);
  if (total <= 0 || !active.length) return { reliable: false };
  const top = [...active].sort((a, b) => nz(b.spend) - nz(a.spend))[0];
  const share = round((nz(top.spend) / total) * 100, 1);
  return {
    reliable: true, topName: top.name, topShare: share, activeCount: active.length,
    verdict: share >= 40 ? 'concentrated' : 'diversified',
    note: share >= 40
      ? `${top.name} carries ${share}% of active spend. That concentration is efficient but fragile — one fatigue cycle can take the account down. Build the next 2-3 winners in parallel and cap any single campaign near ~40% of spend.`
      : `Spend is spread across ${active.length} active campaigns (top = ${share}%). Healthy diversification against creative fatigue.`,
  };
}

// ---------- saturation / net-new-reach ----------

function buildSaturation(reach) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const this30 = num(reach?.this30?.reach);
  const prior30 = num(reach?.prior30?.reach);
  const comb60 = num(reach?.combined60?.reach);
  const freq = round(Number(reach?.this30?.frequency));
  if (!this30 || !comb60) return { reliable: false, note: 'Reach data unavailable.' };
  const newThis = Math.max(0, comb60 - prior30);          // people reached this month not reached last month
  const nnrPct = this30 > 0 ? round((newThis / this30) * 100, 1) : null;
  let verdict = 'healthy';
  if (nnrPct != null && nnrPct < 40) verdict = 'saturating';
  else if (nnrPct != null && nnrPct < 60) verdict = 'watch';
  if (Number.isFinite(freq) && freq >= 4) verdict = 'saturating';
  return {
    reliable: true, reachThis30: this30, reachPrior30: prior30, reachCombined60: comb60,
    netNewReachPct: nnrPct, frequency: freq, verdict,
    note: verdict === 'healthy'
      ? `${nnrPct}% of this month's reach is brand-new people (freq ${freq}). Plenty of fresh audience — saturation is not the bottleneck.`
      : verdict === 'watch'
        ? `Only ${nnrPct}% of reach is new people (freq ${freq}). Audience is starting to repeat — watch frequency and refresh creative soon.`
        : `Just ${nnrPct}% net-new reach with frequency ${freq}. The same people are seeing ads repeatedly — refresh creative or widen the audience before CPA climbs.`,
  };
}

// ---------- creative health (ranking diagnostics) ----------

function buildCreative(adRankingRows, kpi) {
  const flagged = [];
  for (const r of adRankingRows) {
    const q = r.quality_ranking;
    const sevInfo = RANK_SEVERITY[q];
    const impr = nz(Number(r.impressions));
    if (!sevInfo || impr < 1000) continue;
    const m = normalizeInsightsRow(r, 'ad');
    const conv = kpiCount(m, kpi);
    flagged.push({
      adName: r.ad_name || r.ad_id, campaignName: r.campaign_name || null, adsetName: r.adset_name || null,
      impressions: impr, frequency: round(Number(r.frequency)),
      quality: q, qualityPct: sevInfo.pct,
      engagement: r.engagement_rate_ranking || 'UNKNOWN', conversion: r.conversion_rate_ranking || 'UNKNOWN',
      spend: round(nz(m.spend)), conv, cpa: conv > 0 ? round(nz(m.spend) / conv) : null,
      severity: sevInfo.sev,
      note: `Quality ranking is ${sevInfo.pct} of competing ads — the creative itself is the weak link. Refresh the hook/visual; this caps CPM and CPA no matter how you bid.`,
    });
  }
  flagged.sort((a, b) => (a.severity === b.severity ? b.spend - a.spend : a.severity === 'high' ? -1 : 1));
  return flagged.slice(0, 12);
}

// ---------- segments (age/gender, placement): opportunities & risks ----------

function buildSegments(rows, kpi, baselineCpa, labelFn) {
  const buckets = new Map();
  let totalSpend = 0; let totalConv = 0;
  for (const r of rows) {
    const label = labelFn(r);
    const m = normalizeInsightsRow(r, 'campaign');
    if (!buckets.has(label)) buckets.set(label, { spend: 0, conv: 0, value: 0 });
    const b = buckets.get(label);
    b.spend += nz(m.spend); b.conv += kpiCount(m, kpi); b.value += nz(m.purchaseValueTotal);
    totalSpend += nz(m.spend); totalConv += kpiCount(m, kpi);
  }
  const list = [];
  for (const [label, b] of buckets) {
    if (b.spend <= 0) continue;
    const v = segmentVsBaseline({ spend: b.spend, conversions: b.conv, baselineCpa });
    list.push({
      label, spend: round(b.spend), conv: b.conv,
      cpa: v.cpa, cpaLo: v.cpaLo, cpaHi: v.cpaHi,
      roas: b.spend > 0 && b.value > 0 ? round(b.value / b.spend) : null,
      verdict: v.verdict, confidence: v.confidence, confidenceScore: v.confidenceScore, lift: v.lift,
      shareSpend: totalSpend > 0 ? round((b.spend / totalSpend) * 100, 1) : null,
      shareConv: totalConv > 0 ? round((b.conv / totalConv) * 100, 1) : null,
    });
  }
  list.sort((a, b) => b.spend - a.spend);
  return list;
}

// ---------- per-entity decisions ----------

function campaignDecisions({ campaigns, campDailyRows, kpi, medianRoas, medianKpiCpa, creativeByCampaign }) {
  const byCamp = new Map();
  for (const r of campDailyRows) {
    const id = r.campaign_id; if (!id || !r.date_start) continue;
    if (!byCamp.has(id)) byCamp.set(id, []);
    byCamp.get(id).push({ date: r.date_start, m: normalizeInsightsRow(r, 'campaign') });
  }
  for (const arr of byCamp.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));

  const todayUTC = new Date().toISOString().slice(0, 10);
  const out = [];

  for (const c of campaigns.filter((x) => x.status === 'ACTIVE')) {
    const series = (byCamp.get(c.id) || []).filter((d) => d.date < todayUTC);
    const last7 = aggDaily(series.slice(-7), kpi);
    const prior7 = aggDaily(series.slice(-14, -7), kpi);
    const windowConv = nz(c.kpiCount);
    // Week-over-week movement (last 7d vs prior 7d) — used both as a scale-up SAFETY GATE
    // (playbook: never scale into a degrading weekly trend) and surfaced for the AI.
    const wow = {
      cpaChangePct: pctChange(prior7.cpa, last7.cpa),
      roasChangePct: pctChange(prior7.roas, last7.roas),
      convChangePct: pctChange(prior7.kpi, last7.kpi),
      last7: { cpa: last7.cpa, roas: last7.roas, conv: last7.kpi, spend: round(last7.spend) },
    };
    const wowDegrading = (wow.roasChangePct != null && wow.roasChangePct <= -20) ||
      (wow.cpaChangePct != null && wow.cpaChangePct >= 25);

    // persistence: count of most-recent consecutive complete days breaching the kill / scale band
    let killStreak = 0; let goodStreak = 0;
    for (let i = series.length - 1; i >= 0; i--) {
      const d = aggDaily([series[i]], kpi);
      const bad = d.cpa != null && medianKpiCpa != null && d.cpa > medianKpiCpa * CPA_KILL_MULT;
      if (bad) killStreak++; else break;
    }
    for (let i = series.length - 1; i >= 0; i--) {
      const d = aggDaily([series[i]], kpi);
      const good = (d.roas != null && medianRoas != null && d.roas >= medianRoas * ROAS_SCALE_MULT) ||
        (d.cpa != null && medianKpiCpa != null && d.cpa <= medianKpiCpa * CPA_SCALE_MULT && d.kpi > 0);
      if (good) goodStreak++; else break;
    }

    const freq = c.frequency;
    const hasWeakCreative = (creativeByCampaign.get(c.name) || 0) > 0;

    let decision = null;

    // 1) stop-loss / kill — zero conversions on real spend, or sustained CPA blowout
    if (windowConv === 0 && nz(c.spend) >= Math.max(30, 2 * nz(c.kpiCpa || 0))) {
      decision = mk('pause', c, decisionConfidence({ conversions: 0, persistenceDays: series.length, clearedNoise: true }),
        `Spent ${money(c.spend)} over the window with zero ${kpi.label}. This is a clear stop-loss — pause and re-check the optimization event / tracking before it burns more.`,
        { spend: c.spend, conv: 0 });
    } else if (killStreak >= 3 && windowConv >= MIN_CONV_TO_JUDGE) {
      decision = mk('scale_down', c, decisionConfidence({ conversions: windowConv, persistenceDays: killStreak, clearedNoise: true }),
        `${kpi.label} cost has been above ${money(round(medianKpiCpa * CPA_KILL_MULT))} (1.5× the account median) for ${killStreak} straight days. Cut budget ~25-30% or pause the weakest ad set — this is a sustained loss, not a blip.`,
        { cpa7: last7.cpa, medianKpiCpa, killStreak });
    }
    // 2a) winner on recent days BUT the 7d trend is degrading → do NOT scale (playbook gate)
    else if (goodStreak >= 3 && windowConv >= MIN_CONV_TO_JUDGE && wowDegrading) {
      decision = mk('hold', c, decisionConfidence({ conversions: windowConv, persistenceDays: goodStreak }),
        `Recent days beat the median, but week-over-week is sliding (ROAS ${fmtPct(wow.roasChangePct)}, cost/${kpi.label} ${fmtPct(wow.cpaChangePct)}). The playbook rule is: never scale into a degrading weekly trend. Hold budget, refresh creative, and only scale once the 7-day trend turns back up.`,
        { roas7: last7.roas, cpa7: last7.cpa, wow });
      decision.whatToWaitFor = `Wait for the 7-day ROAS/cost trend to stabilise or improve before adding budget.`;
    }
    // 2) scale up — sustained winner with headroom (and weekly trend not degrading)
    else if (goodStreak >= 3 && windowConv >= MIN_CONV_TO_JUDGE && (freq == null || freq < 2)) {
      decision = mk(c.isCBO ? 'scale_up' : 'scale_up', c, decisionConfidence({ conversions: windowConv, persistenceDays: goodStreak, clearedNoise: true }),
        c.isCBO
          ? `Beats the account median (ROAS ${last7.roas ?? c.roas ?? '—'} / cost ${money(last7.cpa ?? c.kpiCpa)}) for ${goodStreak} straight days with low frequency ${freq ?? '—'}. Raise budget ~15-20% early in the day, then wait 48-72h before the next step.`
          : `Beats the account median (ROAS ${last7.roas ?? c.roas ?? '—'} / cost ${money(last7.cpa ?? c.kpiCpa)}) for ${goodStreak} straight days, frequency ${freq ?? '—'}. Surf-scale: raise the winning ad set ~15-20% (≤ once / 48-72h) and/or duplicate the winner into a fresh audience (PAUSED → on).`,
        { roas7: last7.roas, cpa7: last7.cpa, goodStreak, frequency: freq });
    }
    // 3) duplicate — strong winner already at rising frequency (scale horizontally, not vertically)
    else if (goodStreak >= 2 && windowConv >= MIN_CONV_TO_JUDGE && freq != null && freq >= 2 && freq < FREQ_FATIGUE) {
      decision = mk('duplicate', c, decisionConfidence({ conversions: windowConv, persistenceDays: goodStreak }),
        `A proven winner but frequency is ${freq} (rising). Don't just pour budget in — duplicate it into a fresh geo/lookalike audience (PAUSED → on) to scale reach without burning the current pocket.`,
        { roas7: last7.roas, frequency: freq });
    }
    // 4) refresh creative — fatigue or below-average ranked creative
    else if ((freq != null && freq > FREQ_FATIGUE && nz(c.spend) >= 20) || hasWeakCreative) {
      decision = mk('refresh_creative', c, decisionConfidence({ conversions: windowConv, persistenceDays: 2 }),
        hasWeakCreative
          ? `Active creative under this campaign is ranked below average by Meta. Refresh the hook/visual — weak creative caps CPM and CPA regardless of bidding.`
          : `Average frequency is ${freq} (>3 = the same people seeing it repeatedly). Refresh the creative or widen the audience before CPA climbs.`,
        { frequency: freq, weakCreative: hasWeakCreative });
    }

    // 5) nothing actionable → hold or watch (sample-size honest)
    if (!decision) {
      if (windowConv < MIN_CONV_TO_JUDGE) {
        decision = mk('watch', c, sampleConfidence(windowConv).tier === 'insufficient'
          ? { tier: 'insufficient', score: 15 } : { tier: 'low', score: 35 },
          `Only ${windowConv} ${kpi.label} in the window — not enough to judge confidently. Keep it running and re-check; acting now would be reacting to noise.`,
          { conv: windowConv });
        decision.whatToWaitFor = `Wait until this campaign has ≥${MIN_CONV_TO_JUDGE} ${kpi.label} (ideally 50) before scaling or cutting.`;
      } else {
        decision = mk('hold', c, decisionConfidence({ conversions: windowConv, persistenceDays: 3, clearedNoise: true }),
          `Performing within the normal band (ROAS ${c.roas ?? '—'} / cost ${money(c.kpiCpa)} vs median ${money(medianKpiCpa)}). No change needed — leave it to keep learning stable.`,
          { roas: c.roas, kpiCpa: c.kpiCpa });
      }
    }

    if (decision.confidence.tier !== 'high' && !decision.whatToWaitFor && decision.action !== 'hold') {
      decision.whatToWaitFor = `Confirm the pattern holds another ${decision.confidence.tier === 'medium' ? '1-2' : '2-3'} days (and ≥${MIN_CONV_TO_JUDGE} ${kpi.label}) before committing budget.`;
    }
    decision.wow = wow;
    out.push(decision);
  }
  return out;
}

function mk(action, c, confidence, rationale, evidence) {
  return {
    scope: 'campaign', entityId: c.id, entityName: c.name, action,
    confidence: confidence, confidenceScore: confidence.score, rationale, evidence,
    whatToWaitFor: null,
  };
}
function money(n) { return n == null ? '—' : `$${round(n, 2)}`; }
function fmtPct(n) { return n == null ? 'n/a' : `${n > 0 ? '+' : ''}${n}%`; }

// ---------- targeting decisions from segments ----------

function targetingDecisions(segGroups, kpi) {
  const out = [];
  const consider = segGroups.flatMap(({ kind, rows }) => rows.map((s) => ({ ...s, kind })));
  for (const s of consider) {
    if (s.verdict === 'worse' && (s.confidence === 'high' || s.confidence === 'medium') && nz(s.shareSpend) >= 8) {
      out.push({
        scope: 'targeting', action: 'narrow_targeting', segment: s.label, kind: s.kind,
        confidence: { tier: s.confidence, score: s.confidenceScore }, confidenceScore: s.confidenceScore,
        rationale: `${s.kind} "${s.label}" is spending ${s.shareSpend}% of budget at ${money(s.cpa)} ${kpi.label} cost (CI ${money(s.cpaLo)}–${money(s.cpaHi)}, ${s.conv} conv) — materially worse than account average. Consider excluding/trimming it, or carving it into its own lower-budget ad set so it stops dragging the main one.`,
        evidence: { cpa: s.cpa, ci: [s.cpaLo, s.cpaHi], conv: s.conv, shareSpend: s.shareSpend },
        whatToWaitFor: s.confidence === 'medium' ? `Only ${s.conv} conversions in this cell — confirm over another week before excluding.` : null,
      });
    } else if (s.verdict === 'better' && (s.confidence === 'high' || s.confidence === 'medium') && nz(s.shareSpend) < 25) {
      out.push({
        scope: 'targeting', action: 'expand_targeting', segment: s.label, kind: s.kind,
        confidence: { tier: s.confidence, score: s.confidenceScore }, confidenceScore: s.confidenceScore,
        rationale: `${s.kind} "${s.label}" converts at ${money(s.cpa)} (CI ${money(s.cpaLo)}–${money(s.cpaHi)}, ${s.conv} conv) — better than account average — but only gets ${s.shareSpend}% of spend. Opportunity: build a dedicated ad set targeting it, or lean creative toward it to capture more cheap volume.`,
        evidence: { cpa: s.cpa, ci: [s.cpaLo, s.cpaHi], conv: s.conv, shareSpend: s.shareSpend },
        whatToWaitFor: s.confidence === 'medium' ? `Directional (${s.conv} conv). Validate with a small dedicated test before shifting much budget.` : null,
      });
    }
  }
  out.sort((a, b) => b.confidenceScore - a.confidenceScore);
  return out.slice(0, 8);
}

// ---------- cost-cap graduation (suggest-only flag) ----------

function capGraduationFlags(adsets, kpi) {
  const out = [];
  for (const a of adsets.filter((x) => x.status === 'ACTIVE')) {
    if (nz(a.weeklyEvents) >= LEARNING_EVENTS_PER_WEEK && a.kpiCpa != null) {
      out.push({
        scope: 'adset', action: 'cost_cap_candidate', entityId: a.id, entityName: a.name, campaignName: a.campaignName,
        confidence: { tier: 'low', score: 40 }, confidenceScore: 40,
        rationale: `Graduated learning (~${a.weeklyEvents} ${kpi.label}/wk, stable cost ${money(a.kpiCpa)}). It's now a candidate for a Cost Cap a little above its current ${kpi.label} cost to defend efficiency while scaling — but caps can throttle delivery, so test on a duplicate, never the live winner.`,
        evidence: { weeklyEvents: a.weeklyEvents, cpa: a.kpiCpa },
        whatToWaitFor: `Only apply a cap to a duplicated ad set; if delivery stalls, revert. Lowest Cost is the safe default until volume is consistent.`,
      });
    }
  }
  return out.slice(0, 6);
}

// ---------- entry point ----------

export function buildDecisionDigest(ctx) {
  const {
    kpi, totals, campaigns, adsets, medianRoas, medianKpiCpa,
    sortedDaily, campDailyRows, adRankingRows, reachWindows,
    ageGenderRows, placementRows, countryRows = [], deviceRows = [], capiDetected,
  } = ctx;

  // Segment verdicts compare each cell to the ACCOUNT-BLENDED CPA (spend/conversions across the
  // whole account) — that's the true "average" a segment under/over-performs against. Median
  // CAMPAIGN CPA is a different reference used for per-campaign scaling/kill decisions.
  const segmentBaselineCpa = totals.cpa ?? medianKpiCpa ?? null;

  const today = buildToday(sortedDaily, kpi);
  const trend7 = buildTrend7(sortedDaily, kpi);
  const saturation = buildSaturation(reachWindows);
  const creative = buildCreative(adRankingRows, kpi);

  const creativeByCampaign = new Map();
  for (const cr of creative) if (cr.campaignName) creativeByCampaign.set(cr.campaignName, (creativeByCampaign.get(cr.campaignName) || 0) + 1);

  const segments = {
    ageGender: buildSegments(ageGenderRows, kpi, segmentBaselineCpa, (r) => `${r.age || '?'} · ${r.gender || '?'}`),
    placement: buildSegments(placementRows, kpi, segmentBaselineCpa, (r) => `${r.publisher_platform || '?'} · ${(r.platform_position || '').replace(/_/g, ' ')}`.trim()),
    country: buildSegments(countryRows, kpi, segmentBaselineCpa, (r) => r.country || '?'),
    device: buildSegments(deviceRows, kpi, segmentBaselineCpa, (r) => (r.impression_device || '?').replace(/_/g, ' ')),
  };

  const concentration = buildConcentration(campaigns);

  const entityDecisions = campaignDecisions({ campaigns, campDailyRows, kpi, medianRoas, medianKpiCpa, creativeByCampaign });
  // NOTE: country is intentionally excluded from targeting ACTIONS — this account runs one campaign
  // per country, so an account-level country verdict ≈ a whole campaign (handled by campaign decisions);
  // recommending "exclude country X" would be misleading. Country stays in `segments` for context only.
  const targeting = targetingDecisions([
    { kind: 'age/gender', rows: segments.ageGender },
    { kind: 'placement', rows: segments.placement },
    { kind: 'device', rows: segments.device },
  ], kpi);
  const capFlags = capGraduationFlags(adsets, kpi);

  const signal = {
    capiDetected: capiDetected === true,
    note: capiDetected === true
      ? 'Conversions API (server-side) signal detected — attribution is on solid footing.'
      : 'Could not confirm a Conversions API (server-side) signal — the Dataset Quality endpoint returned empty for this account. If CAPI is not set up, it is the single highest-leverage fix: browser-pixel-only tracking can miss 20-40% of conversions, which makes every CPA/ROAS verdict noisier and harder to act on with confidence. If CAPI is already live, ignore this.',
  };

  // priority list: real actions first (kill > scale > duplicate > targeting > refresh > caps), holds/watch last
  const ACTION_RANK = { pause: 0, scale_down: 1, scale_up: 2, duplicate: 3, narrow_targeting: 4, expand_targeting: 5, refresh_creative: 6, cost_cap_candidate: 7, hold: 8, watch: 9 };
  const all = [...entityDecisions, ...targeting, ...capFlags].sort((a, b) => {
    const ra = ACTION_RANK[a.action] ?? 5; const rb = ACTION_RANK[b.action] ?? 5;
    if (ra !== rb) return ra - rb;
    return (b.confidenceScore || 0) - (a.confidenceScore || 0);
  });

  return {
    generatedAt: new Date().toISOString(),
    kpi: kpi.label,
    baselineCpa: round(segmentBaselineCpa),
    medianCampaignCpa: round(medianKpiCpa),
    today, trend7, saturation, signal, creative, segments, concentration,
    decisions: all,
    counts: {
      actionable: all.filter((d) => !['hold', 'watch'].includes(d.action)).length,
      highConfidence: all.filter((d) => d.confidence?.tier === 'high').length,
      watch: all.filter((d) => d.action === 'watch').length,
    },
  };
}
