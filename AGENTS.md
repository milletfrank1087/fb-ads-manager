# AGENTS.md — Comment Auto-Moderation

Rules for every agent and script in this repo. Read before touching code or calling the Graph API.

## What this is

A single-operator app that watches chosen Facebook posts on Page `FB_TARGET_PAGE_ID`, fetches new comments on a schedule, has an LLM classify them, and hides/deletes them according to a per-category policy. Nothing else: no ads dashboard, no advisor, no page posting (removed 2026-09-24).

## Flow

1. **Posts** (`lib/posts.js`) — the operator picks posts to track in the UI. Candidates come from the ads in every ad account the token can see (`/me/adaccounts` → batched `/act_x/ads`, optional `FB_AD_ACCOUNT_IDS` filter → `creative.effective_object_story_id`, incl. dark posts), the Page's `published_posts`, or a pasted ID/URL. Tracking is saved in `posts.tracked` with `tracked_at`.
2. **Run** (`lib/automation.js`, every `intervalMinutes`, default 60, set in the UI):
   - Fetch tracked posts' comments newest-first in Graph batches, stopping at the first already-known comment. Usually 1 batch call per run.
   - AI-review every not-yet-reviewed comment (not the Page's own).
   - Apply the policy to **candidates only**: reviewed, not deleted, not by the Page, never handled by a human, not already processed, and posted **after** `tracked_at`. Older comments are only acted on via the per-post "Review older" button.
   - Log every action (`actions`) and the run (`runs`).
3. **Policy** (`settings.automod.policy`): per category `{action: off|hide|delete, minSeverity, requireAiDelete}`. Defaults reproduce the pre-rewrite rule: delete when the AI recommends `delete` at severity ≥ 4 for hate/harassment/threat/spam/scam/AI/fake accusations.

## Non-negotiable rules

- **Proxy is optional.** If `PROXY_HOST` and `PROXY_PORT` are set, every Graph call is tunneled through the proxy (never falls back to direct when configured). If they are empty, Graph calls go direct. OpenRouter is always called directly (only comment text + post context is sent).
- **`appsecret_proof` on every call**, tokens masked in logs (`maskToken`). The only stored credential is `FB_SYSTEM_USER_ACCESS_TOKEN`; the Page token is minted at runtime (`lib/pageToken.js`) and re-minted once on error 190.
- **Writes are gated** by `FB_ALLOW_COMMENT_MODERATION` (env) and the kill switch (env or UI, persisted). Writes are never batched; they go one at a time through the 750 ms throttle queue and are capped per run (`maxActionsPerRun`).
- **Humans win.** Any manual action marks the comment `handled_by_human`; automation never touches it again.
- **Rate limits.** Daily cap `FB_MAX_DAILY_CALLS` (per account-tz day), per-endpoint cooldown after consecutive errors, ≥60 min cooldown (or Meta's `estimated_time_to_regain_access`) on rate-limit codes 4/17/32/613/80000-80004, backoff at 80/90% usage headers.
- **No `x-html`** in the UI; all user/Meta/LLM text renders via `x-text`.
- **Polling, not webhooks (for now).** Page `feed` webhooks (`item: comment, verb: add`) would push comments in real time, but Meta only delivers them for ordinary users when the app is **Live** with **Advanced Access** (App Review) for `pages_manage_metadata`/`pages_read_engagement`; in Development mode only people with a role on the app trigger them. They also need a public HTTPS endpoint, `X-Hub-Signature-256` verification, and a `POST /{page}/subscribed_apps?subscribed_fields=feed`. If added later, keep the hourly poll as a backfill (Meta retries failed deliveries for ~36h but can still miss events).
- Blocking needs the commenter's PSID (`from.id`), which Meta only returns with App Review + "Business Asset User Profile Access". The Block button only appears when an ID exists.

## Files

```
server/server.js          Express routes (/api/state, settings, posts, comments, runs, blocked); bulk actions are sequential per-comment calls from the UI
server/lib/env.js         config
server/lib/fbClient.js    proxied, signed, throttled Graph client (get / write / read-only batch)
server/lib/pageToken.js   runtime Page token
server/lib/safety.js      kill switch, daily cap, cooldowns, write gate
server/lib/store.js       SQLite schema + queries (data/automod.db, or $DATA_DIR)
server/lib/posts.js       post discovery + paste-to-track
server/lib/comments.js    comment normalisation + hide/unhide/delete/like/reply/block (audited)
server/lib/analyzer.js    OpenRouter classification, post context, reply drafts
server/lib/automation.js  settings/policy, fetch → review → act pipeline, scheduler
server/public/            index.html + app.js (Alpine + Tailwind CDN)
```

## Running

```powershell
cd server; npm install; node server.js   # http://localhost:3000
```

Always verify on localhost before pushing: a push to GitHub auto-deploys to Railway. On Railway, mount a volume and set `DATA_DIR` to it, or the database resets on every deploy. The app has no login (operator's choice), so keep the URL private.
