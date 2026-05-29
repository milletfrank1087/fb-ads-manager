import { config } from './env.js';
import { log } from './logger.js';

const BASE_URL = 'https://openrouter.ai/api/v1';

export const COMMENT_CATEGORIES = [
  'hate', 'harassment', 'threat', 'scam_accusation', 'ai_accusation',
  'fake_accusation', 'spam', 'negative_criticism', 'safe',
];
export const RECOMMENDED_ACTIONS = ['delete', 'keep', 'review'];
export const AD_TYPES = ['donation', 'fundraiser', 'product', 'service', 'awareness', 'other'];

export const analyzerEnabled = () => Boolean(config.openrouterApiKey);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clip(s, n) {
  if (!s) return '';
  const v = String(s);
  return v.length > n ? v.slice(0, n) + '…' : v;
}

function shortErr(s, n = 240) {
  if (!s) return '';
  const trimmed = String(s).replace(/\s+/g, ' ').slice(0, n);
  return trimmed.length === n ? trimmed + '…' : trimmed;
}

function parseJsonLoose(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function classifyError(status, message) {
  if (!status) return { transient: true, reason: 'network' };
  if (status === 429) return { transient: true, reason: 'rate_limited' };
  if (status >= 500) return { transient: true, reason: 'server_error' };
  if (status === 404) return { transient: false, reason: 'model_unavailable' };
  if (status === 401 || status === 403) return { transient: false, reason: 'auth' };
  if (status === 400 && /json|schema|validation/i.test(message)) return { transient: true, reason: 'schema_mismatch' };
  return { transient: false, reason: 'client_error' };
}

async function callOpenRouter(model, messages, schemaName, schema) {
  if (!config.openrouterApiKey) throw new Error('OPENROUTER_API_KEY missing — AI review disabled.');
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openrouterApiKey}`,
      'HTTP-Referer': 'http://localhost:' + config.port,
      'X-Title': 'GFM Greece comment moderation',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      max_tokens: 1400,
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`OpenRouter ${res.status}: ${shortErr(body)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function runWithFallback(messages, schemaName, schema) {
  const models = [config.openrouterModel, config.openrouterFallbackModel].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr;
  for (let mi = 0; mi < models.length; mi += 1) {
    const model = models[mi];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const startedAt = Date.now();
      try {
        const json = await callOpenRouter(model, messages, schemaName, schema);
        const parsed = parseJsonLoose(json?.choices?.[0]?.message?.content);
        if (!parsed) { const e = new Error('Invalid JSON from model'); e.status = 400; throw e; }
        if (attempt > 1 || mi > 0) {
          log.info('analyzer.recovered', { model, attempt, tier: mi === 0 ? 'primary' : 'fallback', elapsedMs: Date.now() - startedAt });
        }
        return { parsed, model };
      } catch (err) {
        lastErr = err;
        const { transient, reason } = classifyError(err.status, err.message);
        if (!transient || attempt === 3) {
          log.warn('analyzer.call_failed', { model, attempt, status: err.status || 0, reason, transient, err: shortErr(err.message) });
        }
        if (!transient) break;
        await sleep(700 * attempt + Math.random() * 250);
      }
    }
    if (mi < models.length - 1) log.warn('analyzer.fallback', { from: model, to: models[mi + 1] });
  }
  throw lastErr || new Error('All OpenRouter models failed');
}

// ---------- Prompts & schemas ----------

const COMMENT_SYSTEM_PROMPT = `You are a content-moderation analyst for a Facebook ad-post operator deciding whether to HIDE/DELETE comments or KEEP them.

You will receive:
  - POST CONTEXT: the ad's primary text, an AI-generated summary, author name, and the post image (if any).
  - THREAD CONTEXT (when applicable): the PARENT comment (if this is a reply) and/or top replies (if this is a parent with replies).
  - A single COMMENT to classify in its ORIGINAL LANGUAGE (often Greek/English/Portuguese/Spanish/Italian/etc.).

STEP 1. Understand what the ad is about (donation/fundraiser, product promo, awareness campaign, etc.).
STEP 2. Produce a faithful English translation of the comment.
STEP 3. Classify the comment.
STEP 4. Decide the recommended action from the ad owner's perspective.

Return JSON with:
- english_translation: faithful English translation, max 400 chars. If already English, return it verbatim (lightly cleaned). Keep meaningful emojis inline.
- category: exactly one of
  "hate"            – slurs, dehumanization, bigotry (protected-class attacks).
  "harassment"      – targeted insults, bullying, name-calling at a person.
  "threat"          – explicit intent to harm someone.
  "scam_accusation" – calling the POST/AD/CAMPAIGN a scam/fraud ("burla","golpe","estafa","fraude","scam","rip-off","stealing money","don't donate","απάτη","κλεψιά", etc.).
  "ai_accusation"   – claiming the post/image/person is AI-generated, deepfake, "not real", "AI slop", "generated".
  "fake_accusation" – claiming the post/story/person is FAKE, staged, photoshopped, a lie, "stolen photos" (but NOT specifically AI). Greek: "ψεύτικο","φέικ".
  "spam"            – unrelated promotions, crypto/OF links, repetitive bot noise, link farming.
  "negative_criticism" – non-hateful negative critique of the product/service/design that does NOT accuse of scam/fake/AI.
  "safe"            – positive, neutral, supportive, questions, emojis, prayers, engagement ("done","shared","donated","feito","amém","🙏","καλή επιτυχία","δύναμη").
- severity: integer 0..10. safe=0–1, mild negative=2–3, scam/ai/fake accusation=7–9, harassment=5–7, hate/threat=8–10.
- explanation: 1–3 sentences in English. Reference the ad context when relevant. Do NOT repeat the translation here.
- recommended_action: exactly one of
  "delete" – clearly harmful to the campaign/audience and adds NO social proof. Use for hate, harassment, threats, spam, and most scam/ai/fake accusations when the thread has no strong defending replies.
  "keep"   – helpful, supportive, social proof, genuine engagement, a legitimate question, OR a reply defending the campaign with evidence.
  "review" – operator should decide manually (an accusation whose replies already provide strong social proof; harsh-but-not-harmful criticism; ambiguous content).
- action_reason: 1 sentence in English explaining the action, mentioning thread context if it influenced the decision.

CRITICAL RULES:
1. Donation/fundraiser ad + comment sharing/donating/praying/wishing strength → ALWAYS "safe", severity 0, action "keep" (social proof).
2. A single word like "burla"/"golpe"/"fake"/"AI"/"scam"/"fraude"/"απάτη" on an ad = an accusation with HIGH severity, action usually "delete".
3. If a scam/fake/ai accusation has REPLIES defending the campaign with concrete evidence → severity stays 7–9 BUT action becomes "review".
4. Defending replies themselves are "safe" + "keep".
5. Translate strictly: "burla" (PT)= scam/fraud not joke; "golpe"= scam; Greek "απάτη"= scam/fraud. Don't invent innocent meanings.
6. "spam" is ONLY for unrelated promos/bots.`;

const BATCH_SYSTEM_PROMPT = `${COMMENT_SYSTEM_PROMPT}

YOU ARE NOW PROCESSING A BATCH. The user message contains a numbered list of comments on the SAME post; each has an integer index "idx". Return JSON with a single key "items" whose value is an ARRAY with one entry per input comment. Each entry MUST include its matching "idx". Process comments individually (do not let one influence another beyond shared post context).`;

const POST_SYSTEM_PROMPT = `You analyze a Facebook ad/post (text + optional image) to produce structured context for downstream comment moderation. If it's a fundraiser/donation campaign, say so explicitly.

Return JSON with:
- summary: 2–4 sentences in English describing exactly what the post is about (combining text AND image). Mention: ad type, who/what is shown, what action is requested.
- ad_type: one of "donation","fundraiser","product","service","awareness","other".
- category: one of ["hate","harassment","threat","scam_accusation","ai_accusation","fake_accusation","spam","negative_criticism","safe"] for the POST ITSELF (most legitimate ads are "safe").
- severity: integer 0..10 for the post itself.
- explanation: 1-2 sentences on the category choice.`;

const REPLY_SYSTEM_PROMPT = `You write short, warm, on-brand REPLIES from a Facebook Page owner to a comment on their ad.

You receive: the ad context, the prior AI classification of the comment, and the original comment text.

Rules:
- Reply in the SAME LANGUAGE the commenter used (detect from the original text, NOT the translation).
- Be brief (1-2 short sentences, max 220 chars).
- Warm, human, gracious. No emojis unless the original used them (then mirror 1 max).
- NEVER promise money, refunds, timelines, medical outcomes, or legal issues.
- "safe" supportive comments on a donation/fundraiser: thank them sincerely.
- scam/ai/fake/hate accusations with action=delete: a calm, brief, factual rebuttal pointing to verifiable info (campaign name, official channel), without escalating. Civil even if the original was hostile.
- action=review accusations with defending replies: a brief public thank-you to defenders or a brief clarification.
- negative_criticism: acknowledge briefly without being defensive.
- questions: answer concisely; if unknown, say so and point to a direct channel.
- NEVER include URLs, phone numbers, emails, or unverifiable claims.

Return JSON with:
- reply: suggested reply text in the commenter's language.
- language: ISO 639-1 code ("pt","es","el","en", ...).
- tone: one of "thankful","factual","empathetic","neutral","firm".
- rationale: 1 sentence in English on why this reply.`;

const COMMENT_ITEM_PROPS = {
  english_translation: { type: 'string' },
  category: { type: 'string', enum: COMMENT_CATEGORIES },
  severity: { type: 'integer', minimum: 0, maximum: 10 },
  explanation: { type: 'string' },
  recommended_action: { type: 'string', enum: RECOMMENDED_ACTIONS },
  action_reason: { type: 'string' },
};

const COMMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['english_translation', 'category', 'severity', 'explanation', 'recommended_action', 'action_reason'],
  properties: COMMENT_ITEM_PROPS,
};

const BATCH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['idx', ...Object.keys(COMMENT_ITEM_PROPS)],
        properties: { idx: { type: 'integer', minimum: 0 }, ...COMMENT_ITEM_PROPS },
      },
    },
  },
};

const POST_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'ad_type', 'category', 'severity', 'explanation'],
  properties: {
    summary: { type: 'string' },
    ad_type: { type: 'string', enum: AD_TYPES },
    category: { type: 'string', enum: COMMENT_CATEGORIES },
    severity: { type: 'integer', minimum: 0, maximum: 10 },
    explanation: { type: 'string' },
  },
};

const REPLY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reply', 'language', 'tone', 'rationale'],
  properties: {
    reply: { type: 'string' },
    language: { type: 'string' },
    tone: { type: 'string', enum: ['thankful', 'factual', 'empathetic', 'neutral', 'firm'] },
    rationale: { type: 'string' },
  },
};

// ---------- Normalizers ----------

export const SAFE_DEFAULT = { english_translation: '', category: 'safe', severity: 0, explanation: '', recommended_action: 'keep', action_reason: '' };

function normCommentAnalysis(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const category = COMMENT_CATEGORIES.includes(obj.category) ? obj.category : 'safe';
  let severity = Number(obj.severity);
  if (!Number.isFinite(severity)) severity = 0;
  severity = Math.max(0, Math.min(10, Math.round(severity)));
  const recommended = RECOMMENDED_ACTIONS.includes(obj.recommended_action)
    ? obj.recommended_action
    : (category === 'safe' ? 'keep' : 'review');
  return {
    english_translation: String(obj.english_translation || '').slice(0, 800),
    category,
    severity,
    explanation: String(obj.explanation || '').slice(0, 1000),
    recommended_action: recommended,
    action_reason: String(obj.action_reason || '').slice(0, 500),
  };
}

function normPostAnalysis(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const category = COMMENT_CATEGORIES.includes(obj.category) ? obj.category : 'safe';
  const adType = AD_TYPES.includes(obj.ad_type) ? obj.ad_type : 'other';
  let severity = Number(obj.severity);
  if (!Number.isFinite(severity)) severity = 0;
  severity = Math.max(0, Math.min(10, Math.round(severity)));
  return {
    summary: String(obj.summary || '').slice(0, 2000),
    ad_type: adType,
    category,
    severity,
    explanation: String(obj.explanation || '').slice(0, 1000),
  };
}

// ---------- User-content builders ----------

export function buildThreadBlock(thread) {
  if (!thread) return null;
  const lines = [];
  if (thread.parent) {
    lines.push('THIS COMMENT IS A REPLY. Parent comment:');
    if (thread.parent.authorName) lines.push(`  - Author: ${thread.parent.authorName}`);
    lines.push(`  - Text: ${clip(thread.parent.text, 600)}`);
  }
  if (thread.replies && thread.replies.length) {
    lines.push('Replies to THIS comment (possible social proof / defense):');
    for (const r of thread.replies.slice(0, 6)) {
      lines.push(`  - ${r.authorName ? r.authorName + ': ' : ''}${clip(r.text, 400)}`);
    }
  }
  return lines.length ? lines.join('\n') : null;
}

function postUserContent(post) {
  const lines = ['POST TO ANALYZE:'];
  if (post.author) lines.push(`Advertiser: ${post.author}`);
  lines.push(`Primary text: ${post.content || '(no text extracted)'}`);
  if (post.campaignName) lines.push(`Campaign: ${post.campaignName}`);
  const parts = [{ type: 'text', text: lines.join('\n') }];
  if (post.imageUrl) parts.push({ type: 'image_url', image_url: { url: post.imageUrl } });
  return parts;
}

function batchUserContent(comments, postCtx) {
  const head = ['POST CONTEXT:'];
  if (postCtx?.author) head.push(`Advertiser: ${postCtx.author}`);
  if (postCtx?.adType) head.push(`Ad type (classified): ${postCtx.adType}`);
  if (postCtx?.content) head.push(`Primary text: ${clip(postCtx.content, 1600)}`);
  if (postCtx?.summary) head.push(`AI summary: ${postCtx.summary}`);
  if (!postCtx?.content && !postCtx?.summary) head.push('(no post context available)');
  head.push('');
  head.push(`COMMENTS TO CLASSIFY (${comments.length}). Return ONE entry per idx in the "items" array.`);
  const lines = [head.join('\n')];
  for (const c of comments) {
    const parts = [`[idx=${c.idx}]`];
    if (c.authorName) parts.push(`Author: ${c.authorName}`);
    if (c.thread?.parent) parts.push(`Parent comment: ${c.thread.parent.authorName ? c.thread.parent.authorName + ': ' : ''}${clip(c.thread.parent.text, 350)}`);
    if (c.thread?.replies?.length) {
      parts.push('Replies to this comment (social-proof signal):');
      for (const r of c.thread.replies.slice(0, 4)) parts.push(`  - ${r.authorName ? r.authorName + ': ' : ''}${clip(r.text, 250)}`);
    }
    parts.push(`Comment: ${c.text}`);
    lines.push(parts.join('\n'));
  }
  const textPart = { type: 'text', text: lines.join('\n\n---\n\n') };
  if (postCtx?.imageUrl) return [textPart, { type: 'image_url', image_url: { url: postCtx.imageUrl } }];
  return [textPart];
}

function replyUserContent({ comment, analysis, postCtx, thread }) {
  const lines = ['POST CONTEXT:'];
  if (postCtx?.author) lines.push(`Advertiser: ${postCtx.author}`);
  if (postCtx?.adType) lines.push(`Ad type: ${postCtx.adType}`);
  if (postCtx?.summary) lines.push(`AI summary: ${postCtx.summary}`);
  else if (postCtx?.content) lines.push(`Primary text: ${clip(postCtx.content, 1200)}`);
  lines.push('', 'PRIOR AI CLASSIFICATION OF THE COMMENT:');
  if (analysis) {
    lines.push(`- category: ${analysis.category}`);
    lines.push(`- severity: ${analysis.severity}`);
    lines.push(`- recommended_action: ${analysis.recommended_action}`);
    if (analysis.english_translation) lines.push(`- english_translation: ${analysis.english_translation}`);
    if (analysis.action_reason) lines.push(`- action_reason: ${analysis.action_reason}`);
  } else {
    lines.push('(no prior analysis available)');
  }
  const tb = buildThreadBlock(thread);
  if (tb) lines.push('', 'THREAD CONTEXT:', tb);
  lines.push('', 'COMMENT TO REPLY TO (original language):');
  if (comment.authorName) lines.push(`Author: ${comment.authorName}`);
  lines.push(`Comment: ${comment.text}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

// ---------- Public API ----------

export async function analyzePost(post) {
  const messages = [
    { role: 'system', content: POST_SYSTEM_PROMPT },
    { role: 'user', content: postUserContent(post) },
  ];
  const { parsed, model } = await runWithFallback(messages, 'post_analysis', POST_SCHEMA);
  const analysis = normPostAnalysis(parsed);
  if (!analysis) throw new Error('Invalid post analysis JSON');
  return { analysis, model };
}

export async function analyzeBatch(comments, postCtx) {
  if (!comments.length) return { results: new Map(), model: null };
  const messages = [
    { role: 'system', content: BATCH_SYSTEM_PROMPT },
    { role: 'user', content: batchUserContent(comments, postCtx) },
  ];
  const { parsed, model } = await runWithFallback(messages, 'comment_batch', BATCH_SCHEMA);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const results = new Map();
  for (const it of items) {
    const norm = normCommentAnalysis(it);
    if (norm && typeof it.idx === 'number') results.set(it.idx, norm);
  }
  return { results, model };
}

function singleCommentUserContent(comment, postCtx) {
  const lines = ['POST CONTEXT:'];
  if (postCtx?.author) lines.push(`Advertiser: ${postCtx.author}`);
  if (postCtx?.adType) lines.push(`Ad type (classified): ${postCtx.adType}`);
  if (postCtx?.content) lines.push(`Primary text: ${clip(postCtx.content, 2000)}`);
  if (postCtx?.summary) lines.push(`AI summary: ${postCtx.summary}`);
  if (!postCtx?.content && !postCtx?.summary) lines.push('(no post context available)');
  const tb = buildThreadBlock(comment.thread);
  if (tb) lines.push('', 'THREAD CONTEXT:', tb);
  lines.push('', 'COMMENT TO ANALYZE (classify in its original language):');
  if (comment.authorName) lines.push(`Author: ${comment.authorName}`);
  lines.push(`Comment: ${comment.text}`);
  const textPart = { type: 'text', text: lines.join('\n') };
  if (postCtx?.imageUrl) return [textPart, { type: 'image_url', image_url: { url: postCtx.imageUrl } }];
  return [textPart];
}

export async function analyzeComment(comment, postCtx) {
  const messages = [
    { role: 'system', content: COMMENT_SYSTEM_PROMPT },
    { role: 'user', content: singleCommentUserContent(comment, postCtx) },
  ];
  const { parsed, model } = await runWithFallback(messages, 'comment_analysis', COMMENT_SCHEMA);
  const analysis = normCommentAnalysis(parsed);
  if (!analysis) throw new Error('Invalid comment analysis JSON');
  return { analysis, model };
}

// ---------- Strategy narrative ----------

// Curated 2026 media-buyer consensus distilled from ecommerce/practitioner forums and agencies
// (Skaleit, RocketshipHQ, trycrush, adlibrary, Wevion, Coinis, Instrumnt, r/PPC-style write-ups) —
// deliberately NOT Meta's own "optimization suggestions", which are tuned to grow spend, not ROI.
// This is the advisor's strategic brain; it is cross-validated and includes the known counter-points.
const COMMUNITY_PLAYBOOK = `COMMUNITY PLAYBOOK (2026 media-buyer consensus — NOT Meta's own advice; Meta's in-app suggestions optimize for spend, not your ROI):

KILL / PAUSE (when to cut):
- HARD RULE: an ad/ad set that spent ≥3× target CPA with ZERO conversions = kill now (structural problem: audience, pixel, LP, or offer). This is the ONE rule that overrides the learning phase.
- Sustained loss rule (needs ALL three): spend ≥2× target CPA AND ≥7 days live AND CPA >1.5× target → pause (don't delete; you may revive seasonally). Tighten the multiplier to 1.3× for high-ticket, loosen to ~1.75× for impulse buys.
- Use 7-day / 14-day windows, NEVER a single day. "One bad day is data; three bad days is a trend." On accounts <$1k/day a one-day CPA swing is pure noise.
- Always require a spend/impression floor (≥~1000 impr or ≥2× CPA) before any pause — killing an under-spent ad set kills future winners.
- Do NOT pause during the learning phase (<50 events / <7 days) except the hard 3× rule — edits reset learning.
- "Zombie ads" (break-even, 0% profit, 7+ days) should be cut: they steal budget from your 3× winners (opportunity cost).

SCALE (when & how):
- Only scale when 7-day ROAS is stable/improving. Vertical: +20% per ad set every 48-72h (>20% resets learning). If ROAS is FAR above target (big safety margin), a larger jump (up to ~50%) is acceptable.
- Horizontal/"surf" scaling for speed: duplicate a proven winner into fresh audiences (PAUSED→on) — each duplicate finds a different audience sub-pocket. Kill the duplicates that miss; keep the 1-2 that hook. This beats vertical when frequency is rising.
- Healthy scale-up = CPM +10-25% with CPA holding. Unhealthy = CPM +40%+, CPA jumps in 3-4 days → pull back, you hit the audience's efficiency ceiling.
- Frequency nuance: freq <1.5 = a top-of-funnel NEW-audience driver (valuable even at lower ROAS — it feeds your winners); freq >2 with rising CPA/CPM = middle-of-funnel saturation, don't pour more budget in — duplicate to new audience or refresh creative.

DIAGNOSE (which metric broke FIRST tells you the fix):
- CPM rose first → auction/audience problem (broaden audience, cut audience overlap).
- CTR fell first → creative problem (refresh the hook/visual).
- CPC fine but CPA climbed → landing-page/CVR problem (not the ad).
- Rising CPM at FLAT conversion rate is the EARLIEST saturation signal — it precedes the CVR drop and the visible CPA spike.

STRUCTURE (post-Andromeda):
- Consolidate: fewer ad sets, more creatives each; broad targeting beats interest stacks once an account has signal; creative is the #1 lever.
- Counter-point (important): consolidation concentrates risk. If one campaign/creative carries >~40% of account spend it's one fatigue cycle from a step-function "saturation cliff". Prefer parallel scaling campaigns and a creative pipeline of the next 3 winners.

BIDDING (only above ~50 conv/week — useless/​starving below that):
- Bid cap usually > cost cap for protecting ROAS at scale: bid cap = AOV ÷ target ROAS; it spends MORE on high-intent days (weekends/paydays) and LESS on weak days — demand-matching, not flat. Raise the cap in 5% steps (max +20%) if it underspends. Never mix lowest-cost and a cap in the same campaign. Apply caps to a DUPLICATE, never the live winner.

DAY/TIME:
- Ecommerce often sees Fri-Sun drive 50-60% of conversions. Gentle budget weighting toward strong days is fine; at low volume do NOT hard on/off schedule (it starves learning).

ATTRIBUTION/SIGNAL (trust the data carefully):
- CAPI is essential — pixel-only undercounts 20-40%, inflates CPM, and makes every CPA/ROAS verdict noisier.
- Platform ROAS ≠ incremental ROAS. Advantage+/broad can "cannibalize" credit for organic + retargeting. Sanity-check against blended MER and new-customer rate; don't scale purely on dashboard ROAS.`;

const STRATEGY_SYSTEM_PROMPT = `You are a senior Meta (Facebook/Instagram) media buyer advising the operator of a LOW-BUDGET, all-ABO, medical-fundraising ad account ("GFM Greece" — typically one campaign per beneficiary per country, ~$20-40/day each, optimizing for donations/purchases).

${COMMUNITY_PLAYBOOK}


You receive a JSON DIGEST of computed metrics, detected performance patterns, and rule-based suggestions for the last analysis window. Turn it into a crisp weekly action plan.

HARD CONSTRAINTS (never violate):
- SUGGEST ONLY. You never make changes. Phrase everything as recommendations the operator will apply manually.
- Budget changes: at most ~20% per ad set every 48-72h (bigger jumps reset Meta's learning phase).
- Cost Cap / Bid Cap are NOT appropriate below ~50 conversions/week AND ~$5k/week per ad set — at this account's budget they would starve delivery. Do NOT recommend them unless the digest shows an entity above those thresholds.
- The single biggest lever here is usually CONSOLIDATION + escaping the learning phase (an ad set needs ~50 conversions/7 days; min daily budget ≈ CPA × 7-10), not fancy bidding.
- Day-of-week / hour weighting is only worth it when the digest flagged a pattern with enough volume; otherwise say it's noise.
- Use ONLY numbers and names present in the digest. Never invent campaigns, metrics, or competitor data.

Return JSON:
- headline: one punchy sentence summarizing the account's state this week.
- account_summary: 2-4 sentences (spend, main KPI, ROAS/CPA reality, learning-phase situation).
- weekly_plan: array of 3-7 concrete steps, each { action (imperative, names the entity), why (the evidence/number), priority ("high"|"medium"|"low"), strategy (one of "consolidate","scale_vertical","scale_horizontal","duplicate","pause","creative_refresh","daypart_weight","fix_tracking","hold") }.
- watchouts: array of 1-4 short cautions (e.g., learning-phase resets, low-volume noise, attribution).`;

const STRATEGY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'account_summary', 'weekly_plan', 'watchouts'],
  properties: {
    headline: { type: 'string' },
    account_summary: { type: 'string' },
    weekly_plan: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['action', 'why', 'priority', 'strategy'],
        properties: {
          action: { type: 'string' },
          why: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          strategy: { type: 'string', enum: ['consolidate', 'scale_vertical', 'scale_horizontal', 'duplicate', 'pause', 'creative_refresh', 'daypart_weight', 'fix_tracking', 'hold'] },
        },
      },
    },
    watchouts: { type: 'array', items: { type: 'string' } },
  },
};

export async function strategyNarrative(digest) {
  const messages = [
    { role: 'system', content: STRATEGY_SYSTEM_PROMPT },
    { role: 'user', content: [{ type: 'text', text: `ANALYSIS DIGEST (JSON):\n${JSON.stringify(digest).slice(0, 18000)}` }] },
  ];
  const { parsed, model } = await runWithFallback(messages, 'strategy_narrative', STRATEGY_SCHEMA);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid strategy narrative JSON');
  const PRI = ['high', 'medium', 'low'];
  const STRAT = ['consolidate', 'scale_vertical', 'scale_horizontal', 'duplicate', 'pause', 'creative_refresh', 'daypart_weight', 'fix_tracking', 'hold'];
  const plan = Array.isArray(parsed.weekly_plan) ? parsed.weekly_plan.slice(0, 8).map((s) => ({
    action: String(s.action || '').slice(0, 400),
    why: String(s.why || '').slice(0, 500),
    priority: PRI.includes(s.priority) ? s.priority : 'medium',
    strategy: STRAT.includes(s.strategy) ? s.strategy : 'hold',
  })) : [];
  return {
    narrative: {
      headline: String(parsed.headline || '').slice(0, 400),
      account_summary: String(parsed.account_summary || '').slice(0, 1500),
      weekly_plan: plan,
      watchouts: Array.isArray(parsed.watchouts) ? parsed.watchouts.slice(0, 5).map((w) => String(w).slice(0, 300)) : [],
    },
    model,
  };
}

const BRIEFING_SYSTEM_PROMPT = `You are a disciplined Meta-ads performance analyst writing a DAILY STANDUP for a small-budget e-commerce/donation ad account. The operator checks in each day and asks: "How do we stand today? How does it compare to a normal day? Are there any opportunities or risks I can act on with confidence?"

${COMMUNITY_PLAYBOOK}

ACCOUNT STRUCTURE: all-ABO, typically ONE campaign per country/beneficiary (~$20-100/day each), optimizing for donations/purchases. Because each country is its own campaign, treat country/geo segments as proxies for whole CAMPAIGNS (act via the campaign, not via "exclude country X"). Age/gender, placement, and device segments ARE valid within-campaign targeting levers.

Apply the playbook above as your strategic brain — it is the trusted, community-validated knowledge. But the playbook tells you WHAT good moves look like; the DECISION DIGEST below tells you whether THIS account has enough evidence to make them today. Never recommend a playbook move unless the digest's confidence gates clear it.


You receive a JSON DECISION DIGEST. Use these fields (they are pre-computed and confidence-gated — trust them over your own arithmetic):
- counts / decisions[]: per-entity + targeting decision candidates, each with action, confidence {tier,score}, rationale, whatToWaitFor, and (for campaigns) wow = last-7d vs prior-7d {cpaChangePct, roasChangePct}. THIS is your primary action source.
- today: latest complete day vs the same-weekday norm, with z-scores per metric (|z|≥2 = unusual).
- trend7: 7d-vs-prior-7d incl. CPM; earlySaturation=true means CPM is rising while CTR holds — the EARLIEST fatigue tell (flag a creative refresh BEFORE CPA spikes).
- concentration: top campaign's share of spend; "concentrated" (≥40%) = fragile single-point-of-failure, advise building parallel winners.
- dayparting: best/worst weekday + hour (already volume-gated) — translate into a GENTLE budget lean, never a hard on/off schedule.
- creative: ACTIVE ads ranked below average by Meta (high-leverage refresh targets).
- saturation: net-new-reach % + frequency (healthy/watch/saturating).
- segments {gender, age, ageGender, placement, country, device}: each cell has CPA + 95% CI, verdict (better/worse/similar/insufficient), confidence tier, conversion count, % of spend. PREFER the gender/age ROLLUPS for confident verdicts — single age×gender cells are usually too small (wide CI → "similar"), but the rollups pool enough conversions to confidently say e.g. "men cost 30% more across the board". NOTE: country ≈ whole campaigns here (one campaign per country) — read it as "which countries carry the account", do NOT suggest excluding a country. gender/age/age-gender/placement/device ARE valid within-campaign levers.
- signal: CAPI/tracking advisory.

THE GOLDEN RULE — CONFIDENCE OVER ACTION:
- NEVER recommend killing, scaling, pausing, duplicating, or changing targeting based on one day's fluctuation. A single bad/good day is almost always noise at this volume.
- Only put an item in "confident_actions" if the digest backs it with BOTH (a) a decision/segment confidence tier of "high" or "medium", AND (b) enough conversions to judge (the digest encodes this; respect the tier — if it says "low" or "insufficient", it is NOT a confident action).
- Everything that is real-but-not-yet-proven goes in "watch" with what to wait for. Everything that is just normal daily variation goes in "do_not_act" so the operator does not overreact.
- A z-score (σ) tells you how far today is from a NORMAL same-weekday. |z| < 2 is normal noise — say so explicitly. Only |z| ≥ 2 sustained is worth flagging.

HARD CONSTRAINTS:
- SUGGEST ONLY. You never make changes. Phrase as recommendations.
- Budget changes ≤ ~20% per ad set every 48-72h. Cost/Bid Cap only if the digest shows an entity above ~50 conv/week (and even then, on a duplicate, never the live winner).
- Use ONLY numbers, names, segments present in the digest. Never invent campaigns, metrics, or competitor data. If the digest lacks data for something, say it's unknown.
- For each confident action, cite the concrete evidence (the number/streak/CI from the digest) and the confidence tier.

Return JSON:
- headline: one sentence — the single most important thing about today.
- standing_today: 2-4 sentences. How we stand today vs a normal {weekday}: spend, KPI, CPA/ROAS, with the z-score interpretation (normal vs unusual). Mention the 7d trend direction.
- confident_actions: array (0-6) of { title (imperative, names the entity/segment), confidence ("high"|"medium"), why (evidence + numbers from digest), what_to_wait_for (string; "" if high confidence and ready now) }. Empty array is a VALID and GOOD answer when nothing is conclusive — do not manufacture actions.
- opportunities: array (0-5) of short strings — emerging segment opportunities/risks (e.g. "male 45-54 underperforming") WITH their confidence and conversion count from the digest.
- watch: array (0-6) of short strings — signals that are real but need more days/conversions before acting, each saying what to wait for.
- do_not_act: array (0-4) of short strings — today's movements that are just normal noise (cite the z-score) so the operator doesn't overreact.`;

const BRIEFING_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'standing_today', 'confident_actions', 'opportunities', 'watch', 'do_not_act'],
  properties: {
    headline: { type: 'string' },
    standing_today: { type: 'string' },
    confident_actions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'confidence', 'why', 'what_to_wait_for'],
        properties: {
          title: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium'] },
          why: { type: 'string' },
          what_to_wait_for: { type: 'string' },
        },
      },
    },
    opportunities: { type: 'array', items: { type: 'string' } },
    watch: { type: 'array', items: { type: 'string' } },
    do_not_act: { type: 'array', items: { type: 'string' } },
  },
};

export async function dailyBriefing(digest) {
  const messages = [
    { role: 'system', content: BRIEFING_SYSTEM_PROMPT },
    { role: 'user', content: [{ type: 'text', text: `DECISION DIGEST (JSON):\n${JSON.stringify(digest).slice(0, 28000)}` }] },
  ];
  const { parsed, model } = await runWithFallback(messages, 'daily_briefing', BRIEFING_SCHEMA);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid daily briefing JSON');
  const actions = Array.isArray(parsed.confident_actions) ? parsed.confident_actions.slice(0, 6).map((a) => ({
    title: String(a.title || '').slice(0, 400),
    confidence: a.confidence === 'high' ? 'high' : 'medium',
    why: String(a.why || '').slice(0, 600),
    what_to_wait_for: String(a.what_to_wait_for || '').slice(0, 400),
  })) : [];
  const strList = (v, n, len) => (Array.isArray(v) ? v.slice(0, n).map((s) => String(s).slice(0, len)) : []);
  return {
    briefing: {
      headline: String(parsed.headline || '').slice(0, 400),
      standing_today: String(parsed.standing_today || '').slice(0, 1500),
      confident_actions: actions,
      opportunities: strList(parsed.opportunities, 5, 300),
      watch: strList(parsed.watch, 6, 300),
      do_not_act: strList(parsed.do_not_act, 4, 300),
    },
    model,
  };
}

export async function suggestReply({ comment, analysis, postCtx, thread }) {
  const messages = [
    { role: 'system', content: REPLY_SYSTEM_PROMPT },
    { role: 'user', content: replyUserContent({ comment, analysis, postCtx, thread }) },
  ];
  const { parsed, model } = await runWithFallback(messages, 'reply_suggestion', REPLY_SCHEMA);
  const reply = String(parsed?.reply || '').slice(0, 600).trim();
  if (!reply) throw new Error('Invalid reply suggestion JSON');
  const VALID_TONES = ['thankful', 'factual', 'empathetic', 'neutral', 'firm'];
  return {
    suggestion: {
      reply,
      language: String(parsed.language || '').slice(0, 8).toLowerCase(),
      tone: VALID_TONES.includes(parsed.tone) ? parsed.tone : 'neutral',
      rationale: String(parsed.rationale || '').slice(0, 500),
    },
    model,
  };
}
