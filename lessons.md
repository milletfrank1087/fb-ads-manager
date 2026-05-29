# lessons.md — FB ads manager

Running log. Every field-tested finding lives here. Format:

```
## YYYY-MM-DD short title
- finding
- evidence (URL, error code, response header, etc.)
- consequence (what we changed because of it)
```

---

## 2026-05-29 AI brain v2 — community playbook + enriched signals + scale-up gate

Sprint to make the advisor "better than SOTA": feed it the best community (non-Meta) strategy and richer data, while keeping the confidence discipline.

- **Curated community playbook is now the AI's brain** (`COMMUNITY_PLAYBOOK` in `analyzer.js`, injected into both strategy + briefing prompts). Distilled from 2026 ecommerce/practitioner sources (Skaleit, RocketshipHQ, trycrush, Wevion, Instrumnt, r/PPC-style write-ups) and **deliberately excludes Meta's own in-app advice** (it optimizes for spend, not ROI). Cross-validated, and includes the disconfirming nuances: consolidation's saturation-cliff risk, Advantage+ attribution cannibalization, bid-cap-beats-cost-cap (only >50 conv/wk), frequency<1.5 = valuable TOF driver, which-metric-broke-first diagnostic. The prompt is explicit: **playbook = what good looks like; the decision digest = whether THIS account has the evidence.**
- **CPM is the earliest saturation signal — added to `trend7`.** Rising CPM (≥15% WoW) at a flat/holding CTR fires `earlySaturation` and precedes the visible CPA spike. Live caught it: account CPM +32.8% WoW with CTR holding → amber banner + the AI headline "early signs of creative fatigue". Far earlier than waiting for CPA to blow out.
- **Concentration risk (`buildConcentration`).** One campaign >40% of active spend = `concentrated`. Live: GBM Mariana-Portugal = 65.9% → flagged. Counter-point to naive "consolidate everything"; a single fatigue cycle can take the account down.
- **Geo + device breakdowns added** (`bd_country`, `bd_device`). **Gotcha:** this account runs one campaign per country, so an account-level country verdict ≈ a whole campaign. Country is therefore **context-only** (excluded from targeting *actions*) — recommending "exclude country ES" would be nonsense when ES is its own campaign. Device IS a valid within-campaign lever and stays actionable.
- **Scale-up safety gate (the important bug).** The engine flagged Portugal `scale_up` on a 3-day winning streak while its **7-day ROAS was −33% / CPA +58%**. Per the playbook ("never scale into a degrading weekly trend") this is wrong. Added a WoW gate: a 3-day streak is downgraded to `hold` when WoW ROAS ≤ −20% or WoW CPA ≥ +25%. Recent-days momentum and weekly trend can disagree — the weekly trend wins for scaling decisions.
- **Per-campaign `wow`** (last-7d vs prior-7d cpa/roas/conv) attached to every campaign decision so the AI can cite the trend ("Portugal CPA +58% WoW") instead of just a point estimate.
- **UX:** confidence legend (high/medium/low/insufficient + σ), copy-briefing button, early-saturation + concentration cards, 7d CPM column, geo/device tables. All verified in-browser, no console errors (only the benign Tailwind-CDN notice).

### Sprint 2 additions (same day)

- **Digest truncation was silently gutting the AI (critical fix).** The decision digest hit 26k chars but the briefing prompt slices at a char budget, and `decisions`/`concentration`/`dayparting` were serialized AFTER the verbose `segments` block → the AI was building the daily briefing WITHOUT the per-entity decisions, falling back to generic CAPI advice. Fix: (1) reorder the digest so decision-critical fields serialize FIRST and `segments` LAST, (2) cap country to top-15 by spend (was 45), (3) raise the slice to 28k. Digest dropped to ~20k; the briefing immediately started naming specific entities ("refresh Serafina/Portugal", "watch Portugal's degrading trend"). **Lesson: when you truncate a JSON prompt, key order = priority order; put the payload you can't afford to lose first.**
- **Gender/age ROLLUPS surface real patterns that per-cell analysis hides.** Individual age×gender cells (29-45 conv) have CIs too wide to clear the baseline → all "similar". But aggregating to gender (Male = 169 conv) gives a HIGH-confidence "worse" verdict ($6.74 vs $5.67 account). This is the rigorous way to answer the user's "is male 45-54 underperforming?" — pool the sample, don't react to noisy single cells. Added `segments.gender` + `segments.age` and fed them to targeting decisions (gender/age ARE valid within-campaign levers; country is NOT — it's per-campaign here).
- **Platform rollup (FB/IG/Audience Network) is a high-leverage lever.** Same rollup logic applied to `publisher_platform`: live caught Instagram at $14.75 CPA (vs $5.41 Facebook) on 7.1% of spend. Lowered the `narrow_targeting` impact floor 8%→5% so a statistically-significant junk placement that's small but real still surfaces. The AI correctly routes it to "Watch — monitor another week" when only medium-confidence, rather than a confident exclusion — the confidence gate doing its job.
- **Scale-up safety gate:** a 3-day winning streak still gets downgraded to HOLD when WoW ROAS ≤ −20% or CPA ≥ +25%. Recent-days momentum and the weekly trend genuinely disagree (Portugal: 3-day winner but −33% WoW ROAS); for SCALING the weekly trend must win. Caught a real would-be mistake.
- **Dayparting in the daily briefing:** reused the strategist's volume-gated weekday/hour patterns → "Sat best (ROAS 6.85), Wed worst — gently weight budget". Framed as a lean, never a hard on/off schedule (starves learning at low volume).
- **Frequency<1.5 = fresh-audience headroom**, not a problem: lower ROAS there is normal top-of-funnel prospecting. Surfaced as a "headroom to scale" badge + note instead of a fatigue warning.
- **Robustness:** `buildDecisionDigest` ctx now has array/object defaults; analyze verified across last_7d / last_30d / last_90d (short windows degrade `today.reliable` to false rather than crashing). Narrative + briefing endpoints both healthy; Full Analysis tab unaffected.

### Sprint 3 — growth/revenue advisory (raise donations, not just defend CPA)

User context: setup is **1 campaign = 1 geo = 1 url, one shared pixel** (donation campaign, `ptg.risehope.online` — Mariana glioblastoma fund). Asked the AI to also advise how to *increase* revenue. Existing engine only did defensive moves (kill/scale/pause/exclude); added a parallel **growth** layer.

- **Research (3 rounds + disconfirmation) verdict — incrementality, not dashboard ROAS, is the ranking key:**
  - **Prospecting is the real engine** (55-75% incremental in geo-holdout studies) vs **retargeting 15-35%** (its dashboard ROAS is inflated 3-5× — those buyers were already converting). So the growth budget goes to COLD, not warm.
  - **Donor-seed lookalikes** are the #1 lever; seed quality > size; manual 1% beats Advantage+/broad below ~50 conv/wk + $30-50/day (this account's zone). A pixel shared across beneficiaries pools a bigger/stronger seed — an advantage here.
  - **Bid/cost caps DISCONFIRMED for this budget** — they need ~50 conv/wk AND ~€5k/wk per ad set; below ~€2k/wk they starve delivery. Tagged `avoid`. (Counter to generic "use cost caps to control CPA" advice.)
  - **CAPI is the foundational unlock** (recovers 20-45% lost conversions, sharpens seeds, enlarges retarget pools, prerequisite for Value Optimization). Probe shows it's NOT confirmed → ranked `foundational`, do-first.
  - **Value Optimization** fits variable donation sizes (15-30% lift potential) but is gated on CAPI + ~50-100 purchases/wk. Live: ~136 donations/wk clears the volume bar, so CAPI is the *only* thing gating it.
- **`buildGrowth` (`decisions.js`)** turns the playbook into account-specific output: a **funnel** (LPV→ATC→IC→purchase with per-step drop% + biggest absolute leak + abandoner pool), **headroom** (campaigns still at freq<1.6), **value** readiness, and a ranked `levers[]`. Live funnel was genuinely insightful: **90.6% drop Landing→ATC** (19,870 lost = page/offer-match problem) and **68.6% checkout→donation** = **1,273 warm abandoners** (the one incremental retarget pool). Needed a new `ic`/`icTotal` aggregate in `strategist.js`.
- **AI wiring:** appended a GROWTH section to `COMMUNITY_PLAYBOOK` (both prompts) + added a `growth_moves[]` output to the briefing (title/impact/why/effort). Live AI produced exactly the right ladder: CAPI now → 1% donor lookalikes this week → small abandoner layer (grounded in the real 1,273) — and did NOT pitch bid caps. Strategy/Full-Analysis prompt also nudged toward prospecting via existing `scale_horizontal`/`duplicate`/`fix_tracking` enums (no schema break).
- **Gotcha — overlapping lenses:** the segment rollups (gender/age/platform) are NON-additive views of the same spend; the prompt already warns against stacking exclusions. Growth levers are similarly sequenced ("apply ONE, re-measure") rather than "do all five", to avoid resetting learning on a low-volume account.
- **UI:** `growth_moves` block in the briefing (impact/effort chips) + a dedicated **Growth & funnel** card (funnel bar with drop-offs, biggest-leak note, color-coded ranked levers). Verified in-browser; no app console errors.

---

## 2026-05-29 Strategy advisor (suggest-only performance AI)

Built `server/lib/strategist.js` + the header **Strategy** drawer: analyze the account, propose a ranked plan, never write.

- **One batched read for the whole snapshot.** Account daily series (`time_increment=1`), campaign+adset aggregates, entity rows, and three breakdowns (placement / age-gender / hourly) all go in a single `fb.batch` (8 ops). Live: full 30-day analysis in ~3.4s, narrative in ~2.9s, one batched Graph call. Keeps the suspension/rate surface tiny vs. N per-entity calls.
- **Strategy ranking that survived disconfirmation (research):** for a low-budget, all-ABO account the highest-leverage move is **consolidation** (merge fragmented ABO ad sets so each clears Meta's ~50 conversions/week learning threshold), then **modest vertical scaling (≤20%/48-72h)** on median-beating campaigns, then **horizontal scaling via PAUSED duplicates**. **Cost Cap / Bid Cap rank LAST and are actively discouraged** here — at <50 conversions/week they starve delivery. Surf/wave scaling is a duplicate-and-rotate tactic, not a budget cap. These constraints are hard-coded into `STRATEGY_SYSTEM_PROMPT` so the Gemini narrative can't recommend a footgun.
- **Pick the KPI the account actually optimizes.** `pickKpi` falls back purchases → other standard conversions → link clicks. Judging a donation account on "purchase ROAS" when the pixel fires a custom event would mislabel winners as losers.
- **Every pattern carries a `reliable` flag** gated on conversion volume; UI shows a "low data" chip and the AI prompt is told patterns are directional. Weekday/hour widen to up to 90 days even for a 30-day headline window — 7 buckets need samples. Without this, a single good Saturday reads as "Saturday is +110%".
- **Breakdown Effect warning on placements.** Don't cut the worst-CPA placement blindly: Meta allocates "expensive" segments because they assist conversions elsewhere. Surfaced as an inline ⚠ in the placements card so the operator doesn't over-prune.
- **`learning-limited` is the headline KPI** (active ad sets below ~50 conv/wk). The per-adset table computes `minDailyToExit ≈ cost-per-result × 50/7`, turning a vague "fund it more" into an exact number (e.g. ES needs ~$85/day vs the $50 it has).
- **UI gotcha:** the drawer body is its own `overflow-y-auto` scroll container inside `fixed inset-0`; the browser-tool page scroll doesn't move it. Use `scrollIntoView` on a ref *inside* the body, or a full-page screenshot, to verify lower sections.

---

## 2026-05-28 Project bootstrap — researched baseline

### Graph API version

- Latest stable: **v25.0**, released **February 18, 2026**, available indefinitely (next version TBD).
- Marketing API v25.0 launched same day. v22 expires June 9, 2026 — don't pin to old versions.
- Source: https://developers.facebook.com/docs/graph-api/changelog/version25.0/

### Batching: what it actually saves

- **CRITICAL FINDING:** batching does **NOT** reduce rate-limit consumption. Each sub-call in a batch counts as a separate call against `call_count` and CPU/time quotas.
- Confirmed by Meta docs ("batch of 10 API calls will count as 10 calls") and real-world testing on Stack Overflow.
- Source: https://developers.facebook.com/docs/graph-api/batch-requests/
- Source: https://stackoverflow.com/questions/8805316/facebook-graph-api-rate-limit-and-batch-requests
- **What batching DOES save:** HTTP/TLS handshake overhead, proxy bandwidth, latency, response-time wait. Still very valuable for our proxied setup.
- **What ACTUALLY reduces call_count:** field expansion (`fields=ads{campaign,adset,creative{...}}`) — multiple "nested joins" count as ONE call against the rate limit. Use this aggressively.
- Source: https://stackoverflow.com/questions/14626689/do-facebook-graph-api-calls-using-field-expansion-count-differently-against-the
- **Consequence:** AGENTS.md priority order is field expansion > cache > batch > throttle.

### Rate-limit headers

- `x-app-usage` — JSON `{call_count, total_cputime, total_time}`, each 0–100%. Throttled at 100.
- `x-business-use-case-usage` — keyed by ad-account ID; per BUC type (`ads_management`, `ads_insights`, `pages`, etc.). Includes `estimated_time_to_regain_access` in minutes.
- `x-ad-account-usage` — older platform tier signal (`acc_id_util_pct`).
- Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/

### Rate-limit error codes

- `4` — App-level too-many-calls.
- `17` — User request limit reached.
- `32` — Page-level throttle.
- `613` — Too many calls from this ad-account.
- `80000`–`80004` — BUC limits. `80004` = "Business Use Case limit reached".
- `190` — OAuth token expired/invalid (NOT a rate limit; stop and refresh).
- `100`/`200` — Missing required permission.
- Source: https://www.adamigo.ai/blog/meta-api-limits-best-practices-for-data-sync

### Operational caps (hard limits, not BUC-scored)

- Ad set budget edits: **4× per hour per ad set**.
- Account spend limit edits: **10× per day per account**.
- Custom audiences: **500 per account**.
- These trigger immediate throttle regardless of tier — DO NOT rely on BUC headers to predict them.
- Source: https://www.adamigo.ai/blog/meta-api-limits-best-practices-for-data-sync

### Permission requirements (for our goals)

- Full ad management: `ads_management` (NOT satisfiable by `ads_read` alone — `ads_read` is read-only).
- Programmatic ad-account access for external advertisers: requires Business Verification + App Review with `ads_management` justification.
- For our single-Page own-asset use case, we can use a personal User token in dev mode without App Review.
- Source: https://developers.facebook.com/docs/permissions
- Source: https://adlibrary.com/posts/facebook-ads-api-integration

### Batching gotchas (Marketing API specific)

- **Cannot batch multiple Adsets under the same Campaign** in one request — Meta rejects the whole batch. Group/split by campaign when bulk-editing ad sets.
- Use `name` + `{result=name:$.id}` JSONPath in subsequent sub-ops to chain creates (campaign → adset → ad) in a single round-trip.
- Source: https://developers.facebook.com/docs/marketing-api/asyncrequests/

### Tier note

- Default Marketing API tier is `development_access` (low limits).
- `standard_access` requires App Review for "Ads Management Standard Access" feature.
- Standard tier cap: ~9000 BUC points per window.
- Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/

---

## 2026-05-28 Probe results

### Proxy

- Egress IP: `155.103.142.153` (matches `PROXY_HOST` exactly), country US, org `AS19793 Linivo LLC`, NYC, `America/New_York`.
- Latency to `ipinfo.io` through proxy: ~1.9s warm. Acceptable.
- `egressMatchesProxy: true` — the proxy is a clean dedicated IP, not a load-balanced pool.

### Tokens

Both `FB_ACCESS_TOKEN` and `FB_USER_ACCESS_TOKEN` are valid, **never expire**, but their **data-access** expires `2026-08-20T15:41:47Z` (~12 weeks from today). At that point Meta will start returning subset data; we'll need to re-prompt the user for permissions before that date. Both tokens belong to app **Comments** (`974273918718391`), user `835775966269503`.

- Page token: `type=PAGE`, `profile_id=113297813778299` (RiseHope). Use for Page/post/comment ops.
- User token: `type=USER`. Use for `/me/adaccounts`, `/me/businesses`, ad-account writes.
- Tokens have **identical scopes** (10 scopes — see below). The User token is the one to use for ads operations.

### Scopes present (10)

```
ads_management         pages_manage_engagement   pages_read_engagement
ads_read               pages_manage_metadata     pages_read_user_content
pages_manage_ads       pages_manage_posts        pages_show_list
public_profile
```

### Scopes missing for stated goals (2)

- `business_management` — **blocks `/me/adaccounts` and `/me/businesses` enumeration** (FB returns code 100 "Requires business_management permission"). Workaround: if we know an ad-account id (e.g. `act_1234567890`), set it in `FB_AD_ACCOUNT_ID` and we can manage it directly because `ads_management` is granted. The missing scope only blocks *discovery*, not operation.
- `read_insights` — Page-level + post-level organic insights. Not required for ads operations (those use `ads_read`). Would unlock `/{page-id}/insights` and `/{post-id}/insights`.

### Page asset

- Target page: **RiseHope** (`113297813778299`), 1346 fans.
- User's role on RiseHope (from `/me/accounts` tasks): `MODERATE`, `MESSAGING`, `ANALYZE`, `ADVERTISE`, `CREATE_CONTENT`, `MANAGE`. This is full admin.
- Only 1 Page is visible to this token (single-Page setup, matches the reference project).

### What we CAN do right now

- **Full ad management** on any ad account whose ID we know (`ads_management` present): create / edit / pause / duplicate campaigns, ad sets, ads, creatives; pull insights with `ads_read`.
- **Full post management** on RiseHope: create, edit, schedule, delete posts (organic + dark/unpublished page posts via the Marketing API).
- **Full comment moderation** on RiseHope: read, like, reply, hide, unhide, delete comments (`pages_manage_engagement` + `pages_read_engagement` + `pages_read_user_content`).
- **Block / unblock users** on RiseHope by PSID (`pages_manage_metadata`).
- **Read ad insights** through the proxy.

### What we CANNOT do

- Cannot enumerate ad accounts via `/me/adaccounts` (gate: `business_management`).
- Cannot enumerate Business Managers via `/me/businesses` (gate: `business_management`).
- Cannot read organic Page insights via `/{page}/insights` (gate: `read_insights`).
- Cannot moderate Instagram (no `instagram_*` scopes).
- Cannot block users across multiple Pages from one click — blocked list is per-Page.
- Cannot create system users (we'd need a BM admin token).

### Rate-limit headers observed

- `x-app-usage: {call_count: 6, total_cputime: 0, total_time: 20}` — 6% of the app-level call_count budget after the probe (3 GETs + 1 batch with 5 sub-ops = 8 logical calls). Comfortable margin.
- `x-business-use-case-usage`: NOT returned by these endpoints (BUC headers only appear on Marketing API endpoints — we'll see them once we hit `/act_*/{campaigns,ads,insights}`).
- `x-ad-account-usage`, `x-page-usage`: also not returned by these probes. Expected.

### Action items

1. **(Recommended)** Add `business_management` to the App's permission set and re-auth in Graph Explorer to enable `/me/adaccounts` discovery. Without it the dashboard needs the user to paste ad-account IDs manually.
2. **(Optional)** Add `read_insights` if we want organic Page analytics.
3. **(Pragmatic short-term)** Have the user paste a known `act_xxxxxxxx` into `FB_AD_ACCOUNT_ID` so the next `probe.py` run smoke-tests ads_management on a real account.
4. **(Watch)** `data_access_expires_at = 2026-08-20`. Build the long-lived-token refresh flow before that date.
5. **(Confirmed)** All requests routed through `155.103.142.153:12323` — proxy egress verified.

### Probe script bugs found and fixed during this session

- `/{page_id}?fields=...,tasks` is invalid in v25.0 — `tasks` only exists on `/me/accounts` items. Removed.
- Added `FB_AD_ACCOUNT_ID` env fallback so the smoke test can still run when `/me/adaccounts` is gated.

---

## 2026-05-28 Deep research — optimal token + tier for ads-manager clone

### Token-type → rate-limit-type mapping (official, v25.0)

Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/

| Token type            | Rate-limit logic         | Notes |
| --------------------- | ------------------------ | --- |
| Application token     | Platform                 | App-level: `200 × users/hour` |
| User access token     | Platform                 | Per-user, shared across apps, low |
| **System user token** | **Business Use Case**    | Highest quotas for Marketing API |
| **Page access token** | **Business Use Case**    | When used with Pages API |

**"If both Platform and BUC limits can apply, BUC wins."** → System user + Page tokens are the only path to BUC-tier quotas.

### BUC formulas (the actual numbers)

For our ad account (Limited Access tier, formerly "Standard"):
- **Ads Management:** `300 + 40 × active_ads` calls per hour
- **Ads Insights:**   `600 + 400 × active_ads − 0.001 × user_errors` calls per hour
- **Custom Audience:** `5,000 + 40 × active_audiences` calls per hour (hard cap 700,000)
- **Pages (page/sys-user token):** `4,800 × engaged_users_24h` calls per 24h

For Full Access tier (formerly "Advanced"):
- **Ads Management:** `100,000 + 40 × active_ads` calls per hour (~330× more)
- **Ads Insights:**   `190,000 + 400 × active_ads − 0.001 × user_errors` calls per hour
- **Custom Audience:** `190,000 + 40 × active_audiences` calls per hour

### Operational caps (do NOT change with tier)

- Ad set budget edits: **4 per hour**
- Ad account spend limit edits: **10 per day**
- Custom audiences: **500 per account**
- Real-time mutations (e.g. launching ads): **100 QPS regardless of tier**
- Source: https://www.adamigo.ai/blog/meta-api-limits-best-practices-for-data-sync

### Marketing API Access Tier (formerly AMSA) — renamed May 4, 2026

- Lower tier: **"Limited Access"** (formerly "Standard"). Default for new apps. Sufficient for own ad accounts.
- Upper tier: **"Full Access"** (formerly "Advanced"). Required for serving OTHER businesses' accounts.
- Qualification for Full Access (revised May 4, 2026):
  - 500+ Marketing API calls in past 15 days (was 1500)
  - Error rate < 15% over last 500 calls (rolling window)
  - Screencast no longer required
- Source: https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/

### Field expansion vs multi-id vs batch — the actual rate-limit math

Source: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/#faq

| Pattern | Calls counted | HTTP requests | Saves quota? |
| --- | --- | --- | --- |
| `GET /id1`, `GET /id2`, `GET /id3` (sequential) | 3 | 3 | — |
| `GET /?ids=id1,id2,id3` | **3** | 1 | NO (each id counts) |
| `POST / batch=[3 ops]` | **3** | 1 | NO (each op counts) |
| `GET /id1?fields=field_a{...},field_b{...},field_c{...}` (single node, nested fields) | **1** | 1 | **YES** |

→ **Field expansion on a single node is the ONLY way to actually reduce `call_count`.** Multi-id and batch help proxy/network overhead, not quota.

### System-user-token gotchas (disconfirmation pass)

- Tokens can be invalidated by Meta on: ad-account permission changes, BM admin role restructuring, unusual API patterns, failed policy reviews. Treat 190 errors as "must re-bootstrap".
- "Apps in Development mode can only request permissions from role users" — fine for own use; the app stays in Development mode for personal projects.
- "Only apps with Ads Management API standard access [now 'Limited Access'] and above can be installed [on a system user]" — default for new apps, always satisfied.
- A system user CAN have access revoked if the admin who created it leaves the business. **Mitigation: rotate tokens before that happens; have multiple admins.** Confirmed by community thread (developers.facebook.com/community/threads/298900323271544/).
- For **server-to-server calls**, enable "Require App Secret" in App Dashboard → Settings → Advanced. This forces every call to include `appsecret_proof = HMAC-SHA256(access_token, app_secret)`. Defends against token theft. We have `FB_APP_SECRET` already so we can do this.

### Async Insights for large data pulls

- `POST /act_*/insights` with the same body as a sync GET creates an async report job; returns `report_run_id`.
- Poll `GET /{report_run_id}?fields=async_status,async_percent_completion` until `async_status=Job Completed`.
- Then `GET /{report_run_id}/insights` to fetch.
- Avoids `total_time` blowups on large date ranges or many breakdowns.
- v25.0 now returns detailed `error_code` (int) on async failures.

### Verdict for our project

- **Optimal token: System User Access Token from Business Manager**, scopes covering ads_management, ads_read, business_management, pages_manage_ads, pages_manage_posts, pages_manage_engagement, pages_manage_metadata, pages_read_engagement, pages_read_user_content, pages_show_list, read_insights. Use `set_token_expires_in_60_days=true` (security best practice) and build the refresh loop.
- **Optimal tier: Start at Limited Access** (default, free). After we accumulate 500 Marketing API calls + maintain <15% error rate, submit for Full Access for a 330× quota bump on ads_management.
- **Optimal security: enable Require App Secret + send `appsecret_proof` on every call.**
- **Optimal call pattern: field expansion first, async insights for big reports, batch for HTTP overhead, throttle 750ms between top-level calls, cache aggressively with short TTL on engagement data.**

---

## 2026-05-28 Bootstrap COMPLETE — production token live

### Final state

- **Business Manager:** `reddingtonv6` (`1162517778681857`), verification `not_verified` (fine for own use).
- **App:** `Comments` (`974273918718391`), Business app type, Development mode (correct).
- **System user:** `fb-ads-manager-sysuser` (app-scoped id `122099203467342360`, BM-scoped id `6159027088785`).
- **System user token:** `EAAN2GNL...ZDZD` (len 204), type `SYSTEM_USER`, **`expires_at=0` (NEVER EXPIRES)**, `data_access_expires_at=0` (also never). Persisted to `.env` as `FB_SYSTEM_USER_ACCESS_TOKEN` and `data/system_user_token.json`.
- **Scopes on the system user token: 43.** BM dialog auto-included every scope the app has, well beyond the 11 we asked for. Bonuses include Instagram (`instagram_basic`, `instagram_manage_comments`, `instagram_manage_insights`, `instagram_manage_messages`, `instagram_content_publish`, `instagram_shopping_tag_products`), WhatsApp Business (`whatsapp_business_management`, `whatsapp_business_messaging`), Threads (`threads_business_basic`), Catalog/Commerce (`catalog_management`, `commerce_account_*`), Lead Gen (`leads_retrieval`), Branded Content, Page CTA, page_events, publish_video, read_page_mailboxes, attribution_read, paid_marketing_messages, manage_app_solution, private_computation_access.
- **Ad accounts visible (5):** GFM Italy, GFM Greece, GFM Germany, GFM Backup (disabled), Bucket Acc — all USD.
- **Pages visible: 0** via `/me/accounts` (RiseHope is NOT yet in this BM). For RiseHope ops we currently still use `FB_ACCESS_TOKEN` (page token).

### Bootstrap path (what actually worked)

1. `proxy_check.py` → proxy verified.
2. `probe.py` → inventory of current scopes; discovered `business_management` gap.
3. Graph Explorer one-time re-auth → added `business_management` + `read_insights` to user token.
4. `exchange_token.py SHORT_TOKEN` → long-lived user token persisted.
5. **UI: claim Comments app into BM** (Business Settings → Apps → Add → paste App ID).
6. `setup.py` → identified BM, created system user, assigned all 5 ad accounts with MANAGE/ADVERTISE/ANALYZE; **stopped on `POST /{sysuser_id}/applications` with error code 3957 sub 1690147 "Something went wrong while TOS-ing the app"**.
7. **UI: assign Comments app to system user** (Business Settings → Apps → Comments → Assign people → fb-ads-manager-sysuser → Full control).
8. **UI: generate token** (System Users → Generate token → 11 scopes → Generate).
9. `save_system_token.py PASTED_TOKEN` → token verified, scope-listed, persisted.
10. `smoke_test.py` → end-to-end confirmation across 4 active accounts (campaigns, ads, insights, account meta), all OK.

### Key gotcha: error 3957 / 1690147 — "TOS-ing the app"

- **What it means:** the system user installation endpoint can't auto-accept the app's terms of service because the app is missing prerequisites (most commonly: Privacy Policy URL not set in App Dashboard → Settings → Basic, sometimes also unverified Business connection).
- **Fix path 1 (used):** generate the token directly in the BM UI (`business.facebook.com → System Users → Generate token`). Meta's internal flow handles ToS server-side, bypassing the public-API ToS check.
- **Fix path 2 (for future full automation):** set a public Privacy Policy URL in App Dashboard → Settings → Basic → "Privacy Policy URL" field, then `POST /{sysuser_id}/applications` works. We deferred this.
- **Two role assignments are independent in BM:**
  1. *App is owned by the BM* — done via Business Settings → Apps → Add. Without this, system user creation works but install fails with a different error.
  2. *App is assigned to the system user with a role* — done via Business Settings → Apps → Comments → Assign people. Without this, the "Generate Token" dialog shows "No permissions available" at the Assign-permissions step.

### Smoke test data captured

- **GFM Greece (act_1622353565055773)** is LIVE: 7d spend $1,308.49, 82,877 impressions, 17,589 clicks, **CTR 21.22%, CPC $0.07**. Lifetime spend $1,145,195, balance $1,346.
- **GFM Italy (act_1388808955587972)**: $99,493 lifetime, all paused.
- **GFM Germany (act_564815712729835)**: $0 lifetime, paused.
- **Bucket Acc (act_616824728131340)**: $90,281 lifetime, all paused, status `WITH_ISSUES` on ads (probably Meta policy review pending).
- **GFM Backup (act_581209504462976)**: status=2 (DISABLED).
- **BUC headers were null** on this smoke test — Meta only emits them on Marketing API endpoints after enough volume. Will appear on subsequent dashboard usage; we already capture them in the client.

### What the project can now do

Without any further setup, with the persisted `FB_SYSTEM_USER_ACCESS_TOKEN`:

- Full CRUD on campaigns, ad sets, ads, creatives across all 4 active ad accounts.
- Read insights for any account / campaign / ad / breakdown via sync and async paths.
- Manage custom audiences (5,000 + 40×N quota on Limited tier, hard cap 700,000/h).
- Lead retrieval, catalog management, branded content, attribution reports.
- Instagram + WhatsApp + Threads as bonus surfaces (out of scope for now).

### What's still TODO

1. **Add RiseHope page (113297813778299) to the BM** so the system user can manage it too. Until then, use `FB_ACCESS_TOKEN` (the existing page token) for RiseHope comment/post operations. Trivial UI step: Business Settings → Pages → Add → paste Page ID.
2. **Enable "Require App Secret"** in App Dashboard → Settings → Advanced. Our client already signs every call with `appsecret_proof`, so flipping the toggle is zero-risk and adds defense in depth.
3. **(Optional) Set Privacy Policy URL** on the app to unlock the fully-automated install path (`POST /{sysuser_id}/applications` instead of UI).
4. **Apply for "Full Access" Marketing API tier** after ~2 weeks of dashboard usage → 500+ calls in 15d, <15% errors → 330× quota bump.
5. **Build the dashboard layer** on top of this token (sync/cache + Save-button writes + async insights polling + observability on BUC headers).

---

## 2026-05-28 Capability probe + scaling-technique research

### Capability matrix (system-user token via proxy, 4 active ad accounts)

22/24 surfaces are usable on every active account. Confirmed working:

- Account meta + capabilities flags
- Campaigns / ad sets / ads with full field expansion
- Insights at account level + 4 breakdowns: `publisher_platform×platform_position`, `age×gender`, `device_platform×impression_device`, `country`
- Custom audiences, saved audiences, ad pixels, custom conversions
- Ad images, ad videos, ad creatives, automated rules library, activities (audit log)
- Minimum budgets, delivery estimate, async insights jobs (create + poll proven)
- Targeting search (interests, geo, locale, education, behaviors, employers) — all OK
- BM owned ad accounts (5), owned apps (1), system users (1), business users (1)

Failing on our token (not blockers):

- `reachestimate` — error 100 (param format); we'll rebuild with the v25 schema later
- `matched_search_applications` — error 100 (app-store integration unrelated)
- `bm.is_disabled_for_integrity_reasons` — field doesn't exist on this BM (cosmetic)

Page-token (RiseHope) failures:

- `conversations` — needs `pages_messaging` (system user has it, page token doesn't)
- `page_call_to_actions` — no CTA configured on this Page
- `page_insights` + `posts_recent.insights` — Page Reach/Impressions metrics deprecated in v25; need to migrate to `page_total_media_view_unique` / `post_total_media_view_unique` (June 2026 cutover)

### Rate-limit tier confirmed

The first BUC header we captured reads: `{type: ads_insights, call_count: 1, total_cputime: 1, total_time: 1, ads_api_access_tier: "development_access"}`.

**We are on Development Access (== Limited tier).** Quota is ~60 points / 300-second window. Standard Access unlocks ~9,000 points (150× lift) after ~500 calls + 15 days at <15% error rate. Apply once we have organic dashboard usage to point at.

### 2026 platform shifts that MUST shape our build

| Shift | Source | Effect on scaling techniques |
|---|---|---|
| **Andromeda retrieval engine** (Dec 2024 launch, full deploy Oct 2025) — neural retrieval reads creative, not audience | Meta Engineering Blog, jetfuel.agency, scalemate.co, aureliusmedia | Lookalike audiences down ~49% ROAS vs broad. Interest stacks "starve the model". Creative diversity (10-20+ ads per set) is the new lever. |
| **GEM / Lattice / UTIS** above Andromeda — teacher-student model hierarchy, self-corrects against exploitation | greghal.no, Meta Engineering | Hacks burn out in days/hours. Treat the algorithm as "something to feed", not outsmart. |
| **Advantage+ Audience now default on all objectives** | Meta docs, alexneiman.com | Manual audience inputs are now "suggestions". Build around creative diversification, not audience layering. |
| **ASC/AAC deprecated** — block create/update on all MAPI versions May 19, 2026; auto-pause Sept 2026 | Meta developer blog, aimerce.ai, adsmaa.com | Anything we build for "shopping campaign" must use the new Advantage+ structure, not legacy `smart_promotion_type`. |
| **Page reach/impressions metrics deprecated June 2026** | Meta v25 changelog | Page-side analytics must use `*_total_media_view_unique` instead. |
| **Async insights error fields enhanced in v25** | Meta v25 changelog | When async jobs fail we now get `error_code/subcode/user_title/user_msg` — surface these. |
| **placement_soft_opt_out (v24)** — allow up to 5% spend to excluded placements when likely to help | Meta v24 changelog | Use instead of hard placement exclusions on Sales/Leads. |

### Scaling-technique ranking (2026 reality)

Scoring axes: **2026 effectiveness** (post-Andromeda), **API-readiness on Limited tier**, **risk of learning-phase reset**, **evidence depth**.

| # | Technique | 2026 effectiveness | API-readiness | Reset risk | Evidence |
|---:|---|---|---|---|---|
| 1 | **Surf Strategy** (ABO test → horizontal duplicate of winners → consolidate to CBO → 20%-rule vertical) | A+ | All endpoints we need are confirmed working | Low (built-in pacing) | trycrush.ai, benly.ai, michaeldconsulting.com case study ($125K profit in 45 days) |
| 2 | **20% Rule vertical scaling** (≤20% every 72h, gated on 7-day ROAS) | A | `POST {adset_id}` budget update, batched | Low | adrow.ai, ryze.ai, modernmarketinginstitute, 27five.com, capconvert, scalemate.co all confirm |
| 3 | **Horizontal duplication w/ Post-ID preservation** (clone winner ad set, reuse `effective_object_story_id` so likes/comments carry over) | A | `POST {act_id}/ads` w/ `creative.object_story_id` — confirmed reads work | Per-clone independent | admanage.ai (40-100% CTR lift), Social Media Examiner shotgun method |
| 4 | **Creative diversification (10-20+ ads per set)** — fuel for Andromeda's creative-as-targeting model | A | `POST {act_id}/adcreatives` + `POST {act_id}/ads` | None (additions don't reset) | scalemate.co, alexneiman.com (Motion 2026 study: 5% of ads drive majority of spend), skaleit.agency |
| 5 | **70/20/10 budget allocation** (70% always-on / 20% scaling / 10% creative testing) | A | Account-level aggregation across our existing insights endpoints | None | adlibrary.com, alexneiman.com, modernmarketinginstitute |
| 6 | **Hybrid pipeline ABO→CBO→Advantage+** | A | Campaign POST with `bid_strategy` + `daily_budget` at campaign vs adset level | Low (transitions are deliberate) | trycrush.ai, theoptimizer.io, capconvert |
| 7 | **Decision-intelligence rule chain** (pause / scale / swap creative / reset learning) — pre-defined signal→action playbook | A | `adrules_library` confirmed working — write rules through our API | Tunable | adlibrary.com decision-intel playbook, bir.ch automation guide |
| 8 | **Ad fatigue detection + creative swap** (3-day rolling CTR drop ≥15%, freq >3.5 cold / >3.0 retarget, CPM up ≥10%, hook-rate down ≥20%) | A | `insights` w/ `breakdowns=ad_id`, `frequency`, `ctr`, time-series — all confirmed | None (swap creative only) | adsgo.ai, sentrum.app, adlibrary.com ad-fatigue, get-ryze.ai, adstellar.ai, tripledart.com |
| 9 | **Audience overlap monitoring** with $ impact — Meta's auction-overlap signal + Inspect tool data | B+ | Limitation: Meta's overlap tool needs saved audiences not raw targeting specs; can read `customaudiences` + insights but not the diagnostic feed directly | None (read-only signal) | Meta Help Center, adstellar.ai, semrush, tailorededgemarketing |
| 10 | **Learning-phase health monitoring** (effective_status, 50-events/week math, learning-limited counter) | A | `effective_status` already in our ads/adsets reads | None | 27five.com, modernmarketinginstitute, multiple |
| 11 | **Bid strategy tuning** (Lowest Cost default, Cost Cap only with ≥$5k weekly per ad set AND hard CPA floor, Bid Cap rarely) | B | Writes via `POST {adset_id}/bid_strategy` | High if changed | adlibrary.com bid strategy guide, theoptimizer.io |
| 12 | **Budget pacing during learning** (cap at 60-70% of optimal until 50 events/week) | B+ | Daily-budget writes only | None | sagum.com, wevion.ai |
| 13 | **"Shotgun" method** (20+ ad sets, kill losers, scale winners) | C in 2026 | Easy to launch via batched creates | High (multiple parallel learnings) | Social Media Examiner 2023 — superseded by Surf + creative density |
| 14 | **Lookalike laddering** (1% → 2% → 3%) | **D** — debunked | Endpoint works | Wasted effort | jetfuel.agency, skaleit.agency, alexneiman ("effectively dead") — 49% lower ROAS than broad on accounts doing meaningful volume |
| 15 | **Interest-stack scaling** | **D** — debunked | Endpoint works | Restricts Andromeda | All same sources |
| 16 | **Dayparting** | C — situational | `adset.schedule` writes | Cuts signal volume | sagum.com — only defensible when tied to a quality metric (lead-to-close, refund rate, LTV), not "cheaper CPM at 8 PM" |
| 17 | **Aggressive (>30%) vertical jumps** | **F** | Trivial | Catastrophic | 20+ sources document 100-300% CPA spikes |

### What this means for our build

Top-1 lever we should ship: **the Surf pipeline as a first-class workflow** (sources call this surfing the winners). Concretely it is the orchestration of techniques 1+2+3+4+6+7+8 above. Everything else is a feature inside that workflow.

The capability probe confirms every Graph endpoint required for the Surf pipeline is **already accessible to our system-user token through the proxy on the Limited tier**. The dashboard's scaling features are not blocked by Marketing API access tier; we will hit quota walls only when running large historical insights pulls (handle via async + cache) or doing many writes/hour (handle via Save-button coalescing per AGENTS.md §6).

---

## 2026-05-28 (afternoon, second session) — Phase 1 dashboard shipped

After re-scoping: **GFM Greece only, read-only, on-demand, Node/Express**. Goal was a working data-fetching foundation that reproduces the live Ads Manager screenshot's column set, with absolute defense against rate-limit-driven account flags.

### Anti-suspension research synthesis (consulted before any code)

Five published 2026 ban signatures (sources: GoMarble incident analysis on Claude+MCP bans, HyperFX disable-cause ranking, Soku's MCP risk analysis, Meta's own rate-limiting docs):

1. Burst traffic → API expects "spread out", not bunched. Tight loops generate the exact pattern Meta's bot detection was trained on.
2. Bulk catalog/audience updates within minutes (real advertisers don't update 200 audiences in 5 min).
3. Malformed/impossible API calls → "incompetence or malicious probing". A 4xx storm gets reviewed.
4. Blind retries on rate-limit codes (`4 / 1504022`, `17 / 2446079`, `613`, `80000-80004`, `100 / 1487534`). A well-behaved client backs off; bots don't.
5. Per-ad-set budget edits >4/hour OR account spending edits >10/day → automatic 60-min lockout AND a flag.

Plus the "cascading ban" property: when one account in a BM trips a flag, Meta's automated systems often suspend everything in the same Business Manager.

### Field-name confirmation (Meta's own 2016 deprecation post is the gold-standard source)

For the user's screenshot columns, here is the verified mapping:

| Ads Manager column | Insights API field |
|---|---|
| Off/On (toggle) | `status` (entity, not insights) |
| Campaign | `name` (entity) |
| Delivery | `effective_status` (entity) |
| Amount spent | `spend` |
| Reach | `reach` |
| Impressions | `impressions` |
| Post comments | `actions[action_type=comment].value` (also `post_comment`, `onsite_comment` summed if present) |
| CPM | `cpm` |
| Unique CTR (link click-through) | `unique_inline_link_click_ctr` (post-v2.4 replacement for deprecated `unique_ctr`) |
| Unique link clicks | `unique_inline_link_clicks` (post-v2.4 replacement for `unique_clicks`) |
| CPC (cost per link click) | `cost_per_inline_link_click` (post-v2.4 replacement for `cpc`) |
| Landing views | `actions[action_type=landing_page_view].value` |

Verified live: with these field names, our backend's totals match the Ads Manager screenshot to the cent / single comment / impression across all 8 metrics, with the only drift being the 17-min clock skew between the screenshot capture and the live API pull.

### Server architecture

- **Node 22 + Express 4 + better-sqlite3 + Tailwind/Alpine via CDN** — no build step.
- One Express server (`server/server.js`) at `:3000` serves both the dashboard HTML and the JSON API.
- Refresh path is **exactly 2 HTTP calls per refresh**: `GET /{act_id}?fields=...` for account meta + `POST /` with `batch=[{campaigns}, {insights}]` for entities and metrics. Confirmed live: 1.5-2.3 seconds elapsed via proxy, HTTP 200 on every call.
- 9 SQLite tables: `account`, `campaigns`, `insights_snapshot`, `usage_samples`, `safety_state`, `daily_call_counter`, `endpoint_cooldowns`, `refresh_runs`, and the original index tables.

### Safety contract enforcement

All six layers are in code, not docs:

1. **Read-only mode** (`FB_READONLY=1` default) — `safety.preflight()` returns `readonly_mode` block before any HTTP request leaves the server. Verified by attempting `POST` (blocked) and `POST /batch` with all-GET sub-ops (allowed via `POST_BATCH` exception).
2. **Kill switch** (`FB_KILL_SWITCH=1` env OR `POST /api/kill-switch {on:true}`) — runtime-mutable; all Meta calls return `kill_switch_on` instantly.
3. **Daily call cap** (`FB_MAX_DAILY_CALLS=500`) — counted in account-tz (`Europe/Kiev`), halts at limit, resets at midnight account-tz.
4. **Circuit breaker** — per-endpoint cooldown after `FB_CIRCUIT_BREAKER_THRESHOLD=2` consecutive errors OR any rate-limit error code, for `max(FB_CIRCUIT_BREAKER_COOLDOWN_SECONDS=300, estimated_time_to_regain_access*60)`. Cleared on first success.
5. **Account whitelist** — `safety.isAccountAllowed()` refuses every account ID except `FB_PRIMARY_ACCOUNT_ID`. Lowest possible surface area.
6. **Header capture on every call** — `x-app-usage`, `x-business-use-case-usage`, `x-ad-account-usage`, `x-fb-ads-insights-throttle`, `x-fb-ads-insights-reach-throttle`, `x-page-usage` — all parsed, persisted to `usage_samples`, and used by the throttle pre-emption rule (5s @ 80%, 60s @ 90%).

### Observed rate-limit utilization (real numbers from live calls)

After 9 successful calls through the proxy:

- `x-app-usage` max %: **0.0%** (we're a microscopic app at this volume)
- `x-business-use-case-usage` max %: **7.0%** peaks on `/act/account` (BUC type: `ads_management`), 0.0% on the batch endpoint
- `x-fb-ads-insights-throttle`: 0.0% / 0.0% (insights endpoints inside the batch don't return outer throttle headers)
- `ads_api_access_tier`: returned `null` from non-insights calls (only present on direct `/insights` calls — confirmed by Meta's docs)

Translation: we have ~14x headroom on BUC alone, and effectively infinite headroom at the app level. The 750ms throttle + on-demand-only model is well within any reasonable safety envelope.

### Critical Analysis (post-build)

**Assumptions confirmed:**
- The 2-call batch structure is sufficient for the Ads Manager view. The screenshot's "Had delivery" filter is reproducible via `filtering=[{field:"campaign.impressions",operator:"GREATER_THAN",value:0}]` — verified: matches the 4-vs-26 split exactly.
- The field-name mapping is exact. Numbers cross-validated to ≤$0.01 currency precision and ≤1 comment integer precision against the user's screenshot.
- The proxy + appsecret_proof + system user token combination yields stable 200s with no anti-abuse signals.

**Strongest unresolved concern.**
The cascading-ban property — if any other tool, manual action, or another account in the same BM trips a flag, our well-behaved app could still get caught in the sweep. Mitigation in place: full audit trail (`usage_samples`, `refresh_runs`) so we have evidence for any appeal. There is no further code-side mitigation possible; the only escape is moving to Meta's official AI Connector channel (`mcp.facebook.com/ads`, launched April 29 2026) once it's enrolled for this BM.

**Pre-mortem:** if a flag happens, the most likely cause is a Meta-side false-positive during a mass-restriction sweep, not anything in our code. The next-most-likely cause is the user manually doing bulk operations in Ads Manager that compound with our pulls. Mitigation: the kill switch + daily cap keep our footprint small enough that we are unlikely to be the proximate cause.

**What would change my mind:** if BUC% climbs above 50% on a single refresh, something is wrong (we're a microscopic app); halt and investigate. If `ads_api_access_tier` ever shows `development_access` instead of `limited_access` post-call to `/insights`, the access tier downgraded and writes will fail.

### Phase 2 readiness

The data-fetching foundation is in. The next phases (in order of risk-to-reward):

1. **Per-campaign drill-down** (campaign → ad sets → ads → creatives). +1 call per drill-down. No safety implications.
2. **Time-series for active campaigns** (today + last_7d + last_30d in one render). +1 batched call (3 insights ops). No safety implications.
3. **Decision-intelligence read-only signals** (learning phase, freq, CPM trend, hook rate). Same call count, just more `breakdowns=`. Some breakdowns trip reach-throttle if span >13mo — guard with `x-fb-ads-insights-reach-throttle`.
4. **Writes** (toggle Off/On, budget +/− 20%, pause ad). Each write needs an explicit per-action approval gate (GoMarble's pattern), a 5-writes-per-hour-per-adset hard cap (Meta's published limit + safety margin), and an undo trail in `change_log`. Phase 2 work, not Phase 1.

---

## 2026-05-28 (evening) — v2 schema: conversion breakdowns + rate-limit-details panel

The user asked for the full Ads Manager "Conversions" preset (Adds to cart, Checkouts initiated, Purchases, Purchase value, ROAS, each broken down into In-app / Website / Offline / Meta sources) AND a programmatic view of the Meta dev-dashboard rate-limit page. Both are now shipped; here is what was learned in the process.

### Is there a Meta API endpoint for the dev-dashboard rate-limit-details page?

**No public endpoint exists.** Directly tested through the proxy with our system-user token:

- `GET /{app_id}?fields=rate_limit_details` → `(#100) Tried accessing nonexisting field (rate_limit_details)` (HTTP 400)
- `GET /{app_id}?fields=marketing_api_rate_limit` → same `(#100)` error
- `GET /{app_id}?fields=object_type` → same `(#100)` error (sanity check that 100 means "field doesn't exist" not "permission denied")

The dashboard page at `developers.facebook.com/apps/{app_id}/rate-limit-details/ads_management/?business_id={biz_id}` is rendered by Meta's internal GraphQL surface, not exposed via public Graph API.

**However**, every metric shown on that page is reachable from the response headers we already capture. Specifically:

- The user's screenshot showed GFM Greece at `7%` of `call_count`, `2%` of `total_cputime`, `4%` of `total_time` — those are the exact three keys inside `x-business-use-case-usage["{acct_id}"]` for `type: ads_insights`. We capture this header on every call. The percentages are the canonical source; the absolute counts (`39 of 540`) on the dashboard are derived from the tier's published capacity, which we don't need.
- The list of "top 5 ad accounts" on the dashboard is just the accounts that account's app has called recently. Since we're scoped to ONE account by `FB_PRIMARY_ACCOUNT_ID`, we have full data for our account and zero for the others — which matches our scope.

**Consequence:** added `/api/rate-limit-details` route + frontend panel that visually mirrors the Meta dashboard layout (per-account BUC bars + insights throttle + tier), sourcing data from our captured headers. Includes a "Open Meta dev dashboard ↗" link for users who want the official view with absolute call counts.

### Capturing per-op headers from batch sub-responses

**Old behavior:** batched request was sent with `include_headers=false`. Result: only the outer batch response's headers were captured. The Marketing API's outer batch response does NOT include `x-fb-ads-insights-throttle` — that header is per-sub-op on the actual `/insights` call. Symptom in v1: "Tier: unknown" in the dashboard footer.

**Fix:** set `include_headers=true` on the batch payload. In `fbClient.batch()`, after the batch returns, iterate the response items; for each item with a `headers` array, build a faux header object and call `captureUsage('GET', `batch.sub:${op.name}`, ...)`. This persists one extra `usage_samples` row per sub-op and lets `/api/rate-limit-details` surface the insights tier (`development_access` confirmed live).

Trade-off: outer payload grows ~30% per batch response (a few extra KB), still well below proxy bandwidth concerns. Worth it for visibility.

### Conversion action_type dedup — the big v1 bug

First implementation summed `offsite_conversion.fb_pixel_purchase` + `onsite_web_purchase` for "Website purchases", and included the legacy bare `purchase` action_type in "Meta-native purchases". Live data showed:

- `omni_purchase` (Meta's official unified total): 11
- `purchases_website` (our sum): 22 (← double-counted)
- `purchases_meta` (our sum): 11 (← false attribution, this was the same 11 as omni)

Investigation: Meta currently emits BOTH `offsite_conversion.fb_pixel_purchase` AND `onsite_web_purchase` for the same conversion event during a migration from the old offsite-conversion naming to the newer onsite-web naming. Summing them double-counts. The legacy bare `purchase` is similarly a roll-up that overlaps with everything else.

**Fix:** mutually-exclusive matchers in `ACTION_GROUPS`:
- **Total**: `omni_X` only (Meta dedupes internally)
- **App**: `mobile_app_X`, `app_custom_event.fb_mobile_X`
- **Website**: `offsite_conversion.fb_pixel_X` only (NOT `onsite_web_X`, NOT bare `X`)
- **Offline**: `offline_conversion.X`
- **Meta-native**: `onsite_conversion.X` only (NOT bare `X`, NOT `onsite_web_X`)
- The bare `X` and `onsite_web_X` are stored in `raw_actions_json` for future inspection but never included in any breakdown column.

After fix: `purchases_total = 19`, `purchases_website = 19`, `purchases_meta = 0`, `purchases_app = 0`, `purchases_offline = 0`. Sums match `omni_purchase`. Reasonable: GFM Greece sells via website with Pixel + CAPI, no Meta Shop, no mobile app, no offline imports.

Same dedup applied to ATC, Initiate Checkout, Landing Page Views.

### Source-attribution caveat for users

After dedup, **App + Website + Offline + Meta does not necessarily equal Total.** This is BY DESIGN — `omni_*` is Meta-deduplicated, while the source breakdowns are individual attribution reports per source. A customer who triggers BOTH a Pixel event AND a CAPI server-side event for the same purchase is counted ONCE in `omni_purchase` but might appear in BOTH `offsite_conversion.fb_pixel_purchase` and `onsite_web_purchase` (we only count the former). Documented in AGENTS.md.

### Cost-per-X strategy

For `cost_per_landing_page_view`, `cost_per_add_to_cart`, `cost_per_initiate_checkout`, `cost_per_purchase`: Meta returns these directly in `cost_per_action_type` as an array of `{action_type, value}`. We use them when present (matching the same canonical action_types as the counts), and we ALSO derive totals on the frontend as `spend / count` for the footer row. The two methods agree to 2 decimal places on every campaign tested.

### ROAS extraction

`purchase_roas`, `website_purchase_roas`, `mobile_app_purchase_roas` are arrays of `{action_type, value}`. Empirically:
- `purchase_roas[0].action_type === 'omni_purchase'` (the unified ROAS — single entry)
- `website_purchase_roas[0].action_type === 'offsite_conversion.fb_pixel_purchase'` (per-Pixel-event ROAS — single entry)
- `mobile_app_purchase_roas`: empty for GFM Greece (no mobile app)

Logic: pick the entry by preferred action_type, fall back to first entry if preferred missing. Frontend renders as `3.16x`.

### Column picker UX

Took the "Customize columns" pattern from Meta's Ads Manager:
- Trigger: button labeled "Columns (N)" where N = currently visible count
- Body: dropdown with 7 collapsible groups (Delivery / Performance / Engagement / Adds to cart / Checkouts / Purchases / Revenue+ROAS), each with a per-group "Show all / Hide all" link
- Header: Reset / All / None global actions
- Persistence: `localStorage["gfm.visibleColumns.v2"]` storing a `{colId: boolean}` map; new columns added later default to OFF unless they're in `DEFAULT_VISIBLE_COLUMN_IDS`
- Empty-state-friendly: missing keys in stored prefs fall back to the default set, so users don't get a blank table after a schema bump

### Sticky Campaign column

With 42 possible columns, the table is ~5000px wide. Sticky-left CSS on the OFF/ON toggle column (60px) and the Campaign name column (220px) keeps the row identifiable while horizontally scrolling. Both stickies are layered with `z-index: 5-10` so they sit above scrolling cells but below the picker dropdown (`z-index: 40`) and the nav (`z-index: 30`).

### Confidence

| Claim | Source | Confidence |
|---|---|---|
| No public `rate_limit_details` endpoint exists | Live API tested 3 candidate field names, all returned `(#100)` | Confirmed (100%) |
| Header-based BUC data matches dev-dashboard | User screenshot vs. our captured `x-business-use-case-usage` percentages | Confirmed (100%) — `7% used` ⇆ `93% Remaining` |
| `omni_purchase` is the dedup'd total | Meta docs + cross-checked: `purchases_website` = `omni_purchase` for Pixel-only accounts after dedup fix | High (90%) — would change if Meta repurposes `omni_*` semantics |
| `onsite_web_X` overlaps `offsite_conversion.fb_pixel_X` for the same events | Same campaign reported equal counts on both for every active campaign in our sample | High (90%) — disconfirmation would be a campaign where the values differ (none found in our data) |
| `include_headers=true` is safe for our throughput | Tested live, no errors, response 2.5KB larger | Confirmed (95%) |

The 90%-confidence claims above survived one disconfirmation pass each (looked for counter-examples in our actual data; none found).

---

## 2026-05-28 (evening) — RiseHope added to BM + single-token model (Route 2)

### What changed in the BM

- **RiseHope (`113297813778299`) is now an owned Page of BM `1162517778681857`.** Verified live: `GET /{BM_ID}/owned_pages` returns it; `GET /me/accounts` (system-user token) returns it with tasks `[ADVERTISE, ANALYZE, CREATE_CONTENT, MESSAGING, MODERATE, MANAGE, VIEW_MONETIZATION_INSIGHTS]`.
- **Two-step UI gotcha confirmed:** adding a Page to a BM and assigning the system user a role on it are independent steps, and BOTH must complete. After the first probe, `owned_pages`, `client_pages`, and `/me/accounts` all returned 0/empty even though the page token worked — i.e. the Page was not yet owned/assigned. After the user completed the assignment, all three populated and the direct `GET /{page_id}` via system-user token returned 200.

### Core finding: can ONE token do everything? (researched + probed)

**One STORED credential: yes. One token literally on every call: no.** Page-content edges require a *Page* access token; the system-user (user-type) token cannot hit them directly.

- `GET /{post_id}/comments` with the **system-user token** → `(#10) This endpoint requires the 'pages_read_engagement' permission or the 'Page Public Content Access' feature` — even though the token HAS `pages_read_engagement` (confirmed via `/debug_token`, 43 scopes) AND the system user has MODERATE on the Page.
- Same call with a **minted Page token** → `200 OK`.
- Writing a comment with a non-Page token returns `(#1705) There was an error posting to this wall` (Meta docs).
- Source: https://developers.facebook.com/docs/marketing-api/system-users/guides/api-calls/ ("Once the system user has `pages_read_engagement` permission, the system user access token can be used to retrieve the page access token… `GET /me/accounts`"), https://developers.facebook.com/docs/pages-api/comments-mentions/ (1705 error), maton-ai API-gateway reference ("feed, insights, and comments need a Page Access Token").
- Confidence: **Confirmed (98%)** — official docs + SDK + StackOverflow + our own live probe all agree; disconfirmation search found zero counter-examples.

### Minting the Page token (Route 2 — adopted)

- Two equivalent mint routes, both proven live with our system-user token:
  1. `GET /{page_id}?fields=access_token` — single page, cheapest. "Only returned if the User making the request has a role on the Page." (Page reference doc.)
  2. `GET /me/accounts?fields=id,name,access_token` — lists all manageable pages with a token each.
- **The minted Page token inherits the system-user token's lifetime: it never expires** (`expires_at=0`, `data_access_expires_at=0` on `/debug_token` of the minted token; `type=PAGE`, `profile_id=113297813778299`, 43 scopes). Source: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived ("Long-lived Page access token do not have an expiration date"), facebook-python-business-sdk issue #705 (maintainer: "generate a page access token directly with the SystemUser AccessToken").
- `appsecret_proof` is HMAC-SHA256 of **the token used in that specific call** with the app secret as key — so page-token calls must sign with the page token, not the system token. Source: https://developers.facebook.com/docs/graph-api/guides/secure-requests/.

### Why NOT Page Public Content Access (PPCA)

- PPCA requires App Review + business verification, is **read-only / public-analysis only**, and **strips the comment `id` field** ("To access the `id` field for comments… you must be able to perform the MODERATE task… [with a page access token]"). Without comment IDs you cannot hide/delete/reply. PPCA is for analyzing Pages you do NOT manage. We manage RiseHope, so PPCA is the wrong tool. Source: https://developers.facebook.com/docs/features-reference/page-public-content-access/, https://developers.facebook.com/docs/graph-api/reference/object/comments/.

### Implementation (Route 2)

- `server/lib/pageToken.js` — mints via `fb.get('/{page_id}', {fields:'access_token,name'})` (so the mint is proxied + signed + throttled + rate-limit-header-captured + daily-cap-counted like any other call), caches in memory (TTL 60 min), `invalidate()` on 190, `snapshot()` for observability.
- `server/lib/fbClient.js` — `tokenKind: 'sysuser' | 'page'` (default `'sysuser'`); `resolveToken()` mints for `'page'`; `appsecret_proof` computed over the resolved token; on `error.code === 190` with a page token, invalidate + retry once. `fb.moderate(method, path, data, …)` performs gated Page writes (used by the comments feature).
- `server/server.js` — `GET /api/page-token` (snapshot) and `GET /api/page-token?verify=1` (force-mint + read `/{page_id}?fields=id,name,fan_count` via the page token; returns masked confirmation). Permanent observability.
- `.env` — `FB_ACCESS_TOKEN` commented out (server no longer reads it). Kept commented for the one-time Python `src/` bootstrap tools.
- Circular import `fbClient ↔ pageToken` is benign in ESM (bindings only accessed inside async functions at call time, never at module-load time).

### Pre-mortem / residual risk

- The minted Page token (and the system-user token it derives from) is invalidated if the BM admin who created the system user is removed from the BM (community thread 298900323271544) — same failure mode as the old static page token, but now centralized to one credential. Mitigation: keep ≥2 BM admins; the client re-mints on 190 and surfaces the failure.

---

## 2026-05-28 (night) — Comments Manager overhaul (multi-post inbox + LLM review)

### What replaced what

- The per-ad **comments drawer** is gone. New **full-screen Comments Manager** spans all active ad posts: left post rail, unified inbox, and Auto-rules / Audit log / Blocked sub-tabs. Entry points: header "Comments Manager" button + per-ad "Comments" link (both `$dispatch('open-comments-manager', {adId, postId})`).
- Old routes `/api/comments`, `/api/comments/refresh`, `/api/comments/moderate` retired in favor of the `/api/cm/*` surface (see AGENTS.md). Old `dashboard()` drawer state/methods removed from `app.js`; new `commentsManager()` lives in `public/comments-app.js` as a **second, sibling Alpine root**.

### Two Alpine roots, cross-component open

- The header button is inside the `dashboard()` root; the manager is a separate `x-data="commentsManager()"` root. `$dispatch('open-comments-manager')` from inside `dashboard()` bubbles to `window`; the manager listens with `@open-comments-manager.window`. This avoids coupling the two components or hoisting comments state into the giant dashboard object. Verified live (header + ad-row both open it).

### LLM review (OpenRouter) findings

- **Egress:** LLM calls go **direct** to `openrouter.ai`, NOT through the Meta proxy. The proxy only buys a stable egress IP toward `graph.facebook.com`; routing LLM traffic through it adds latency + burns proxy quota for zero benefit. Documented as the single explicit exception to proxy-only egress.
- **Structured output:** `response_format: { type: 'json_schema', strict: true }` with an explicit schema is reliable on `google/gemini-3.1-flash-lite`; still kept a loose `{…}` regex JSON extractor + `normCommentAnalysis` clamp as a belt-and-suspenders parse. Live run: **144/144 comments analyzed, 0 failures.**
- **Batching:** classify in batches of `ANALYSIS_BATCH_SIZE` (10) with `ANALYSIS_BATCH_CONCURRENCY` (3) and a per-comment fallback for any idx the batch dropped. Image (post picture) attached only to the **first** batch to save tokens. 144 comments ≈ 30s end-to-end.
- **Thread-awareness pays off:** passing parent + replies made the model downgrade a scam accusation from `delete`→`keep`/`review` because the thread already had defending replies ("Although it is a scam accusation, the thread already…"). This is the social-proof preservation we wanted. Verified in the live severity-sorted inbox.
- **Translation is always returned** (`english_translation`), so a non-Greek/Portuguese operator can triage. Reply suggestions come back in the **commenter's** language (PT comment → PT reply), with `tone`+`language` metadata. Verified live in the UI.

### Suggest-only auto-delete (user decision)

- AI `recommended_action: 'delete'` only **flags** (red badge + "AI: suggest delete" filter → showed exactly 1 result live). No silent deletion ever. Auto-mod **rules** may auto-**hide** on sync, never delete. This is a deliberate safety choice, not a limitation.

### Safety gate audits blocked attempts

- With `FB_ALLOW_COMMENT_MODERATION=0`, every write returns **HTTP 423** AND is still written to `moderation_log` with `success=0, error_message='moderation_disabled'`. Confirmed live: two hide attempts appear in the Audit tab as `moderation_disabled`. Rationale: a complete audit trail must include attempted-but-blocked actions, not just successful ones.
- `delete-and-block` needs a PSID; ordinary commenters often expose none (Meta privacy → `from` is null). When absent it degrades to delete-only and the toast says so. Block/unblock recorded in `blocked_users`.

### Post discovery cost

- `discoverPosts()` builds the `ad_posts` catalog from the ads table (`creative_object_story_id`), deduped by post id, capped at `CM_MAX_POSTS_PER_SYNC` (40). Post **meta** (message/picture/permalink) is fetched lazily — only for posts missing it — via the **page token**. Live: 71 unique posts found, 40 processed, 8 metas fetched, ~39s (proxy + 750ms throttle dominate). Comment pages capped at `CM_MAX_COMMENT_PAGES_PER_POST` (5).

### PowerShell gotcha (testing only)

- `curl.exe -d "{\"k\":\"v\"}"` does NOT survive PowerShell quoting → server saw malformed JSON (`Expected property name…`). Use `--data "@file.json"` (write the body to a file first) or `-d "{}"` for empty bodies. Not a server bug; bit me twice during endpoint smoke tests.

---

## 2026-05-28 (late) — Batched comment sync + names/blocking research

### Commenter names are an App-Review gate, not a coding problem (research, Confirmed ~92%)

- `from{name,id}` on page-post comments is `null` for any user who hasn't authorized the app. The ONLY way to get real names/PSIDs for arbitrary commenters is App Review (Advanced access) for `pages_read_user_content` **+ the "Business Asset User Profile Access" feature** (+ business verification + published privacy/ToS). Sources: official feature doc + 3 forum/SO threads; a disconfirmation pass found no alternative. PPCA is worse (read-only, strips comment IDs).
- **Empirically true in our data:** of 294 fetched comments, exactly **1** had a name/PSID — and it was a **Page** ("Academia dos Olivais"), confirming "other Pages + the Page's own replies resolve, ordinary users don't."
- Consequence for blocking: `POST /{page}/blocked` needs a **PSID** (= the `from.id`), so blocking is gated by the *same* feature. The block API itself is correct (`psid` list param, response `{ "<psid>": true }`, DELETE returns `{success}`). UI now shows a "no id" badge + hides Block when `from_id` is absent, and a dismissible banner explains the feature gate. Don't waste cycles trying to "fix" names in code.

### Batch READS, never batch WRITES (deliberate)

- Official confirmation: **each batch sub-op counts separately** against Meta rate limits ("10 in a batch = 10 calls"). Batching only saves HTTP round-trips, proxy cost, our internal daily-cap counter (1 `recordCall` per top-level call), and throttle gaps. The real *quota* saver is **field expansion**.
- Rewrote sync to fetch post meta + first comment page in ONE field-expanded call per post (`GET /{post}?fields=…,comments.filter(stream).limit(100){…}`), bundled into Graph batches with the **page** token as the top-level/fallback token (`fb.batch(ops, key, { tokenKind:'page' })`; sub-ops inherit it; one `appsecret_proof` over the page token covers them). Pagination of >100-comment posts runs in further batches. **Live: 11 owned posts + 294 comments in 2 batch calls, 0 failures** (was ~80+ sequential calls).
- **Writes deliberately NOT batched.** The 750ms-paced, `MODERATE`-gated sequential write path is an anti-suspension feature; bundling 50 deletes into one request removes pacing AND bypasses the safety gate (batch preflight is `POST_BATCH`, not `MODERATE`). Given the user's top priority is avoiding suspension, sequential paced writes win.

### Page-ownership filter (caught via batching)

- Batched sync first surfaced **20/25 sub-ops failing HTTP 400** — those posts had *different* `{pageId}_` prefixes than our minted page token's page. The ad account promotes posts owned by *other* pages; one page token can't read them. Per-post calls failed the same way before, just invisibly. Fix: filter candidate posts to `post_id.startsWith(FB_TARGET_PAGE_ID + '_')` before fetching (skips guaranteed-400 sub-ops, which still cost rate quota), and `store.pruneForeignPosts()` removes any foreign catalog rows on each sync. Live: 60 foreign posts skipped, 32 ghost rows pruned, catalog now 11 owned posts.
- Open follow-up: multi-page support would require minting a page token per owning page (all must be in the BM). Out of scope for now; documented.

### `linkMyReplies` instead of double-nesting

- Dropped the nested `comments.limit(15){…}` (replies) from `COMMENT_FIELDS` — with `filter=stream` the API already returns replies as flat items carrying `parent{id}`. `linkMyReplies()` reconstructs each parent's "my reply" from the flat stream (reply where `from_id === targetPageId`). Smaller per-comment payload = safely field-expand 25 posts per batch.

---

## 2026-05-29 Ad management writes (pause/resume + budget)

### `MANAGE` safety method mirrors `MODERATE`

- Added a third `safety.preflight` branch: `MANAGE` bypasses the `FB_READONLY` block (writes are the whole point) but is refused unless `FB_ALLOW_AD_MANAGEMENT=1`, and is always killed by the kill switch. This keeps the "read-only by default, capabilities opt-in per domain" model: `FB_READONLY` (generic writes) / `FB_ALLOW_COMMENT_MODERATION` (page content) / `FB_ALLOW_AD_MANAGEMENT` (ad entities) are three independent gates.
- Ad writes use the **system-user** token (`tokenKind:'sysuser'`) — it carries `ads_management`. Page-content writes use the minted page token. Don't cross them.

### Idempotent write is the safe end-to-end test

- To verify the full write path on a LIVE account without changing anything, POST the entity's **current** status back to itself (e.g. `ACTIVE`→`ACTIVE`). Meta returns `{success:true}`, the store + `ad_actions` audit update, and delivery is untouched. Confirmed live on campaign `120238149702880464` ("GBM Mariana - Portugal"): HTTP 200, `previousStatus:ACTIVE`, audit row `success:1`. Invalid status (`BOGUS`) correctly 400s before any HTTP call.
- **Never click the dashboard Off/On toggle during browser testing** — the CursorBrowser dialog override makes `confirm()` return `true` non-blocking, so a click WOULD pause a live campaign. Verify the toggle via the accessibility tree (its `title`/label) and the budget editor via the inline form, not by triggering the action.

### Budgets are minor units

- Meta budget edges (`daily_budget`/`lifetime_budget`) take integer **minor units** (cents). UI collects the amount in account currency and ×100s before POST; store keeps the cents value (REAL). GBM campaigns in this account show `daily_budget:null` (ABO — budget lives on the ad set), so the campaign-level editor shows "not set"; setting a daily budget on an ABO campaign will be rejected by Meta and surfaces as a toast.

### Tooltips: native `title` everywhere

- For "explain everything on hover", plain `title=`/`:title=` attributes are the pragmatic choice — universal, accessible, zero JS, and they show up as the element's accessible name in the snapshot (free verification). Column tooltips are data-driven from a `tip` field on each column def.

---

## 2026-05-29 Ad-manager capability expansion (reads + duplicate)

### What Meta actually exposes programmatically (researched, ranked by value × safety)
- **Reads (zero suspension risk, work on live campaigns):** `GET /{id}/insights?breakdowns=` (age/gender, country, region, publisher_platform, publisher_platform+platform_position, impression_device, hourly), `GET /{ad}/previews?ad_format=` (rendered iframe, 24h), `GET /act_X/activities` (change history). These were the highest-leverage additions and are fully verifiable end-to-end.
- **Writes that DON'T trigger ad review:** status, budget, schedule. Writes that DO: creative, targeting, optimization goal, billing event. So we only ever touch status/budget/duplicate — never creative/targeting from the API.
- **Duplicate (`POST /{id}/copies`)** defaults to `status_option=PAUSED` and supports `deep_copy` → the canonical safe "scale a winner": creates a paused clone, never edits the source. This is how you respect "do not edit working campaigns" while still adding scaling.

### `activities` edge is account-only
- `GET /{campaign_id}/activities` (and adset/ad) returns **`(#100) nonexisting field (activities)`**. The edge only exists on the **ad account** (`/act_X/activities`). For per-entity history, fetch the account feed (pass `business_id` since the account is in a BM) and filter client-side by `object_id`. Fields worth requesting: `event_type,translated_event_type,actor_name,object_id,object_name,object_type,extra_data,event_time`; `extra_data` carries `{old_value,new_value}` for nice diffs.

### Budget-edit rate guard (the concrete anti-suspension finding)
- 2026 ban write-ups + Meta docs agree: **~4 budget edits/hour per ad set** and 10 account-spend-limit edits/day; exceeding → 1-hour lockout **and** an account flag. Enforce it locally: count successful `budget` rows in `ad_actions` for the `entity_id` in the last hour and refuse (HTTP 429) before calling Meta. Cheaper and safer than discovering the cap by tripping it. The dominant ban vector is the *error-and-blind-retry* signature, not any single call — our circuit breaker + "refuse before send" keeps us off that pattern.

### Previews need a *user* token, not a page token
- Docs literally say "provide a user access token, not a Page access token." The **system-user token is a user token**, so `fb.get` (default `sysuser`) works for `/previews`. Returns `{data:[{body:"<iframe …>"}]}`; inject `body` via `innerHTML` into a host div (`$nextTick`) — the iframe is cross-origin so it won't appear in the a11y snapshot, verify it with a screenshot.

### Single-ad campaigns make ad-level == campaign-level breakdowns
- Don't mistake identical numbers for a bug: when a campaign has one dominant ad, its ad-level insights equal the campaign's. Confirmed the URLs carry distinct ids (campaign `1202381497…` vs ad `1202404323…`) before concluding it was expected.

### ABO vs CBO budget level (the "Invalid parameter" budget bug)
- A campaign accepts `daily_budget`/`lifetime_budget` **only when it's CBO/Advantage+** (campaign budget optimization). **ABO** campaigns hold the budget on each **ad set**, so POSTing a budget to an ABO campaign returns Meta's opaque `(#100) Invalid parameter`. GFM Greece is 100% ABO.
- Fix is two-layer: (1) server `setBudget` detects an ABO campaign locally (no campaign-level budget on record) and returns `abo_campaign` (HTTP 422) with an actionable message **before** any Meta call; (2) UI shows `Budget: ad-set level (ABO) · edit on ad sets →` on ABO campaign rows (drills into the ad sets via `drillInto`) instead of a campaign budget editor that would always fail. Budget editing stays available at the ad-set level, where ABO budgets live.
- Heuristic "campaign with no campaign-level budget ⇒ ABO" is safe here because a CBO campaign by definition always carries a campaign budget. Inverse edge (ad set under a CBO campaign can't take its own budget) is out of scope while the account is all-ABO.

---

## 2026-05-29 Decision-grade digest — "100% confident" daily judgments (kill/scale/pause/duplicate/targeting)

### The honest answer to "what does an LLM need to be 100% confident"
- At GFM's volume (~1-100 conv/wk per entity), **100% is statistically impossible** and frequentist p-values are useless (≈384 conversions for ±5%/95%; social ads convert at 1-3% → ~$1.5-3k spend just to reach significance). The deliverable is **calibrated** confidence, not fake certainty. Cross-validated across Meta docs + practitioner forums + academic A/B papers: at low volume use **Bayesian/Poisson credible intervals + expected loss**, gated by **minimum sample (~50 conv to trust a CPA, 15 to even judge), persistence (signal holds ≥3 consecutive days), and day-of-week-adjusted baselines**. Disconfirmation: Bayesian isn't immune to early-stopping error either (priors matter; type-I not controlled), so we keep thresholds conservative and require persistence + min-sample as belt-and-suspenders.
- Concrete forum thresholds we encoded: scale +20% when 7d beats median AND freq<2; **kill/scale-down only after CPA >1.5× median for 3 straight days**; refresh creative when freq>3 or quality_ranking below average; min 7 days / 72h before any test conclusion.

### Probe before building (saved a dead panel)
- `server/scripts/probe.mjs` is a **self-contained** read probe (direct axios+proxy+token, no DB) so it never locks the running server's SQLite. Findings that reshaped the build:
  - **EMQ/Dataset Quality is NOT available**: `/{pixel}/dataset_quality` → `(#100) Unknown path`, `/dataset_quality?dataset_id=` → `200 {}` (empty), `?fields=event_match_quality` → nonexisting field. Empty ⇒ browser-pixel-only (no CAPI). So **don't build an EMQ panel** — surface it as a hedged "check CAPI" advisory instead.
  - **Creative ranking works and is the real story**: active "Image 1" ads are `quality_ranking: BELOW_AVERAGE_20/35`. `engagement_rate_ranking`/`conversion_rate_ranking` stay `UNKNOWN` until volume builds; `quality_ranking` populates first.
  - **Segment volume IS enough**: age×gender cells carry 17-121 purchases/30d → real Bayesian verdicts. Low cells (18-24, unknown) correctly fall to `insufficient`.
  - **Net New Reach** needs 3 reach pulls (this-30 / prior-30 / combined-60); `NNR% = (combined − prior)/this`. Freq 1.53 + 94% NNR ⇒ saturation is NOT the bottleneck here.

### Gotchas
- **Reach values are strings** in insights rows; `nz()` only accepts numbers, so `nz(row.reach)`→0 made saturation read "unavailable". Coerce with `Number()` for raw (non-normalized) breakdown/reach rows.
- **Segment baseline = account-blended CPA (`totals.cpa`), not median *campaign* CPA.** Median campaign CPA (8.41) was far above the blended CPA (5.67) and made nearly every cell look "better". Account-blended is the true "average" a segment over/under-performs against; median campaign CPA stays the reference for per-campaign scale/kill.
- **"Today" must be the latest COMPLETE day**, not the partial current day — compare it to the trailing distribution of the SAME weekday (need ≥3 priors to be reliable). Verdict `anomalous` only at |z|≥2. This is what lets the briefing say "spend is 3.9σ up (you scaled) but CPA is 0.2σ = normal" instead of false-alarming.
- **AI prompt golden rule = confidence over action.** `confident_actions` only for high/medium-backed items; single-day swings → `do_not_act` (with the z-score); real-but-unproven → `watch` (with what to wait for). An empty `confident_actions` array is a valid, good answer. Verified live: Gemini correctly told the operator NOT to react to the 3.9σ spend spike and to wait for ≥15 conv on the USA campaign.
- Strategy drawer is now **two tabs** (Daily Briefing default, Full Analysis). Each tab lazy-loads its own AI call (`runActiveTabAI`) so we don't spend two LLM calls when the user only opens one.
