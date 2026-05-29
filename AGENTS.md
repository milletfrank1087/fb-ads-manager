# AGENTS.md — FB ads manager

Rules every agent (and every script) in this repo MUST follow. Read this before touching code or making Graph API calls.

## Mission

Single-operator dashboard for **full Facebook ad management + post/comment moderation** on Page `113297813778299`. Same safety posture as `../fb comments once more`: proxy-only egress, structured logging, secret masking, BUC-aware throttling.

## Current scope (as of 2026-05-28)

**Narrowed scope: GFM Greece only, READ-ONLY, on-demand.**

- Only `act_1622353565055773` (GFM Greece, Europe/Kiev timezone) is queried. The Node client REFUSES other account IDs (`safety.isAccountAllowed`).
- `FB_READONLY=1` is the default. Only `GET` and read-only `POST /batch` (whose sub-ops are all `GET`) are allowed by `safety.preflight()`. Any non-GET write attempt is blocked with `readonly_mode` BEFORE any HTTP request leaves the server.
- No automated polling. The user clicks Refresh in the UI; that's the only path to a Meta API call.
- **Ad management writes are implemented (2026-05-29)**: pause/resume + budget edits on campaigns/adsets/ads, gated by `FB_ALLOW_AD_MANAGEMENT` (default `0`), **independent of `FB_READONLY`** (same pattern as comment moderation). Every write requires explicit per-action UI confirmation, is paced (750ms), and is written to the `ad_actions` audit log. See "Ad Management API" below.

## Non-negotiable rules

### 1. Proxy-only egress to Meta

- **Every** request to `graph.facebook.com`, `graph-video.facebook.com`, `www.facebook.com`, or `connect.facebook.net` MUST go through `PROXY_HOST:PROXY_PORT` with `PROXY_USER`/`PROXY_PASS` Basic auth.
- The proxy gives us a consistent egress IP so Meta's geo-risk scoring does not flag us.
- It is **forbidden** to add a code path that hits Meta without the proxy. No "fallback to direct", no "retry without proxy", no exceptions for healthchecks.
- Default `trust_env=False` on every HTTP client so OS-level `HTTP_PROXY`/`NO_PROXY` cannot bypass our config.
- If the proxy is unreachable, **fail loudly**. Never silently degrade.
- `proxy_check.py` must pass before any FB script runs (humans run it, agents run it as a smoke check after env changes).
- **LLM egress is the ONE exception, and only because it never touches Meta.** Comment AI review/reply (OpenRouter, `server/lib/analyzer.js`) calls `openrouter.ai` **directly** (not through the Meta proxy). The proxy exists solely to give a stable egress IP toward `graph.facebook.com`; routing third-party LLM traffic through it buys nothing and risks the proxy quota. No Meta token, comment author PII-name, or user identifier is sent to the LLM — only comment text + post context.

### 2. Call-budget discipline (priority order)

Minimize Graph API call_count in this order — **higher items save the most quota**:

1. **Field expansion (highest leverage).** Combine sub-resources into one node fetch using nested `fields=`. Example: `/{ad-id}?fields=id,name,creative{id,object_story_id,thumbnail_url},adset{id,name,daily_budget},campaign{id,objective}`. Real-world testing shows field expansion counts as **1 call** vs N for separate fetches. This is the single biggest lever.
2. **Cache.** TTL-based cache on GET responses keyed by `(method, path, sorted_params_minus_token)`. Default TTL 1h for stable data (campaign metadata, page info), 5min for engagement data (insights, comment counts), no cache for moderation reads. Bust on writes that touch the cached entity.
3. **Batch (saves HTTP/proxy overhead, NOT rate quota).** Up to 50 ops per `POST /` with `batch=[...]`. Each sub-op still counts toward rate limits — batching only saves the round-trips, the proxy connection cost, and latency.
4. **Throttle.** 750ms gap + jitter between top-level HTTP requests. Back off on `x-app-usage.call_count >= 80` or `x-business-use-case-usage[acct].call_count >= 80`. Refuse new writes when usage > 90% until next window.

### 3. Batch correctly

- Max 50 ops per batch. We split larger sequences into chunks.
- **Do NOT** include multiple Adsets under the same Campaign in one batch (Meta forbids; the whole batch fails). Group/split by campaign.
- **Use `include_headers=true`** on insights-bearing batches. The outer batch response does NOT include `x-fb-ads-insights-throttle` — that header is per-sub-op and only attached when `include_headers=true`. Without it, the dashboard cannot show the Marketing API tier or per-op throttle %. Cost: ~2KB extra payload; benefit: tier visibility + per-op rate-limit data. (For batches with no insights sub-op, `include_headers=false` is fine.)
- Independent operations execute in parallel server-side — order is not preserved by execution time but IS preserved in the response array.
- Use `name` + `{result=op_name:$.field}` JSONPath references for dependent ops in the same batch (e.g. create campaign, then create adset that references it, in one round-trip).
- POST sub-ops put the form body in the `body` field as a URL-encoded string, not as JSON.

### 4. Token discipline

**Single stored credential: `FB_SYSTEM_USER_ACCESS_TOKEN`.** Everything else is derived at runtime. (Route 2, adopted 2026-05-28.)

1. **`FB_SYSTEM_USER_ACCESS_TOKEN` — the ONLY token in `.env` the server reads.** Type `SYSTEM_USER`, `expires_at=0` (does not expire), 43 scopes, scoped to BM `1162517778681857`, the 5 owned ad accounts, AND the RiseHope Page (`113297813778299`, added to the BM 2026-05-28). Use directly for every ads_management / ads_read / insights / business_management / catalog / lead-retrieval call (these accept a user/system-user token).
2. **Page access token — MINTED at runtime, never stored.** Page-content edges (`/{page}/feed`, `/{post}/comments`, `/{comment}`) require a *Page* access token; the system-user token returns `#10` (reads) / `1705` (writes) on them. `server/lib/pageToken.js` mints the Page token from the system-user token via `GET /{page_id}?fields=access_token` and caches it in memory (TTL 60 min). A Page token derived from a never-expiring system-user token also never expires; on `error.code === 190` the client invalidates the cache and re-mints once. Request it by passing `{ tokenKind: 'page' }` to `fb.get` / `fb.moderate`.
3. **`FB_ACCESS_TOKEN` (commented out in `.env`)** — the old static RiseHope Page token. Superseded by runtime minting; retained commented for the one-time Python bootstrap tools in `src/`. Do NOT reintroduce it into the server.
4. **`FB_USER_ACCESS_TOKEN`** = long-lived user token. Keep only as a fallback / for `/debug_token` self-checks / when granting new BM assets. Never use for production reads.

**Token routing rule:** `tokenKind` defaults to `'sysuser'`. Use `tokenKind: 'page'` ONLY for Page-content edges. The mint call itself goes through the normal `fb.get` pipeline, so it is proxied, signed with `appsecret_proof`, throttled, counted against the daily cap, and its rate-limit headers are captured like any other call.

**Rules:**

- **NEVER** use a user token for an operation that the system-user token can serve. If a call works for both, choose system-user.
- **`appsecret_proof` is REQUIRED on every call.** HMAC-SHA256 of `access_token` with `FB_APP_SECRET` as the key, appended as the `appsecret_proof` param (also send `access_token` itself). The `FbClient` does this automatically — never bypass it.
- Tokens are masked in logs as `EAAN2GNL...ZDZD (len=204)` — never log the full token.
- On `error.code === 190` (OAuth invalid) **on the system-user token**, stop immediately. Re-generate via Business Settings → System Users → Generate Token (or via `POST /{sysuser_id}/access_tokens` if Privacy Policy URL is set). Do NOT retry.
- On `error.code === 190` on the Page or User token: same — stop, refresh, retry once.
- Token rotation: even though `expires_at=0`, rotate the system-user token if it's ever exposed. `data/system_user_token.json` is the audit trail of when it was issued.

### 5. Rate-limit awareness

Capture and persist these response headers on EVERY response (single-op, batch outer, AND each batch sub-op when `include_headers=true`):

- `x-app-usage` — `{call_count, total_cputime, total_time}` percentages (0–100). Triggers throttle at 100. **Marketing API endpoints do NOT return this header.** It is present only on non-Marketing Graph API calls (Pages, user data, etc.).
- `x-business-use-case-usage` — keyed by ad-account ID; per-BUC type (`ads_management`, `ads_insights`, `pages`, etc.). Includes `estimated_time_to_regain_access` in minutes when throttled. **When present, the cooldown MUST be at least this many minutes.** This is the canonical rate-limit signal for Marketing API.
- `x-ad-account-usage` — `acc_id_util_pct` for the older platform tier.
- `x-fb-ads-insights-throttle` — `{app_id_util_pct, acc_id_util_pct, ads_api_access_tier}`. Specific to `/insights` endpoints. **Only delivered on the per-sub-op response inside a batch (requires `include_headers=true`), NOT on the outer batch response.**
- `x-fb-ads-insights-reach-throttle` — reach-with-breakdowns >13mo (10/account/day).
- `x-page-usage` (when present) — Page-level limits.

**There is NO public endpoint that returns the data shown on `developers.facebook.com/apps/{app_id}/rate-limit-details/...`.** That page is rendered from Meta's internal GraphQL. Tested directly: `GET /{app_id}?fields=rate_limit_details` and `GET /{app_id}?fields=marketing_api_rate_limit` both return `(#100) Tried accessing nonexisting field`. All the data on that page IS available through the headers above; the dashboard's `/api/rate-limit-details` route surfaces them in the same visual layout.

Map of error codes we treat as rate-limit:

- `4` — App-level too-many-calls
- `17` — User request limit reached
- `32` — Page-level throttle
- `613` — Too many calls from this ad-account
- `80000`–`80004` — BUC limits (`80004` = "Business Use Case limit reached")

On any of these: mark `rateLimitedUntil = now + 60min` (or use `estimated_time_to_regain_access` if FB returns it), short-circuit subsequent calls in the current batch, return cached/skipped responses to upstream.

### 5b. Anti-suspension hardening (Node server)

Meta's 2026 enforcement infrastructure (per GoMarble, HyperFX, Soku, and Meta's own rate-limit docs) flags Business Managers exhibiting any of these signatures. We are explicitly defended against each:

| Signature Meta flags | Our defense |
|---|---|
| Burst traffic (tight loops, many calls/sec) | `MIN_REQUEST_INTERVAL_MS=750` + jitter; on-demand refresh only (no auto-polling) |
| Bulk catalog/audience updates within minutes | READ-ONLY mode enforced at the client layer |
| Malformed / 4xx storms | Circuit breaker trips after `FB_CIRCUIT_BREAKER_THRESHOLD=2` consecutive errors per endpoint |
| Blind retries on 429 | On RL error codes, set per-endpoint cooldown of `max(FB_CIRCUIT_BREAKER_COOLDOWN_SECONDS, estimated_time_to_regain_access)` |
| Per-ad-set budget edits >4/hour | No writes at all in current scope |
| Sustained high BUC% | Pre-emptive backoff at 80% util (`server/lib/fbClient.js: throttle()`) |
| Account-tied call volume spikes | `FB_MAX_DAILY_CALLS=500` hard cap per account-tz day, halts at limit |

**Kill switch.** Set `FB_KILL_SWITCH=1` in env, or call `POST /api/kill-switch {"on":true}`, and the client refuses ALL Meta API calls instantly. Use if you observe unexplained behavior or want to pause during peak Meta-side incidents.

### 6. "Save" pattern (coalesce edits)

For the dashboard UI: never fire a Graph write on every keystroke / toggle. Stage edits in browser state, surface a "Save changes" button, and on click fire ONE batched write (≤50 ops) per save. Same applies to bulk moderation — collect comment-action intents and fire as one batch.

### 7. Logging contract (per `proactive-logging.mdc`)

- Structured `{event, level, ...context}` JSON-ish log lines (stdlib `logging` with a JSON formatter or `print` of dicts is fine for scripts).
- Every Graph call logs: `{method, path, attempt, callNumber, paramsMasked}` BEFORE the call and `{status, bodyKeys, code, subcode}` AFTER.
- Errors include: `{code, subcode, status, message, path}` — never the raw token, never PII from message bodies of users.
- Never bare `print()` debug. Always include the operation name and identifier.

### 8. Permissions we need (target state)

For the goals "full ad management" + "post/comment moderation":

| Permission                  | Why                                                                          |
| --------------------------- | ---------------------------------------------------------------------------- |
| `ads_management`            | Create/edit/pause campaigns, ad sets, ads. **Required**, not satisfied by `ads_read`. |
| `ads_read`                  | Insights reads (granted alongside `ads_management`).                         |
| `pages_show_list`           | Enumerate Pages on `/me/accounts`.                                            |
| `pages_read_engagement`     | Read posts, comments, reactions on the Page.                                  |
| `pages_manage_engagement`   | Like/reply/hide/delete/unhide comments.                                       |
| `pages_manage_posts`        | Create/edit/delete posts (organic + dark posts via ads).                      |
| `pages_manage_metadata`     | Block/unblock users on the Page (`/{page}/blocked`).                          |
| `pages_read_user_content`   | Read user-generated content (comments) including from non-page accounts.     |
| `business_management`       | (Optional but recommended) Access Business Manager assets, system users.     |
| `read_insights`             | Page-level insights, post-level performance.                                  |
| `public_profile`            | Granted by default.                                                          |

The probe script (`src/probe.py`) reports which of these are actually on the token and what we CAN/CANNOT do as a result.

### 8b. Conversion attribution rules (CRITICAL — easy to get wrong)

Meta emits redundant `action_type` names during ongoing migrations. Summing all matching action_types double-counts. The mutually-exclusive matchers in `server/lib/insights.js: ACTION_GROUPS` are correct; DO NOT add overlapping matchers. Rules:

- **Total / unified** column: `omni_X` only (`omni_purchase`, `omni_add_to_cart`, `omni_initiated_checkout`, `omni_landing_page_view`). Meta deduplicates internally — this is the canonical "All sources" count.
- **In-app** column: only the advertiser's own mobile-app events — `mobile_app_X` and `app_custom_event.fb_mobile_X`. Never include `onsite_app_X` (that's Meta-Shop on mobile, not the advertiser's app — covered by the Meta column).
- **Website** column: only Pixel-tracked events on the advertiser's website — `offsite_conversion.fb_pixel_X`. Never include `onsite_web_X` (that's the advertiser's same website tracked via CAPI server-side; Meta emits BOTH for the same event during the offsite→onsite migration — summing them double-counts).
- **Offline** column: `offline_conversion.X` (CSV/CRM imports).
- **Meta-native** column: `onsite_conversion.X` only — events on Meta's own surfaces (FB/IG Shops, Threads). Never include the bare `X` (`purchase`, `add_to_cart`) — that's a legacy aggregate that overlaps with everything else.

**Consequence:** the source-breakdown columns may NOT sum to the Total column. This is correct behavior, not a bug. A purchase tracked via both Pixel AND CAPI is counted ONCE in `omni_purchase` but might appear once in `offsite_conversion.fb_pixel_purchase` AND once in `onsite_web_purchase`; we only count the first. The aggregate row in the dashboard footer also follows this rule.

**ROAS columns:** `purchase_roas` is a list of `{action_type, value}` returned by Meta. For our display:
- `purchase_roas_total` ← entry where `action_type == 'omni_purchase'` (fall back to first entry)
- `purchase_roas_website` ← `website_purchase_roas` entry with `action_type == 'offsite_conversion.fb_pixel_purchase'` (fall back to first)
- `purchase_roas_app` ← `mobile_app_purchase_roas` first entry

Never sum the array — ROAS is a ratio.

**Cost-per-X columns:** prefer `cost_per_action_type[action_type=X].value` when present (Meta's own calculation). Compute `spend / count` only as a fallback for the totals row.

### 9. File hygiene

- No comments inside code unless they explain a non-obvious WHY (per `code-practices.mdc`).
- No `*.db`, `data/*.json`, `.env`, `*.log` ever committed (`.gitignore` enforces).
- `lessons.md` is the running journal — every field-tested finding goes there with date + evidence link.
- Keep scripts thin. Prefer one well-batched script over many tiny ones.

## File map (current)

```
.env                       # credentials (gitignored)
.env.example               # template
.gitignore
requirements.txt           # Python deps (bootstrap scripts only)
AGENTS.md                  # this file
lessons.md                 # running log of findings
src/                       # Python bootstrap + diagnostics (one-time / occasional)
  proxy_check.py           # verify proxy egress, zero FB calls
  probe.py                 # batched permissions + rate-limit + accounts probe (user token)
  exchange_token.py        # short-lived -> long-lived user token, persists to .env
  inspect_app.py           # diagnostics on the app object
  setup.py                 # one-shot BM bootstrap (system user + assignments + token)
  save_system_token.py     # verify + persist a token generated in the BM UI
  smoke_test.py            # end-to-end ads_management sanity (campaigns/ads/insights)
  capabilities.py          # comprehensive probe of ad/page/BM capabilities
  lib/                     # shared Python client + store (used by Python scripts)
server/                    # Node/Express dashboard — the PRODUCT
  package.json
  server.js                # Express bootstrap + 7 routes including /api/rate-limit-details
  lib/
    env.js                 # config loader + safety env vars + OpenRouter/analysis config
    logger.js              # colored, structured terminal logger
    safety.js              # kill switch, circuit breaker, daily cap, cooldowns, isModerationAllowed
    store.js               # better-sqlite3 schema (17 tables incl. ad_posts, comment_analyses, auto_mod_rules, moderation_log, blocked_users) + queries
    insights.js            # ACTION_GROUPS mutually-exclusive matchers (see §8b) + ROAS_FIELDS + normalizeInsightsRow
    fbClient.js            # proxied, signed, throttled Graph client; tokenKind sysuser|page; fb.moderate (gated writes)
    pageToken.js           # runtime Page-token minting + in-memory cache (Route 2)
    refresh.js             # orchestrates: GET account + batched(campaigns,insights) = 2 HTTP calls; builds totals from SUMMABLE_COLS
    comments.js            # Comments Manager FB action layer: COMMENT_FIELDS, normalizeCommentList + linkMyReplies (page-reply detection from flat stream), hide/unhide/delete/like/reply/block/blockByComment/deleteAndBlock, all audited
    analyzer.js            # OpenRouter LLM: batch comment classify+translate, post summary, reply suggestion (DIRECT egress, model fallback)
    autoMod.js             # pattern rules engine (contains/equals/regex/has_url) -> HIDE only; evaluate + dry-run
    commentSync.js         # discover owned posts from ads -> BATCHED field-expanded sync (meta+comments per post, page-token batches) -> AI analysis (batch+fallback) -> apply auto-hide rules
  public/
    index.html             # Tailwind+Alpine dashboard + full-screen Comments Manager overlay
    app.js                 # dashboard() Alpine component: 7 column groups, localStorage persist, sticky-left Campaign column, formatters
    comments-app.js        # commentsManager() Alpine component: post rail, inbox, AI cards, filters, bulk, rules/audit/blocked tabs
  node_modules/            # gitignored
data/                      # gitignored runtime outputs
  dashboard.db             # shared SQLite (Python tooling + Node server)
  probe_report.json
  setup_report.json
  system_user_token.json
  capabilities_report.json
  smoke_test.json
```

## How to run

One-time setup (already done — do NOT re-run unless rotating the token):

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python src\proxy_check.py
python src\probe.py            # optional, verify user-token scopes
python src\setup.py            # BM bootstrap up to system-user creation + assignments
# UI: generate token in Business Settings -> System Users -> Generate Token
python src\save_system_token.py PASTED_TOKEN
python src\smoke_test.py       # final verification across all active ad accounts
```

Routine smoke check (run any time to confirm token + proxy + permissions still healthy):

```powershell
.\.venv\Scripts\python.exe src\smoke_test.py
```

Dashboard (Node/Express):

```powershell
cd server
npm install          # first time only
node server.js       # boots on http://localhost:3000

# In another terminal — verify endpoints:
curl http://localhost:3000/api/health
curl http://localhost:3000/api/safety
curl -X POST http://localhost:3000/api/refresh -H "Content-Type: application/json" -d '{\"date_preset\":\"today\"}'
```

### API surface (Node server)

| Route | Method | Effect | Hits Meta? |
|---|---|---|---|
| `/` | GET | Serves dashboard HTML | No |
| `/api/health` | GET | Liveness + uptime + safety snapshot | No |
| `/api/safety` | GET | Kill switch, readonly, daily cap, cooldowns | No |
| `/api/kill-switch` | POST | `{on:true/false}` — engage/release the kill switch | No |
| `/api/dashboard` | GET | Returns cached campaigns + insights from SQLite | No |
| `/api/refresh` | POST | `{date_preset, only_had_delivery}` — pulls fresh data | YES — exactly 2 calls (account + batched(campaigns,insights)) |
| `/api/usage` | GET | Recent `usage_samples` (rate-limit header history) | No |
| `/api/rate-limit-details` | GET | Latest captured `x-app-usage`, `x-business-use-case-usage`, `x-fb-ads-insights-throttle`, broken out per-account and per-BUC-type, with the Marketing API tier. Mirrors the Meta dev-dashboard view. | No |
| `/api/page-token` | GET | Minted Page-token snapshot (no secret). `?verify=1` force-mints + reads the page via the page token. | Only with `?verify=1` (≤2 calls) |

### Ad Management API (`/api/ads/*`)

Pause/resume + budget edits, surfaced as the Off/On toggle and inline "Budget" editor on each dashboard row. Gated by `FB_ALLOW_AD_MANAGEMENT` (default `0`), independent of `FB_READONLY`.

| Route | Method | Effect | Hits Meta? |
|---|---|---|---|
| `/api/ads/state` | GET | `{allowAdManagement, readonly, killSwitch}` for the UI's "Managing live" chip | No |
| `/api/ads/audit` | GET | Append-only `ad_actions` log (incl. blocked/failed attempts) | No |
| `/api/ads/:level/:id/status` | POST | `{status: ACTIVE\|PAUSED}` on a campaign/adset/ad; `MANAGE`-gated | YES (when enabled) |
| `/api/ads/:level/:id/budget` | POST | `{daily_budget\|lifetime_budget}` in **minor units** on a campaign/adset; `MANAGE`-gated + **per-entity ≤4 budget edits/hour** guard | YES (when enabled) |
| `/api/ads/:level/:id/breakdowns` | GET | Insights split by `breakdown` (age_gender, country, region, platform, placement, device, hourly) × `date_preset`. Adds derived purchases/value/ROAS. | YES (read) |
| `/api/ads/:level/:id/activities` | GET | Change history for one entity — reads the **account** activity feed and filters by `object_id` (the per-node `activities` edge returns `#100`). | YES (read) |
| `/api/ads/activities` | GET | Whole-account change feed (`?entity_id=` optional) | YES (read) |
| `/api/ads/ad/:id/preview` | GET | Rendered ad preview iframe for an `ad_format` (DESKTOP_FEED_STANDARD, MOBILE_FEED_STANDARD, INSTAGRAM_*, etc.) | YES (read) |
| `/api/ads/:level/:id/duplicate` | POST | Deep-copy a campaign/adset to a **PAUSED** copy (`status_option=PAUSED`, `deep_copy=true`). Never edits the source; `MANAGE`-gated. | YES (when enabled) |

### Ad management discipline

- All ad writes go through `fb.manage(method, path, data, key)` → `safety.preflight(ep, 'MANAGE')`, using the **system-user** token (it holds `ads_management`). `MANAGE` is a distinct safety method: it bypasses the `FB_READONLY` block but is refused (HTTP 423, `ad_management_disabled`) unless `FB_ALLOW_AD_MANAGEMENT=1`, and is always halted by the kill switch.
- Only `ACTIVE`/`PAUSED` are accepted for status (no archive/delete) — keeps writes safe + reversible. Budgets are validated as positive integers in minor units; ads have no budget edge.
- Every attempt (success, failure, or gate-blocked) is appended to `ad_actions` with before/after values, payload, response and error — same auditability as `moderation_log`. Local entity status/budget is updated on success so the UI reflects the change without a full refresh.
- The UI confirms each write (`confirm()` dialog naming the entity + new value) before sending. Writes are paced by the global 750ms throttle; we do **not** batch ad writes (same anti-suspension reasoning as comment writes).
- **Budget edit rate guard (anti-suspension):** Meta caps budget edits at ~4/hour per entity; exceeding it triggers a 1-hour lockout AND flags the account. `setBudget` counts successful `budget` rows in `ad_actions` for that `entity_id` in the last hour and refuses locally (HTTP 429, `budget_rate_limit`) before ever calling Meta. This was confirmed against 2026 ban-pattern write-ups (GoMarble/Soku/Blend) + Meta rate-limit docs.
- **Read intelligence** (`breakdowns`/`activities`/`preview`) goes through `fb.get` (`GET` preflight — allowed even in read-only), counts against the daily cap + throttle, and never mutates. Previews need a *user* token; the system-user token qualifies. `duplicate` is the only "scaling" write and is safe-by-construction: the copy is created **PAUSED** and the source is untouched, satisfying "do not edit working campaigns".

### Strategy Advisor API (`/api/strategy/*`) — suggest-only, reads only

A performance advisor (`server/lib/strategist.js`) that analyzes the account and proposes a ranked action plan. It **never writes to Meta** — every output is a recommendation the operator applies manually via the existing toggle / budget / Duplicate controls. Surfaced as the indigo **Strategy** button in the header → full-screen drawer.

| Route | Method | Effect | Hits Meta? |
|---|---|---|---|
| `/api/strategy/analyze` | POST | `{window: last_7d\|14d\|28d\|30d\|90d}`. Pulls account/campaign/adset insights + entities + placement/age-gender/hourly breakdowns **plus** per-campaign daily series (90d), active-ad creative ranking, and 3 reach windows — all in **one batched read call (13 ops)**. Derives learning-phase health, patterns, trend, fatigue/scaling signals, the ranked rule action list, AND the **decision digest** (see below). Cached in-memory as `lastAnalysis`. | YES (1 batched read) |
| `/api/strategy/last` | GET | Returns the last cached analysis (incl. narrative/briefing once generated). | No |
| `/api/strategy/narrative` | POST | Gemini **weekly plan** from `lastAnalysis.digest` (`analyzer.strategyNarrative`): headline, account summary, prioritized `weekly_plan[]`, watch-outs. Requires `OPENROUTER_API_KEY`. | No (LLM direct) |
| `/api/strategy/briefing` | POST | Gemini **daily standup** from `lastAnalysis.decisions` (`analyzer.dailyBriefing`): headline, `standing_today` (today vs day-of-week-adjusted normal + 7d trend), `confident_actions[]` (high/medium only), `opportunities[]`, `watch[]`, `do_not_act[]`. Requires `OPENROUTER_API_KEY`. | No (LLM direct) |

### Decision engine (`server/lib/decisions.js` + `server/lib/stats.js`) — "confident, not one day's noise"

The decision digest (`lastAnalysis.decisions`) is the **decision-grade** layer feeding the Daily Briefing tab. It exists because at GFM's low volume (~1-100 conv/wk per entity) frequentist p-values are useless (~384 conversions needed for ±5%/95%). Instead it uses **Poisson/Bayesian credible intervals** on conversion counts, gated by sample size + persistence + day-of-week-adjusted baselines. Contents:

- `today`: latest **complete** day vs the same-weekday trailing baseline (mean/sd → **z-score** per metric); `verdict` is `anomalous` only when |z|≥2. Correctly separates "spend is up because you scaled" (high spend-z) from "CPA is actually broken" (high cpa-z).
- `trend7`: last-7d vs prior-7d (naturally day-of-week balanced) including **CPM**; `earlySaturation` fires when CPM is rising ≥15% while CTR holds — the earliest saturation tell (precedes the CPA spike).
- `concentration`: top active campaign's share of account spend; `concentrated` (≥40%) warns of the saturation-cliff / single-point-of-failure risk (playbook counter-point to over-consolidation).
- `segments` (age×gender, placement, **country**, **device**): each cell gets CPA + **95% CI**, compared to the **account-blended** CPA. `verdict` (`better`/`worse`/`similar`) is only emitted when the cell's expected conversions fall OUTSIDE the observed count's CI; low-volume cells are `insufficient`. `confidence` tier = `high` (≥50 conv) / `medium` (15-49) / `low` (5-14) / `insufficient` (<5). **Country is context-only** (this account = one campaign per country, so a country verdict ≈ a campaign — it is excluded from targeting *actions* to avoid "exclude country X" nonsense). Device IS a within-campaign action lever.
- `creative`: Meta `quality_ranking` for ACTIVE ads w/ ≥1000 impr — below-average creative flagged (caps CPM/CPA).
- `saturation`: Net New Reach % (3 reach windows) + frequency → `healthy`/`watch`/`saturating`.
- `signal`: CAPI/Dataset-Quality advisory (probe returned empty → browser-pixel-only suspected).
- `decisions[]`: per-entity + targeting + cost-cap candidates, each with an action, a `confidence` tier+score (`stats.decisionConfidence`), a rationale, a per-campaign `wow` (last-7d vs prior-7d), and `whatToWaitFor` when sub-high. Kill/scale require **persistence** (≥3 consecutive days breaching the band) AND ≥15 conversions; otherwise downgraded to `watch`/`hold`. **Scale-up safety gate:** even with a 3-day winning streak, a campaign is downgraded to `hold` if its WoW ROAS ≤ −20% or WoW CPA ≥ +25% — the playbook rule "never scale into a degrading weekly trend".

### Strategy advisor discipline

- **Suggest-only by design.** No `MANAGE`/`MODERATE` calls anywhere in `strategist.js`; it only ever calls `fb.get`/`fb.batch`. There is no "apply" button — the operator acts manually, so the account-suspension surface is unchanged.
- **KPI auto-selection:** picks the metric carrying signal for the account (purchases → other conversions → link clicks) so a $20-40/day donation account isn't judged on a KPI it doesn't optimize.
- **Noise guard:** every pattern (weekday/hour/placement/age-gender/trend) carries a `reliable` flag based on conversion volume; the UI shows a "low data" chip and the AI prompt is told patterns are directional, not gospel. Day-of-week/hour always widen to up to 90 days for sample size even when the headline window is shorter.
- **Community playbook = the AI's brain** (`COMMUNITY_PLAYBOOK` in `analyzer.js`, injected into BOTH `STRATEGY_SYSTEM_PROMPT` and `BRIEFING_SYSTEM_PROMPT`): a distilled, cross-validated 2026 ecommerce/practitioner consensus — explicitly **NOT** Meta's own in-app suggestions (those optimize for spend, not ROI). Covers kill/pause rules (3× CPA + 0 conv hard kill; 2× spend + 7d + 1.5× CPA sustained-loss; spend floors; don't edit in learning), scale (vertical ≤20%/48-72h, horizontal surf-scaling, healthy-vs-unhealthy CPM signatures, frequency<1.5 = valuable TOF), the which-metric-broke-first diagnostic, structure (consolidate but cap concentration ~40% — the saturation-cliff counter-point), bidding (bid cap > cost cap above ~50 conv/wk only), day/time weighting, and attribution caveats (CAPI gap, platform ROAS ≠ incremental). The playbook says *what* a good move looks like; the **decision digest gates whether THIS account has the evidence** to make it.
- **Hard guardrails baked into the AI prompt** (`STRATEGY_SYSTEM_PROMPT`): consolidate fragmented ABO ad sets first; vertical scaling ≤20% per 48-72h; **never** recommend Cost Cap / Bid Cap at this volume (starvation); day-parting at low budget is a gentle budget weighting, not hard on/off. Matches the all-ABO, low-budget reality of GFM Greece.
- **Daily Briefing = confidence over action** (`BRIEFING_SYSTEM_PROMPT`): the golden rule is that an item only becomes a `confident_action` when the decision digest backs it with a `high`/`medium` tier (sample size + persistence + DoW adjustment). Single-day swings go to `do_not_act` with their z-score; real-but-unproven signals go to `watch` with what to wait for. 100% certainty is impossible at this volume — the system is honest about it rather than fabricating confidence.

### Comments Manager API (`/api/cm/*`)

Full-screen manager that spans **all** active ad posts (not a per-ad drawer). Opened from the header button or an ad row.

| Route | Method | Effect | Hits Meta? |
|---|---|---|---|
| `/api/cm/state` | GET | Page catalog + summary counts + rules + moderation/analyzer flags | No |
| `/api/cm/posts` | GET | Post catalog (per-post counts: total/hidden/suggest_delete/unanalyzed/needs_reply) | No |
| `/api/cm/inbox` | GET | Unified inbox; `filter`, `sort`, `post_id`, `min_sev`, `q`, `limit`, `offset` | No |
| `/api/cm/sync` | POST | **Full sync.** Discover posts from ads → **batched field-expanded** fetch (post meta + comments in one call per post, ≤`CM_BATCH_SIZE` posts per Graph batch) → AI review → apply auto-hide rules. Only posts owned by `FB_TARGET_PAGE_ID` are fetched; foreign-page posts are skipped + pruned. | YES (bounded, few top-level calls) |
| `/api/cm/sync-comments` | POST | **Comments-only sync.** Re-pulls comments for posts ALREADY in the catalog (skips discovery + post-meta refresh), reconciles deletions, then AI review + auto-hide rules. Lighter/faster routine "any new comments?" path. Live: 11 posts / 293 comments / 2 batch calls. | YES (bounded) |
| `/api/cm/discover` | POST | Rebuild post catalog (meta only, batched) from the ads table | YES |
| `/api/cm/posts/:id/refresh` | POST | Re-pull one post's comments (field-expanded + paginated) | YES |
| `/api/cm/posts/:id/analyze` | POST | AI review one post's comments (`{force}`) | No (LLM direct) |
| `/api/cm/analyze` | POST | AI review all not-yet-analyzed comments | No (LLM direct) |
| `/api/cm/comments/:id/{hide\|unhide\|like\|unlike\|reply}` | POST | Per-comment action; gated by `FB_ALLOW_COMMENT_MODERATION` | YES (when enabled) |
| `/api/cm/comments/:id` | DELETE | Delete a comment; gated | YES (when enabled) |
| `/api/cm/comments/:id/block` | POST | Block author only (keeps comment); 422 if no PSID; gated | YES (when enabled) |
| `/api/cm/comments/:id/delete-and-block` | POST | Delete + block author (PSID); falls back to delete-only if no PSID; gated | YES (when enabled) |
| `/api/cm/comments/:id/suggest-reply` | POST | LLM-suggested reply (no Meta write) | No (LLM direct) |
| `/api/cm/bulk` | POST | `{action, ids[]}` (`hide\|unhide\|like\|unlike\|delete\|block\|delete-and-block`) — sequential, paced, stops early on safety block; gated | YES (when enabled) |
| `/api/cm/rules` `…/:id` `…/preview` `…/apply` | GET/POST/PATCH/DELETE | Auto-hide rules CRUD, dry-run preview, apply-now (hide matches) | apply = YES (gated) |
| `/api/cm/audit` | GET | Append-only moderation log (incl. blocked attempts) | No |
| `/api/cm/blocked` `…/:psid/unblock` | GET/POST | Blocked-users list + unblock; gated | unblock = YES |
| `/api/cm/new-since` | POST | `{lastVisits}` → per-post new-comment counts since last visit | No |

### Comment moderation discipline

- Page-content edges use `tokenKind: 'page'` (minted token); ad/insights edges use the system-user token. LLM calls bypass Meta entirely.
- **All destructive/write comment actions** (hide/unhide/delete/like/reply/block/unblock) go through `fb.moderate`, gated by `FB_ALLOW_COMMENT_MODERATION` (default `0`), **independent of `FB_READONLY`**. When the gate is off the server returns HTTP 423 and the attempt is still written to `moderation_log` (auditable). Deletes use `DELETE /{comment_id}` (treat error `100`/"already gone" as success); hide uses `POST /{comment_id}` with `is_hidden`.
- **Suggest-only auto-delete (user decision, 2026-05-28).** The AI never deletes silently. `recommended_action: 'delete'` only *flags* a comment (red badge / "AI: suggest delete" filter); a human confirms via single action or bulk approval. Auto-mod **rules** may auto-**hide** on sync, never auto-delete.
- **Thread-aware AI.** `analyzer.js` passes parent comment + replies so a scam/fake/AI accusation that already has strong defending replies is downgraded from `delete` to `review` (preserve social proof). Categories: hate, harassment, threat, scam_accusation, ai_accusation, fake_accusation, spam, negative_criticism, safe. Severity 0–10. Always returns an English translation.
- **Commenter names/PSIDs require an app feature, not code.** `from{name,id}` is `null` for ordinary users unless the app is approved (App Review, Advanced access) for `pages_read_user_content` + the **"Business Asset User Profile Access"** feature (+ business verification + published privacy/ToS). Other Pages and the Page's own replies always resolve (empirically: in our data only 1/294 comments had a name, and it was a Page). Comment **IDs always return** with a page token, so hide/delete/reply work regardless. Blocking needs a **PSID** (the `from.id`), so it is gated by the same feature — the UI shows a "no id" badge and hides the Block button when absent; `delete-and-block` degrades to delete-only.
- **READS are batched, WRITES are not (deliberate).** `commentSync` fetches post meta + the first comment page in ONE field-expanded call per post, bundled into Graph batches (top-level **page** token via `fb.batch(ops, key, { tokenKind: 'page' })`), then paginates remaining pages in further batches. This collapses a full sync from ~80+ top-level calls to a handful. Moderation **writes stay sequential + 750ms-paced + `MODERATE`-gated** — batching writes would remove the anti-suspension pacing and bypass the safety gate, so we never do it. Reconcile (mark-missing-as-deleted) only runs when a post's full stream was fetched (no remaining `next`), so capped pagination never wrongly deletes.
- Sync is bounded by `CM_MAX_POSTS_PER_SYNC` and `CM_MAX_COMMENT_PAGES_PER_POST`; AI by `ANALYSIS_BATCH_SIZE`/`ANALYSIS_BATCH_CONCURRENCY`/`ANALYSIS_MAX_COMMENTS_PER_RUN`. Heuristic spam flagging (link/contact/spam-keyword) is still computed at fetch and stored in `comments.flag_reasons` as a cheap pre-AI signal.

## Forbidden patterns

- `requests.get('https://graph.facebook.com/...')` without `proxies=` — **NEVER**.
- `os.environ.get('HTTP_PROXY')` — we use explicit config, not OS env.
- Sequential `for id in ids: GET /id` when one batched or field-expanded call would do.
- Refreshing a list every time the user opens the UI; use the cache.
- Logging tokens, full user comment text in errors, or PII.
- Sending many ad-set writes for the same campaign in one batch (Meta rejects the whole batch).
