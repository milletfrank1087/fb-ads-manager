// Small statistics toolkit for decision-grade ad analysis at LOW conversion volume.
//
// Why this exists: at ~1-100 conversions/week per entity you cannot use frequentist
// p-values (you'd need ~384 conversions for ±5% at 95%). The honest tools at this scale are
// Poisson/Bayesian credible intervals on the conversion COUNT, plus a confidence gate driven
// by sample size and persistence. Every "X is worse/better" claim here carries an interval and
// a confidence tier so the LLM can say "probably, but not enough data yet" instead of guessing.

const Z95 = 1.96;

export const nz = (n) => (Number.isFinite(n) ? n : 0);
export const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

export function mean(arr) {
  const a = arr.filter((n) => Number.isFinite(n));
  if (!a.length) return null;
  return a.reduce((s, n) => s + n, 0) / a.length;
}

export function stdev(arr) {
  const a = arr.filter((n) => Number.isFinite(n));
  if (a.length < 2) return null;
  const m = mean(a);
  const v = a.reduce((s, n) => s + (n - m) ** 2, 0) / (a.length - 1);
  return Math.sqrt(v);
}

export function median(arr) {
  const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return round(((to - from) / Math.abs(from)) * 100, 1);
}

export function zScore(value, m, sd) {
  if (!Number.isFinite(value) || !Number.isFinite(m) || !Number.isFinite(sd) || sd <= 0) return null;
  return round((value - m) / sd, 2);
}

// 95% confidence interval for a Poisson count (Wilson–Hilferty / chi-square approximation).
// Returns the plausible range for the TRUE event count given an observed count k.
export function poissonCountCI(k, z = Z95) {
  if (!Number.isFinite(k) || k < 0) return { lo: null, hi: null };
  const lo = k <= 0 ? 0 : k * (1 - 1 / (9 * k) - z / (3 * Math.sqrt(k))) ** 3;
  const hi = (k + 1) * (1 - 1 / (9 * (k + 1)) + z / (3 * Math.sqrt(k + 1))) ** 3;
  return { lo: Math.max(0, round(lo, 2)), hi: round(hi, 2) };
}

// CPA point estimate + 95% credible interval, derived from the conversion-count interval.
// Fewer conversions ⇒ wider interval ⇒ the caller should trust the number less.
export function cpaWithCI(spend, conversions) {
  if (!Number.isFinite(spend) || spend <= 0 || !Number.isFinite(conversions) || conversions <= 0) {
    return { cpa: null, lo: null, hi: null, n: nz(conversions) };
  }
  const { lo: cLo, hi: cHi } = poissonCountCI(conversions);
  return {
    cpa: round(spend / conversions),
    lo: cHi ? round(spend / cHi) : null,   // more conversions ⇒ lower CPA bound
    hi: cLo ? round(spend / cLo) : null,   // fewer conversions ⇒ higher CPA bound
    n: conversions,
  };
}

// Confidence tier purely from conversion sample size. These thresholds come from the research:
// ~50+ conversions to trust a CPA verdict; 15-49 is directional; <15 is weak; <5 is unusable.
export function sampleConfidence(conversions) {
  const n = nz(conversions);
  if (n >= 50) return { tier: 'high', score: 90, n };
  if (n >= 15) return { tier: 'medium', score: 65, n };
  if (n >= 5) return { tier: 'low', score: 40, n };
  return { tier: 'insufficient', score: 15, n };
}

// Compare a segment (spend, conversions) against a baseline CPA using the Poisson interval.
// Verdict is only "worse"/"better" when the segment's expected conversions at the baseline CPA
// fall OUTSIDE the observed count's 95% interval — i.e. the gap is unlikely to be noise.
// Otherwise "similar" / "insufficient". Always returns the sample-size confidence too.
export function segmentVsBaseline({ spend, conversions, baselineCpa }) {
  const conf = sampleConfidence(conversions);
  const cpaInfo = cpaWithCI(spend, conversions);
  const out = {
    cpa: cpaInfo.cpa, cpaLo: cpaInfo.lo, cpaHi: cpaInfo.hi,
    n: conf.n, confidence: conf.tier, confidenceScore: conf.score,
    verdict: 'insufficient', lift: null,
  };
  if (!Number.isFinite(spend) || spend <= 0 || !Number.isFinite(baselineCpa) || baselineCpa <= 0) return out;
  if (conf.tier === 'insufficient') return out;

  out.lift = round(((baselineCpa - (cpaInfo.cpa ?? baselineCpa)) / baselineCpa) * 100, 1); // + = cheaper than account

  const expectedConv = spend / baselineCpa;          // conversions we'd expect at the account CPA
  const { lo, hi } = poissonCountCI(conversions);    // plausible range for the true count
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    if (expectedConv > hi) out.verdict = 'worse';     // got fewer conversions than baseline predicts
    else if (expectedConv < lo) out.verdict = 'better';
    else out.verdict = 'similar';
  }
  return out;
}

// Overall confidence for an action: combine sample size + persistence (consecutive days the
// signal held) + whether it cleared the noise band. Conservative on purpose.
export function decisionConfidence({ conversions = 0, persistenceDays = 0, anomalyZ = null, clearedNoise = false }) {
  const samp = sampleConfidence(conversions);
  let score = samp.score;
  if (persistenceDays >= 3) score += 10;
  else if (persistenceDays >= 2) score += 5;
  else if (persistenceDays <= 0) score -= 10;
  if (clearedNoise) score += 5;
  if (Number.isFinite(anomalyZ) && Math.abs(anomalyZ) >= 2) score += 5;
  score = Math.max(5, Math.min(98, score));
  const tier = score >= 80 ? 'high' : score >= 55 ? 'medium' : score >= 30 ? 'low' : 'insufficient';
  return { tier, score };
}
