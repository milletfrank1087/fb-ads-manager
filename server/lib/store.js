import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { ROOT } from './env.js';
import { log } from './logger.js';

const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'dashboard.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  name TEXT,
  currency TEXT,
  timezone_name TEXT,
  account_status INTEGER,
  amount_spent REAL,
  spend_cap REAL,
  business_id TEXT,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT,
  status TEXT,
  effective_status TEXT,
  objective TEXT,
  daily_budget REAL,
  lifetime_budget REAL,
  buying_type TEXT,
  bid_strategy TEXT,
  start_time TEXT,
  stop_time TEXT,
  created_time TEXT,
  updated_time TEXT,
  last_synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_acct ON campaigns(account_id);

CREATE TABLE IF NOT EXISTS adsets (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  name TEXT,
  status TEXT,
  effective_status TEXT,
  optimization_goal TEXT,
  billing_event TEXT,
  bid_strategy TEXT,
  bid_amount REAL,
  daily_budget REAL,
  lifetime_budget REAL,
  targeting_summary TEXT,
  start_time TEXT,
  end_time TEXT,
  created_time TEXT,
  updated_time TEXT,
  last_synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_adsets_acct ON adsets(account_id);
CREATE INDEX IF NOT EXISTS idx_adsets_camp ON adsets(campaign_id);

CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  adset_id TEXT NOT NULL,
  name TEXT,
  status TEXT,
  effective_status TEXT,
  creative_id TEXT,
  creative_thumb_url TEXT,
  creative_title TEXT,
  creative_body TEXT,
  created_time TEXT,
  updated_time TEXT,
  last_synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ads_acct ON ads(account_id);
CREATE INDEX IF NOT EXISTS idx_ads_adset ON ads(adset_id);
CREATE INDEX IF NOT EXISTS idx_ads_camp ON ads(campaign_id);

CREATE TABLE IF NOT EXISTS insights_snapshot (
  account_id TEXT NOT NULL,
  entity_level TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  date_preset TEXT NOT NULL,
  spend REAL,
  reach INTEGER,
  impressions INTEGER,
  cpm REAL,
  frequency REAL,
  inline_link_clicks INTEGER,
  unique_inline_link_clicks INTEGER,
  unique_inline_link_click_ctr REAL,
  cost_per_inline_link_click REAL,

  post_comments INTEGER,
  post_engagements INTEGER,
  link_clicks INTEGER,

  landing_page_views_total INTEGER,
  landing_page_views_app INTEGER,
  landing_page_views_website INTEGER,
  cost_per_landing_page_view REAL,

  atc_total INTEGER,
  atc_app INTEGER,
  atc_website INTEGER,
  atc_offline INTEGER,
  atc_meta INTEGER,
  cost_per_add_to_cart REAL,

  ic_total INTEGER,
  ic_app INTEGER,
  ic_website INTEGER,
  ic_offline INTEGER,
  ic_meta INTEGER,
  cost_per_initiate_checkout REAL,

  purchases_total INTEGER,
  purchases_app INTEGER,
  purchases_website INTEGER,
  purchases_offline INTEGER,
  purchases_meta INTEGER,
  cost_per_purchase REAL,

  purchase_value_total REAL,
  purchase_value_app REAL,
  purchase_value_website REAL,
  purchase_value_offline REAL,
  purchase_value_meta REAL,

  purchase_roas_total REAL,
  purchase_roas_website REAL,
  purchase_roas_app REAL,

  raw_actions_json TEXT,
  raw_action_values_json TEXT,
  raw_cost_per_action_type_json TEXT,
  raw_roas_json TEXT,

  fetched_at TEXT NOT NULL,
  PRIMARY KEY (account_id, entity_level, entity_id, date_preset)
);

CREATE TABLE IF NOT EXISTS usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  where_path TEXT,
  method TEXT,
  http_status INTEGER,
  x_app_usage TEXT,
  x_business_use_case_usage TEXT,
  x_ad_account_usage TEXT,
  x_fb_ads_insights_throttle TEXT,
  app_max_pct REAL,
  buc_max_pct REAL,
  insights_app_pct REAL,
  insights_acc_pct REAL,
  ads_api_access_tier TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_samples(ts);

CREATE TABLE IF NOT EXISTS safety_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_call_counter (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS endpoint_cooldowns (
  endpoint TEXT PRIMARY KEY,
  cooldown_until TEXT NOT NULL,
  reason TEXT,
  consecutive_errors INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS refresh_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  date_preset TEXT,
  status TEXT,
  http_calls INTEGER,
  campaigns_count INTEGER,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  ad_id TEXT,
  parent_id TEXT,
  message TEXT,
  from_id TEXT,
  from_name TEXT,
  created_time TEXT,
  like_count INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0,
  can_hide INTEGER DEFAULT 0,
  can_remove INTEGER DEFAULT 0,
  permalink_url TEXT,
  attachment_type TEXT,
  attachment_url TEXT,
  flagged INTEGER DEFAULT 0,
  flag_reasons TEXT,
  deleted INTEGER DEFAULT 0,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_ad ON comments(ad_id);

CREATE TABLE IF NOT EXISTS ad_posts (
  id TEXT PRIMARY KEY,
  page_id TEXT,
  ad_id TEXT,
  ad_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  effective_status TEXT,
  message TEXT,
  full_picture_url TEXT,
  permalink_url TEXT,
  created_time TEXT,
  is_dark_post INTEGER DEFAULT 0,
  ai_summary TEXT,
  ai_ad_type TEXT,
  ai_category TEXT,
  ai_severity INTEGER,
  ai_explanation TEXT,
  ai_model TEXT,
  ai_analyzed_at TEXT,
  last_comment_synced_at TEXT,
  last_synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ad_posts_status ON ad_posts(effective_status);

CREATE TABLE IF NOT EXISTS comment_analyses (
  comment_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 0,
  english_translation TEXT,
  explanation TEXT,
  recommended_action TEXT NOT NULL DEFAULT 'review',
  action_reason TEXT,
  model TEXT,
  analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analyses_category ON comment_analyses(category);
CREATE INDEX IF NOT EXISTS idx_analyses_action ON comment_analyses(recommended_action);

CREATE TABLE IF NOT EXISTS auto_mod_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pattern TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK(match_type IN ('contains','regex','has_url','equals')),
  action TEXT NOT NULL DEFAULT 'hide' CHECK(action IN ('hide')),
  case_sensitive INTEGER DEFAULT 0,
  is_enabled INTEGER DEFAULT 1,
  hit_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  comment_id TEXT,
  post_id TEXT,
  commenter_psid TEXT,
  commenter_name TEXT,
  message_preview TEXT,
  payload_json TEXT,
  response_json TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_modlog_created ON moderation_log(created_at);
CREATE INDEX IF NOT EXISTS idx_modlog_action ON moderation_log(action);

CREATE TABLE IF NOT EXISTS blocked_users (
  psid TEXT PRIMARY KEY,
  name TEXT,
  blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
  unblocked_at TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS ad_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  level TEXT,
  entity_id TEXT,
  entity_name TEXT,
  before_value TEXT,
  after_value TEXT,
  payload_json TEXT,
  response_json TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_adactions_created ON ad_actions(created_at);

CREATE TABLE IF NOT EXISTS strategy_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  window TEXT,
  elapsed_ms INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stratchat_session ON strategy_chat(session_id);
CREATE INDEX IF NOT EXISTS idx_stratchat_created ON strategy_chat(created_at);
`;

db.exec(SCHEMA);

for (const migration of [
  'ALTER TABLE ads ADD COLUMN creative_object_story_id TEXT',
  'ALTER TABLE comments ADD COLUMN from_picture_url TEXT',
  'ALTER TABLE comments ADD COLUMN attachment_json TEXT',
  'ALTER TABLE comments ADD COLUMN has_url INTEGER DEFAULT 0',
  'ALTER TABLE comments ADD COLUMN my_reply_id TEXT',
  'ALTER TABLE comments ADD COLUMN user_likes INTEGER DEFAULT 0',
  'ALTER TABLE comments ADD COLUMN can_reply_privately INTEGER DEFAULT 0',
  'ALTER TABLE comments ADD COLUMN first_seen_at TEXT',
]) {
  try { db.exec(migration); } catch (err) {
    if (!/duplicate column name/i.test(String(err.message || err))) {
      log.warn('store.migration.skipped', { migration, error: String(err.message || err) });
    }
  }
}
try {
  const filled = db.prepare("UPDATE comments SET first_seen_at = COALESCE(datetime(fetched_at), datetime('now')) WHERE first_seen_at IS NULL").run().changes;
  if (filled) log.info('store.migration.backfill_first_seen', { rows: filled });
} catch (err) {
  log.warn('store.migration.backfill_first_seen.failed', { error: String(err.message || err) });
}
log.info('store.init', { path: DB_PATH, tables: db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table'").get().c });

const upsertAccountStmt = db.prepare(`
INSERT INTO account (id, name, currency, timezone_name, account_status, amount_spent, spend_cap, business_id, last_synced_at)
VALUES (@id, @name, @currency, @timezone_name, @account_status, @amount_spent, @spend_cap, @business_id, @last_synced_at)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  currency=excluded.currency,
  timezone_name=excluded.timezone_name,
  account_status=excluded.account_status,
  amount_spent=excluded.amount_spent,
  spend_cap=excluded.spend_cap,
  business_id=excluded.business_id,
  last_synced_at=excluded.last_synced_at
`);

const upsertCampaignStmt = db.prepare(`
INSERT INTO campaigns (id, account_id, name, status, effective_status, objective, daily_budget, lifetime_budget, buying_type, bid_strategy, start_time, stop_time, created_time, updated_time, last_synced_at)
VALUES (@id, @account_id, @name, @status, @effective_status, @objective, @daily_budget, @lifetime_budget, @buying_type, @bid_strategy, @start_time, @stop_time, @created_time, @updated_time, @last_synced_at)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  status=excluded.status,
  effective_status=excluded.effective_status,
  objective=excluded.objective,
  daily_budget=excluded.daily_budget,
  lifetime_budget=excluded.lifetime_budget,
  buying_type=excluded.buying_type,
  bid_strategy=excluded.bid_strategy,
  start_time=excluded.start_time,
  stop_time=excluded.stop_time,
  created_time=excluded.created_time,
  updated_time=excluded.updated_time,
  last_synced_at=excluded.last_synced_at
`);

const upsertAdsetStmt = db.prepare(`
INSERT INTO adsets (id, account_id, campaign_id, name, status, effective_status, optimization_goal, billing_event, bid_strategy, bid_amount, daily_budget, lifetime_budget, targeting_summary, start_time, end_time, created_time, updated_time, last_synced_at)
VALUES (@id, @account_id, @campaign_id, @name, @status, @effective_status, @optimization_goal, @billing_event, @bid_strategy, @bid_amount, @daily_budget, @lifetime_budget, @targeting_summary, @start_time, @end_time, @created_time, @updated_time, @last_synced_at)
ON CONFLICT(id) DO UPDATE SET
  campaign_id=excluded.campaign_id,
  name=excluded.name,
  status=excluded.status,
  effective_status=excluded.effective_status,
  optimization_goal=excluded.optimization_goal,
  billing_event=excluded.billing_event,
  bid_strategy=excluded.bid_strategy,
  bid_amount=excluded.bid_amount,
  daily_budget=excluded.daily_budget,
  lifetime_budget=excluded.lifetime_budget,
  targeting_summary=excluded.targeting_summary,
  start_time=excluded.start_time,
  end_time=excluded.end_time,
  created_time=excluded.created_time,
  updated_time=excluded.updated_time,
  last_synced_at=excluded.last_synced_at
`);

const upsertAdStmt = db.prepare(`
INSERT INTO ads (id, account_id, campaign_id, adset_id, name, status, effective_status, creative_id, creative_thumb_url, creative_title, creative_body, creative_object_story_id, created_time, updated_time, last_synced_at)
VALUES (@id, @account_id, @campaign_id, @adset_id, @name, @status, @effective_status, @creative_id, @creative_thumb_url, @creative_title, @creative_body, @creative_object_story_id, @created_time, @updated_time, @last_synced_at)
ON CONFLICT(id) DO UPDATE SET
  campaign_id=excluded.campaign_id,
  adset_id=excluded.adset_id,
  name=excluded.name,
  status=excluded.status,
  effective_status=excluded.effective_status,
  creative_id=excluded.creative_id,
  creative_thumb_url=excluded.creative_thumb_url,
  creative_title=excluded.creative_title,
  creative_body=excluded.creative_body,
  creative_object_story_id=excluded.creative_object_story_id,
  created_time=excluded.created_time,
  updated_time=excluded.updated_time,
  last_synced_at=excluded.last_synced_at
`);

const wipeInsightsStmt = db.prepare(`
DELETE FROM insights_snapshot WHERE account_id = ? AND entity_level = ? AND date_preset = ?
`);

const INSIGHT_COLS = [
  'account_id', 'entity_level', 'entity_id', 'date_preset',
  'spend', 'reach', 'impressions', 'cpm', 'frequency',
  'inline_link_clicks', 'unique_inline_link_clicks', 'unique_inline_link_click_ctr', 'cost_per_inline_link_click',
  'post_comments', 'post_engagements', 'link_clicks',
  'landing_page_views_total', 'landing_page_views_app', 'landing_page_views_website', 'cost_per_landing_page_view',
  'atc_total', 'atc_app', 'atc_website', 'atc_offline', 'atc_meta', 'cost_per_add_to_cart',
  'ic_total', 'ic_app', 'ic_website', 'ic_offline', 'ic_meta', 'cost_per_initiate_checkout',
  'purchases_total', 'purchases_app', 'purchases_website', 'purchases_offline', 'purchases_meta', 'cost_per_purchase',
  'purchase_value_total', 'purchase_value_app', 'purchase_value_website', 'purchase_value_offline', 'purchase_value_meta',
  'purchase_roas_total', 'purchase_roas_website', 'purchase_roas_app',
  'raw_actions_json', 'raw_action_values_json', 'raw_cost_per_action_type_json', 'raw_roas_json',
  'fetched_at',
];

const INSIGHT_UPDATE_COLS = INSIGHT_COLS.filter((c) => !['account_id', 'entity_level', 'entity_id', 'date_preset'].includes(c));

const upsertInsightStmt = db.prepare(`
INSERT INTO insights_snapshot (${INSIGHT_COLS.join(', ')})
VALUES (${INSIGHT_COLS.map((c) => '@' + c).join(', ')})
ON CONFLICT(account_id, entity_level, entity_id, date_preset) DO UPDATE SET
  ${INSIGHT_UPDATE_COLS.map((c) => `${c}=excluded.${c}`).join(',\n  ')}
`);

const insertUsageStmt = db.prepare(`
INSERT INTO usage_samples (
  ts, where_path, method, http_status,
  x_app_usage, x_business_use_case_usage, x_ad_account_usage, x_fb_ads_insights_throttle,
  app_max_pct, buc_max_pct, insights_app_pct, insights_acc_pct, ads_api_access_tier
) VALUES (
  @ts, @where_path, @method, @http_status,
  @x_app_usage, @x_business_use_case_usage, @x_ad_account_usage, @x_fb_ads_insights_throttle,
  @app_max_pct, @buc_max_pct, @insights_app_pct, @insights_acc_pct, @ads_api_access_tier
)
`);

const insertRunStmt = db.prepare(`
INSERT INTO refresh_runs (started_at, date_preset, status) VALUES (?, ?, 'running')
`);

const upsertCommentStmt = db.prepare(`
INSERT INTO comments (id, post_id, ad_id, parent_id, message, from_id, from_name, from_picture_url, created_time,
  like_count, comment_count, is_hidden, can_hide, can_remove, can_reply_privately, user_likes,
  permalink_url, attachment_type, attachment_url, attachment_json, has_url, my_reply_id,
  flagged, flag_reasons, deleted, fetched_at, first_seen_at)
VALUES (@id, @post_id, @ad_id, @parent_id, @message, @from_id, @from_name, @from_picture_url, @created_time,
  @like_count, @comment_count, @is_hidden, @can_hide, @can_remove, @can_reply_privately, @user_likes,
  @permalink_url, @attachment_type, @attachment_url, @attachment_json, @has_url, @my_reply_id,
  @flagged, @flag_reasons, 0, @fetched_at, datetime('now'))
ON CONFLICT(id) DO UPDATE SET
  post_id=excluded.post_id,
  ad_id=COALESCE(excluded.ad_id, comments.ad_id),
  parent_id=excluded.parent_id,
  message=excluded.message,
  from_id=COALESCE(excluded.from_id, comments.from_id),
  from_name=COALESCE(excluded.from_name, comments.from_name),
  from_picture_url=COALESCE(excluded.from_picture_url, comments.from_picture_url),
  created_time=excluded.created_time,
  like_count=excluded.like_count,
  comment_count=excluded.comment_count,
  is_hidden=excluded.is_hidden,
  can_hide=excluded.can_hide,
  can_remove=excluded.can_remove,
  can_reply_privately=excluded.can_reply_privately,
  user_likes=excluded.user_likes,
  permalink_url=COALESCE(excluded.permalink_url, comments.permalink_url),
  attachment_type=excluded.attachment_type,
  attachment_url=excluded.attachment_url,
  attachment_json=excluded.attachment_json,
  has_url=excluded.has_url,
  my_reply_id=COALESCE(excluded.my_reply_id, comments.my_reply_id),
  flagged=excluded.flagged,
  flag_reasons=excluded.flag_reasons,
  deleted=0,
  fetched_at=excluded.fetched_at
`);

const upsertAdPostStmt = db.prepare(`
INSERT INTO ad_posts (id, page_id, ad_id, ad_name, campaign_id, campaign_name, adset_id, adset_name,
  effective_status, message, full_picture_url, permalink_url, created_time, is_dark_post, last_synced_at)
VALUES (@id, @page_id, @ad_id, @ad_name, @campaign_id, @campaign_name, @adset_id, @adset_name,
  @effective_status, @message, @full_picture_url, @permalink_url, @created_time, @is_dark_post, @last_synced_at)
ON CONFLICT(id) DO UPDATE SET
  ad_id=COALESCE(excluded.ad_id, ad_posts.ad_id),
  ad_name=COALESCE(excluded.ad_name, ad_posts.ad_name),
  campaign_id=COALESCE(excluded.campaign_id, ad_posts.campaign_id),
  campaign_name=COALESCE(excluded.campaign_name, ad_posts.campaign_name),
  adset_id=COALESCE(excluded.adset_id, ad_posts.adset_id),
  adset_name=COALESCE(excluded.adset_name, ad_posts.adset_name),
  effective_status=COALESCE(excluded.effective_status, ad_posts.effective_status),
  message=COALESCE(excluded.message, ad_posts.message),
  full_picture_url=COALESCE(excluded.full_picture_url, ad_posts.full_picture_url),
  permalink_url=COALESCE(excluded.permalink_url, ad_posts.permalink_url),
  created_time=COALESCE(excluded.created_time, ad_posts.created_time),
  is_dark_post=excluded.is_dark_post,
  last_synced_at=excluded.last_synced_at
`);

const upsertAnalysisStmt = db.prepare(`
INSERT INTO comment_analyses (comment_id, category, severity, english_translation, explanation, recommended_action, action_reason, model, analyzed_at)
VALUES (@comment_id, @category, @severity, @english_translation, @explanation, @recommended_action, @action_reason, @model, datetime('now'))
ON CONFLICT(comment_id) DO UPDATE SET
  category=excluded.category,
  severity=excluded.severity,
  english_translation=excluded.english_translation,
  explanation=excluded.explanation,
  recommended_action=excluded.recommended_action,
  action_reason=excluded.action_reason,
  model=excluded.model,
  analyzed_at=excluded.analyzed_at
`);

const insertModLogStmt = db.prepare(`
INSERT INTO moderation_log (action, comment_id, post_id, commenter_psid, commenter_name, message_preview, payload_json, response_json, success, error_message)
VALUES (@action, @comment_id, @post_id, @commenter_psid, @commenter_name, @message_preview, @payload_json, @response_json, @success, @error_message)
`);

const CM_INBOX_FILTERS = {
  all: '',
  visible: 'c.is_hidden = 0',
  hidden: 'c.is_hidden = 1',
  has_url: 'c.has_url = 1 AND c.is_hidden = 0',
  needs_reply: 'c.my_reply_id IS NULL AND c.is_hidden = 0',
  suggest_delete: "a.recommended_action = 'delete' AND c.is_hidden = 0",
  review: "(a.recommended_action = 'delete' OR COALESCE(a.severity, -1) >= 7 OR a.category IN ('hate','harassment','threat','scam_accusation','ai_accusation','fake_accusation','spam')) AND c.is_hidden = 0",
  flagged: "a.category IN ('hate','harassment','threat','scam_accusation','ai_accusation','fake_accusation','spam') AND c.is_hidden = 0",
  scam_accusation: "a.category = 'scam_accusation' AND c.is_hidden = 0",
  ai_accusation: "a.category = 'ai_accusation' AND c.is_hidden = 0",
  fake_accusation: "a.category = 'fake_accusation' AND c.is_hidden = 0",
  hate: "a.category = 'hate' AND c.is_hidden = 0",
  harassment: "a.category = 'harassment' AND c.is_hidden = 0",
  threat: "a.category = 'threat' AND c.is_hidden = 0",
  spam: "a.category = 'spam' AND c.is_hidden = 0",
  negative_criticism: "a.category = 'negative_criticism' AND c.is_hidden = 0",
  safe: "a.category = 'safe' AND c.is_hidden = 0",
  unanalyzed: 'a.comment_id IS NULL AND c.is_hidden = 0',
};

const CM_INBOX_SORTS = {
  severity_desc: 'COALESCE(a.severity, -1) DESC, c.created_time DESC',
  severity_asc: 'COALESCE(a.severity, 99) ASC, c.created_time DESC',
  newest: 'c.created_time DESC',
  oldest: 'c.created_time ASC',
  likes_desc: 'c.like_count DESC, c.created_time DESC',
};

const updateRunStmt = db.prepare(`
UPDATE refresh_runs SET finished_at = ?, status = ?, http_calls = ?, campaigns_count = ?, error_message = ?
WHERE id = ?
`);

export const store = {
  db,

  upsertAccount(a) {
    upsertAccountStmt.run({
      id: a.id,
      name: a.name ?? null,
      currency: a.currency ?? null,
      timezone_name: a.timezone_name ?? null,
      account_status: a.account_status ?? null,
      amount_spent: a.amount_spent !== undefined && a.amount_spent !== null ? Number(a.amount_spent) : null,
      spend_cap: a.spend_cap !== undefined && a.spend_cap !== null ? Number(a.spend_cap) : null,
      business_id: a.business?.id ?? null,
      last_synced_at: new Date().toISOString(),
    });
  },

  upsertCampaigns(accountId, campaigns) {
    const now = new Date().toISOString();
    const tx = db.transaction((rows) => {
      for (const c of rows) {
        upsertCampaignStmt.run({
          id: c.id,
          account_id: accountId,
          name: c.name ?? null,
          status: c.status ?? null,
          effective_status: c.effective_status ?? null,
          objective: c.objective ?? null,
          daily_budget: c.daily_budget !== undefined && c.daily_budget !== null ? Number(c.daily_budget) : null,
          lifetime_budget: c.lifetime_budget !== undefined && c.lifetime_budget !== null ? Number(c.lifetime_budget) : null,
          buying_type: c.buying_type ?? null,
          bid_strategy: c.bid_strategy ?? null,
          start_time: c.start_time ?? null,
          stop_time: c.stop_time ?? null,
          created_time: c.created_time ?? null,
          updated_time: c.updated_time ?? null,
          last_synced_at: now,
        });
      }
    });
    tx(campaigns);
  },

  upsertAdsets(accountId, adsets) {
    const now = new Date().toISOString();
    const tx = db.transaction((rows) => {
      for (const a of rows) {
        upsertAdsetStmt.run({
          id: a.id,
          account_id: accountId,
          campaign_id: a.campaign_id ?? null,
          name: a.name ?? null,
          status: a.status ?? null,
          effective_status: a.effective_status ?? null,
          optimization_goal: a.optimization_goal ?? null,
          billing_event: a.billing_event ?? null,
          bid_strategy: a.bid_strategy ?? null,
          bid_amount: a.bid_amount != null ? Number(a.bid_amount) : null,
          daily_budget: a.daily_budget != null ? Number(a.daily_budget) : null,
          lifetime_budget: a.lifetime_budget != null ? Number(a.lifetime_budget) : null,
          targeting_summary: a.targeting ? JSON.stringify(a.targeting).slice(0, 4000) : null,
          start_time: a.start_time ?? null,
          end_time: a.end_time ?? null,
          created_time: a.created_time ?? null,
          updated_time: a.updated_time ?? null,
          last_synced_at: now,
        });
      }
    });
    tx(adsets);
  },

  upsertAds(accountId, ads) {
    const now = new Date().toISOString();
    const tx = db.transaction((rows) => {
      for (const a of rows) {
        const creative = a.creative || {};
        upsertAdStmt.run({
          id: a.id,
          account_id: accountId,
          campaign_id: a.campaign_id ?? null,
          adset_id: a.adset_id ?? null,
          name: a.name ?? null,
          status: a.status ?? null,
          effective_status: a.effective_status ?? null,
          creative_id: creative.id ?? null,
          creative_thumb_url: creative.thumbnail_url ?? null,
          creative_title: creative.title ?? null,
          creative_body: creative.body ?? null,
          creative_object_story_id: creative.effective_object_story_id ?? creative.object_story_id ?? null,
          created_time: a.created_time ?? null,
          updated_time: a.updated_time ?? null,
          last_synced_at: now,
        });
      }
    });
    tx(ads);
  },

  replaceInsightsForPreset(accountId, entityLevel, datePreset, rows) {
    const tx = db.transaction(() => {
      wipeInsightsStmt.run(accountId, entityLevel, datePreset);
      const now = new Date().toISOString();
      for (const r of rows) {
        upsertInsightStmt.run({
          account_id: accountId,
          entity_level: entityLevel,
          entity_id: r.entityId,
          date_preset: datePreset,
          spend: r.spend ?? null,
          reach: r.reach ?? null,
          impressions: r.impressions ?? null,
          cpm: r.cpm ?? null,
          frequency: r.frequency ?? null,
          inline_link_clicks: r.inlineLinkClicks ?? null,
          unique_inline_link_clicks: r.uniqueInlineLinkClicks ?? null,
          unique_inline_link_click_ctr: r.uniqueInlineLinkClickCtr ?? null,
          cost_per_inline_link_click: r.costPerInlineLinkClick ?? null,
          post_comments: r.postComments ?? 0,
          post_engagements: r.postEngagements ?? 0,
          link_clicks: r.linkClicks ?? 0,
          landing_page_views_total: r.landingPageViewsTotal ?? 0,
          landing_page_views_app: r.landingPageViewsApp ?? 0,
          landing_page_views_website: r.landingPageViewsWebsite ?? 0,
          cost_per_landing_page_view: r.costPerLandingPageView ?? null,
          atc_total: r.atcTotal ?? 0,
          atc_app: r.atcApp ?? 0,
          atc_website: r.atcWebsite ?? 0,
          atc_offline: r.atcOffline ?? 0,
          atc_meta: r.atcMeta ?? 0,
          cost_per_add_to_cart: r.costPerAddToCart ?? null,
          ic_total: r.icTotal ?? 0,
          ic_app: r.icApp ?? 0,
          ic_website: r.icWebsite ?? 0,
          ic_offline: r.icOffline ?? 0,
          ic_meta: r.icMeta ?? 0,
          cost_per_initiate_checkout: r.costPerInitiateCheckout ?? null,
          purchases_total: r.purchasesTotal ?? 0,
          purchases_app: r.purchasesApp ?? 0,
          purchases_website: r.purchasesWebsite ?? 0,
          purchases_offline: r.purchasesOffline ?? 0,
          purchases_meta: r.purchasesMeta ?? 0,
          cost_per_purchase: r.costPerPurchase ?? null,
          purchase_value_total: r.purchaseValueTotal ?? 0,
          purchase_value_app: r.purchaseValueApp ?? 0,
          purchase_value_website: r.purchaseValueWebsite ?? 0,
          purchase_value_offline: r.purchaseValueOffline ?? 0,
          purchase_value_meta: r.purchaseValueMeta ?? 0,
          purchase_roas_total: r.purchaseRoasTotal ?? null,
          purchase_roas_website: r.purchaseRoasWebsite ?? null,
          purchase_roas_app: r.purchaseRoasApp ?? null,
          raw_actions_json: r.rawActionsJson ?? null,
          raw_action_values_json: r.rawActionValuesJson ?? null,
          raw_cost_per_action_type_json: r.rawCostPerActionTypeJson ?? null,
          raw_roas_json: r.rawRoasJson ?? null,
          fetched_at: now,
        });
      }
    });
    tx();
  },

  insertUsageSample(s) {
    insertUsageStmt.run({
      ts: s.ts ?? new Date().toISOString(),
      where_path: s.where ?? null,
      method: s.method ?? null,
      http_status: s.httpStatus ?? null,
      x_app_usage: s.xAppUsage ? JSON.stringify(s.xAppUsage) : null,
      x_business_use_case_usage: s.xBusinessUseCaseUsage ? JSON.stringify(s.xBusinessUseCaseUsage) : null,
      x_ad_account_usage: s.xAdAccountUsage ? JSON.stringify(s.xAdAccountUsage) : null,
      x_fb_ads_insights_throttle: s.xFbAdsInsightsThrottle ? JSON.stringify(s.xFbAdsInsightsThrottle) : null,
      app_max_pct: s.appMaxPct ?? null,
      buc_max_pct: s.bucMaxPct ?? null,
      insights_app_pct: s.insightsAppPct ?? null,
      insights_acc_pct: s.insightsAccPct ?? null,
      ads_api_access_tier: s.adsApiAccessTier ?? null,
    });
  },

  startRun(datePreset) {
    const res = insertRunStmt.run(new Date().toISOString(), datePreset);
    return res.lastInsertRowid;
  },

  finishRun(id, status, httpCalls, campaignsCount, errorMessage) {
    updateRunStmt.run(new Date().toISOString(), status, httpCalls, campaignsCount, errorMessage || null, id);
  },

  getDashboardData(accountId, datePreset) {
    return this.getLevelData(accountId, 'campaign', datePreset, {});
  },

  getLevelData(accountId, level, datePreset, { campaignId, adsetId } = {}) {
    const account = db.prepare('SELECT * FROM account WHERE id = ?').get(accountId);

    const insightsCols = `
      i.spend, i.reach, i.impressions, i.cpm, i.frequency,
      i.inline_link_clicks, i.unique_inline_link_clicks,
      i.unique_inline_link_click_ctr, i.cost_per_inline_link_click,
      i.post_comments, i.post_engagements, i.link_clicks,
      i.landing_page_views_total, i.landing_page_views_app, i.landing_page_views_website,
      i.cost_per_landing_page_view,
      i.atc_total, i.atc_app, i.atc_website, i.atc_offline, i.atc_meta, i.cost_per_add_to_cart,
      i.ic_total, i.ic_app, i.ic_website, i.ic_offline, i.ic_meta, i.cost_per_initiate_checkout,
      i.purchases_total, i.purchases_app, i.purchases_website, i.purchases_offline, i.purchases_meta, i.cost_per_purchase,
      i.purchase_value_total, i.purchase_value_app, i.purchase_value_website, i.purchase_value_offline, i.purchase_value_meta,
      i.purchase_roas_total, i.purchase_roas_website, i.purchase_roas_app,
      i.fetched_at AS insights_fetched_at
    `;

    let rows = [];
    if (level === 'campaign') {
      rows = db.prepare(`
        SELECT c.*, ${insightsCols}
        FROM campaigns c
        LEFT JOIN insights_snapshot i
          ON i.entity_id = c.id AND i.entity_level = 'campaign'
          AND i.account_id = c.account_id AND i.date_preset = ?
        WHERE c.account_id = ?
        ORDER BY (i.spend IS NULL) ASC, i.spend DESC NULLS LAST, c.name COLLATE NOCASE ASC
      `).all(datePreset, accountId);
    } else if (level === 'adset') {
      const filterClause = campaignId ? 'AND a.campaign_id = ?' : '';
      const params = campaignId ? [datePreset, accountId, campaignId] : [datePreset, accountId];
      rows = db.prepare(`
        SELECT a.id, a.account_id, a.campaign_id, a.name, a.status, a.effective_status,
               a.optimization_goal, a.billing_event, a.bid_strategy, a.bid_amount,
               a.daily_budget, a.lifetime_budget, a.targeting_summary,
               a.start_time, a.end_time, a.created_time, a.updated_time, a.last_synced_at,
               c.name AS campaign_name,
               ${insightsCols}
        FROM adsets a
        LEFT JOIN campaigns c ON c.id = a.campaign_id
        LEFT JOIN insights_snapshot i
          ON i.entity_id = a.id AND i.entity_level = 'adset'
          AND i.account_id = a.account_id AND i.date_preset = ?
        WHERE a.account_id = ? ${filterClause}
        ORDER BY (i.spend IS NULL) ASC, i.spend DESC NULLS LAST, a.name COLLATE NOCASE ASC
      `).all(...params);
    } else if (level === 'ad') {
      let filterClause = '';
      const params = [datePreset, accountId];
      if (adsetId) { filterClause = 'AND a.adset_id = ?'; params.push(adsetId); }
      else if (campaignId) { filterClause = 'AND a.campaign_id = ?'; params.push(campaignId); }
      rows = db.prepare(`
        SELECT a.id, a.account_id, a.campaign_id, a.adset_id, a.name, a.status, a.effective_status,
               a.creative_id, a.creative_thumb_url, a.creative_title, a.creative_body, a.creative_object_story_id,
               a.created_time, a.updated_time, a.last_synced_at,
               ase.name AS adset_name,
               c.name AS campaign_name,
               ${insightsCols}
        FROM ads a
        LEFT JOIN adsets ase ON ase.id = a.adset_id
        LEFT JOIN campaigns c ON c.id = a.campaign_id
        LEFT JOIN insights_snapshot i
          ON i.entity_id = a.id AND i.entity_level = 'ad'
          AND i.account_id = a.account_id AND i.date_preset = ?
        WHERE a.account_id = ? ${filterClause}
        ORDER BY (i.spend IS NULL) ASC, i.spend DESC NULLS LAST, a.name COLLATE NOCASE ASC
      `).all(...params);
    } else {
      throw new Error(`unknown level: ${level}`);
    }

    const lastRun = db.prepare('SELECT * FROM refresh_runs ORDER BY id DESC LIMIT 1').get();
    return { account, level, parentCampaignId: campaignId || null, parentAdsetId: adsetId || null, rows, lastRun };
  },

  setAdPostId(adId, postId) {
    const res = db.prepare('UPDATE ads SET creative_object_story_id = ? WHERE id = ?').run(postId, adId);
    return res.changes > 0;
  },

  upsertCommentsForAd(postId, adId, rows) {
    const now = new Date().toISOString();
    const tx = db.transaction((list) => {
      for (const r of list) {
        upsertCommentStmt.run({
          id: r.id,
          post_id: postId,
          ad_id: adId ?? null,
          parent_id: r.parentId ?? null,
          message: r.message ?? null,
          from_id: r.fromId ?? null,
          from_name: r.fromName ?? null,
          from_picture_url: r.fromPictureUrl ?? null,
          created_time: r.createdTime ?? null,
          like_count: r.likeCount ?? 0,
          comment_count: r.commentCount ?? 0,
          is_hidden: r.isHidden ? 1 : 0,
          can_hide: r.canHide ? 1 : 0,
          can_remove: r.canRemove ? 1 : 0,
          can_reply_privately: r.canReplyPrivately ? 1 : 0,
          user_likes: r.userLikes ? 1 : 0,
          permalink_url: r.permalinkUrl ?? null,
          attachment_type: r.attachmentType ?? null,
          attachment_url: r.attachmentUrl ?? null,
          attachment_json: r.attachmentJson ?? null,
          has_url: r.hasUrl ? 1 : 0,
          my_reply_id: r.myReplyId ?? null,
          flagged: r.flagged ? 1 : 0,
          flag_reasons: r.flagReasons ? JSON.stringify(r.flagReasons) : null,
          fetched_at: now,
        });
      }
    });
    tx(rows);
    return rows.length;
  },

  getCommentsByPost(postId) {
    return db.prepare('SELECT * FROM comments WHERE post_id = ? AND deleted = 0 ORDER BY created_time DESC').all(postId);
  },

  getCommentById(id) {
    return db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  },

  setCommentHidden(id, hidden) {
    db.prepare('UPDATE comments SET is_hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
  },

  markCommentDeleted(id) {
    db.prepare('UPDATE comments SET deleted = 1 WHERE id = ?').run(id);
  },

  getCampaignName(id) {
    const row = db.prepare('SELECT name FROM campaigns WHERE id = ?').get(id);
    return row?.name ?? null;
  },
  getAdsetName(id) {
    const row = db.prepare('SELECT id, name, campaign_id FROM adsets WHERE id = ?').get(id);
    return row ?? null;
  },

  getEntity(level, id) {
    const table = level === 'campaign' ? 'campaigns' : level === 'adset' ? 'adsets' : level === 'ad' ? 'ads' : null;
    if (!table) return null;
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
  },

  setEntityStatus(level, id, status) {
    const table = level === 'campaign' ? 'campaigns' : level === 'adset' ? 'adsets' : level === 'ad' ? 'ads' : null;
    if (!table) return 0;
    return db.prepare(`UPDATE ${table} SET status = ?, effective_status = ?, updated_time = datetime('now') WHERE id = ?`).run(status, status, id).changes;
  },

  setEntityName(level, id, name) {
    const table = level === 'campaign' ? 'campaigns' : level === 'adset' ? 'adsets' : level === 'ad' ? 'ads' : null;
    if (!table) return 0;
    return db.prepare(`UPDATE ${table} SET name = ?, updated_time = datetime('now') WHERE id = ?`).run(name, id).changes;
  },

  setEntityBudget(level, id, { daily_budget = undefined, lifetime_budget = undefined } = {}) {
    const table = level === 'campaign' ? 'campaigns' : level === 'adset' ? 'adsets' : null;
    if (!table) return 0;
    const sets = [];
    const params = [];
    if (daily_budget !== undefined) { sets.push('daily_budget = ?'); params.push(daily_budget); }
    if (lifetime_budget !== undefined) { sets.push('lifetime_budget = ?'); params.push(lifetime_budget); }
    if (!sets.length) return 0;
    params.push(id);
    return db.prepare(`UPDATE ${table} SET ${sets.join(', ')}, updated_time = datetime('now') WHERE id = ?`).run(...params).changes;
  },

  logAdAction(entry) {
    return db.prepare(`
      INSERT INTO ad_actions (action, level, entity_id, entity_name, before_value, after_value, payload_json, response_json, success, error_message)
      VALUES (@action, @level, @entity_id, @entity_name, @before_value, @after_value, @payload_json, @response_json, @success, @error_message)
    `).run({
      action: entry.action,
      level: entry.level ?? null,
      entity_id: entry.entity_id ?? null,
      entity_name: entry.entity_name ?? null,
      before_value: entry.before_value ?? null,
      after_value: entry.after_value ?? null,
      payload_json: entry.payload_json ? JSON.stringify(entry.payload_json) : null,
      response_json: entry.response_json ? JSON.stringify(entry.response_json) : null,
      success: entry.success ? 1 : 0,
      error_message: entry.error_message ?? null,
    }).lastInsertRowid;
  },

  getAdActions(limit = 100) {
    return db.prepare('SELECT * FROM ad_actions ORDER BY id DESC LIMIT ?').all(limit);
  },

  logStrategyChat(entry) {
    return db.prepare(`
      INSERT INTO strategy_chat (session_id, role, content, model, window, elapsed_ms, error_message)
      VALUES (@session_id, @role, @content, @model, @window, @elapsed_ms, @error_message)
    `).run({
      session_id: entry.session_id ?? null,
      role: entry.role,
      content: String(entry.content ?? ''),
      model: entry.model ?? null,
      window: entry.window ?? null,
      elapsed_ms: entry.elapsed_ms ?? null,
      error_message: entry.error_message ?? null,
    }).lastInsertRowid;
  },

  getStrategyChat(limit = 100) {
    return db.prepare('SELECT * FROM strategy_chat ORDER BY id DESC LIMIT ?').all(limit);
  },

  countRecentAdActions(action, entityId, sinceIso) {
    const row = db.prepare(
      "SELECT COUNT(*) AS n FROM ad_actions WHERE action = ? AND entity_id = ? AND success = 1 AND created_at >= ?",
    ).get(action, entityId, sinceIso);
    return row?.n ?? 0;
  },

  getRecentUsage(limit = 100) {
    return db.prepare(`
      SELECT id, ts, where_path, method, http_status,
             app_max_pct, buc_max_pct, insights_app_pct, insights_acc_pct, ads_api_access_tier
      FROM usage_samples
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
  },

  getLatestUsageWithFullHeaders() {
    return db.prepare(`
      SELECT id, ts, where_path, method, http_status,
             x_app_usage, x_business_use_case_usage, x_ad_account_usage, x_fb_ads_insights_throttle,
             app_max_pct, buc_max_pct, insights_app_pct, insights_acc_pct, ads_api_access_tier
      FROM usage_samples
      WHERE x_business_use_case_usage IS NOT NULL OR x_app_usage IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `).get();
  },

  getLatestNonNullHeader(column) {
    const safe = ['x_app_usage', 'x_business_use_case_usage', 'x_ad_account_usage', 'x_fb_ads_insights_throttle'];
    if (!safe.includes(column)) throw new Error(`unsafe column: ${column}`);
    return db.prepare(`
      SELECT id, ts, where_path, method, http_status, ${column} AS value
      FROM usage_samples
      WHERE ${column} IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `).get();
  },

  getDailyCallCount(day) {
    const row = db.prepare('SELECT calls FROM daily_call_counter WHERE day = ?').get(day);
    return row ? row.calls : 0;
  },

  incrementDailyCallCount(day) {
    db.prepare(`
      INSERT INTO daily_call_counter (day, calls) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET calls = calls + 1
    `).run(day);
  },

  setCooldown(endpoint, untilIso, reason, consecutiveErrors) {
    db.prepare(`
      INSERT INTO endpoint_cooldowns (endpoint, cooldown_until, reason, consecutive_errors)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        cooldown_until = excluded.cooldown_until,
        reason = excluded.reason,
        consecutive_errors = excluded.consecutive_errors
    `).run(endpoint, untilIso, reason, consecutiveErrors);
  },

  clearCooldown(endpoint) {
    db.prepare('DELETE FROM endpoint_cooldowns WHERE endpoint = ?').run(endpoint);
  },

  getCooldown(endpoint) {
    return db.prepare('SELECT * FROM endpoint_cooldowns WHERE endpoint = ?').get(endpoint);
  },

  getAllCooldowns() {
    return db.prepare('SELECT * FROM endpoint_cooldowns ORDER BY cooldown_until DESC').all();
  },

  // ---------- Comments Manager: ad_posts catalog ----------

  getAdsWithPostId() {
    return db.prepare(`
      SELECT a.id AS ad_id, a.name AS ad_name, a.effective_status, a.status,
             a.campaign_id, a.adset_id, a.creative_object_story_id AS post_id,
             a.creative_thumb_url, a.created_time,
             c.name AS campaign_name, ase.name AS adset_name
      FROM ads a
      LEFT JOIN campaigns c ON c.id = a.campaign_id
      LEFT JOIN adsets ase ON ase.id = a.adset_id
      WHERE a.creative_object_story_id IS NOT NULL AND a.creative_object_story_id <> ''
      ORDER BY (a.effective_status = 'ACTIVE') DESC, a.created_time DESC NULLS LAST
    `).all();
  },

  upsertAdPost(p) {
    upsertAdPostStmt.run({
      id: p.id,
      page_id: p.pageId ?? null,
      ad_id: p.adId ?? null,
      ad_name: p.adName ?? null,
      campaign_id: p.campaignId ?? null,
      campaign_name: p.campaignName ?? null,
      adset_id: p.adsetId ?? null,
      adset_name: p.adsetName ?? null,
      effective_status: p.effectiveStatus ?? null,
      message: p.message ?? null,
      full_picture_url: p.fullPictureUrl ?? null,
      permalink_url: p.permalinkUrl ?? null,
      created_time: p.createdTime ?? null,
      is_dark_post: p.isDarkPost ? 1 : 0,
      last_synced_at: new Date().toISOString(),
    });
  },

  getAdPost(postId) {
    return db.prepare('SELECT * FROM ad_posts WHERE id = ?').get(postId) ?? null;
  },

  // Remove catalog rows for posts not owned by our page (unreadable with the page token).
  // object_story_id is "{pageId}_{postId}", so anything without that prefix is foreign.
  pruneForeignPosts(pageId) {
    if (!pageId) return 0;
    return db.prepare("DELETE FROM ad_posts WHERE id NOT LIKE ? ESCAPE '\\'").run(`${pageId}\\_%`).changes;
  },

  setPostCommentSyncedAt(postId, iso) {
    db.prepare('UPDATE ad_posts SET last_comment_synced_at = ? WHERE id = ?').run(iso || new Date().toISOString(), postId);
  },

  getLastCommentSyncAt() {
    const row = db.prepare('SELECT MAX(last_comment_synced_at) AS ts FROM ad_posts').get();
    return row?.ts ?? null;
  },

  setKv(key, value) {
    db.prepare(`INSERT INTO safety_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value == null ? null : String(value));
  },

  getKv(key) {
    return db.prepare('SELECT value FROM safety_state WHERE key = ?').get(key)?.value ?? null;
  },

  markSyncStarted() {
    const ts = db.prepare("SELECT datetime('now') AS ts").get().ts;
    this.setKv('cm_last_sync_started', ts);
    return ts;
  },

  getReviewSince() {
    return this.getKv('cm_last_sync_started');
  },

  getNewSinceLastSync() {
    const since = this.getReviewSince();
    if (!since) return 0;
    return db.prepare('SELECT COUNT(*) AS n FROM comments WHERE deleted = 0 AND first_seen_at >= ?').get(since)?.n || 0;
  },

  getPostCatalog() {
    return db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted = 0) AS total,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted = 0 AND c.is_hidden = 1) AS hidden,
        (SELECT COUNT(*) FROM comments c LEFT JOIN comment_analyses a ON a.comment_id = c.id
           WHERE c.post_id = p.id AND c.deleted = 0 AND c.is_hidden = 0 AND a.recommended_action = 'delete') AS suggest_delete,
        (SELECT COUNT(*) FROM comments c LEFT JOIN comment_analyses a ON a.comment_id = c.id
           WHERE c.post_id = p.id AND c.deleted = 0 AND c.is_hidden = 0 AND a.comment_id IS NULL) AS unanalyzed,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted = 0 AND c.is_hidden = 0 AND c.my_reply_id IS NULL) AS needs_reply
      FROM ad_posts p
      ORDER BY (p.effective_status = 'ACTIVE') DESC, total DESC, p.created_time DESC NULLS LAST
    `).all();
  },

  listPostsNeedingAnalysis({ force = false } = {}) {
    if (force) return db.prepare('SELECT * FROM ad_posts ORDER BY created_time DESC NULLS LAST').all();
    return db.prepare('SELECT * FROM ad_posts WHERE ai_analyzed_at IS NULL OR ai_summary IS NULL').all();
  },

  savePostAnalysis(postId, analysis, model) {
    db.prepare(`
      UPDATE ad_posts SET
        ai_summary=?, ai_ad_type=?, ai_category=?, ai_severity=?, ai_explanation=?, ai_model=?, ai_analyzed_at=datetime('now')
      WHERE id=?
    `).run(analysis.summary, analysis.ad_type, analysis.category, analysis.severity, analysis.explanation, model, postId);
  },

  // ---------- Comments Manager: comment analyses ----------

  upsertAnalysis(commentId, analysis, model) {
    upsertAnalysisStmt.run({
      comment_id: commentId,
      category: analysis.category,
      severity: analysis.severity ?? 0,
      english_translation: analysis.english_translation ?? null,
      explanation: analysis.explanation ?? null,
      recommended_action: analysis.recommended_action || 'review',
      action_reason: analysis.action_reason ?? null,
      model: model ?? null,
    });
  },

  deleteAnalysesForPost(postId) {
    return db.prepare(`DELETE FROM comment_analyses WHERE comment_id IN (SELECT id FROM comments WHERE post_id = ?)`).run(postId).changes;
  },

  getUnanalyzedComments(postId, limit = 500) {
    return db.prepare(`
      SELECT c.* FROM comments c
      LEFT JOIN comment_analyses a ON a.comment_id = c.id
      WHERE c.post_id = ? AND c.deleted = 0 AND a.comment_id IS NULL
      ORDER BY c.created_time DESC LIMIT ?
    `).all(postId, limit);
  },

  listAllCommentsForPost(postId) {
    return db.prepare('SELECT * FROM comments WHERE post_id = ? AND deleted = 0 ORDER BY created_time ASC').all(postId);
  },

  reconcileDeletedComments(postId, presentIds) {
    const present = new Set(presentIds);
    const local = db.prepare('SELECT id FROM comments WHERE post_id = ? AND deleted = 0').all(postId);
    const toDelete = local.map((r) => r.id).filter((id) => !present.has(id));
    if (!toDelete.length) return 0;
    const stmt = db.prepare('UPDATE comments SET deleted = 1 WHERE id = ?');
    const tx = db.transaction((ids) => { for (const id of ids) stmt.run(id); });
    tx(toDelete);
    return toDelete.length;
  },

  // ---------- Comments Manager: inbox + summary ----------

  getCommentWithAnalysis(commentId) {
    return db.prepare(`
      SELECT c.*, p.ad_name AS post_ad_name, p.campaign_name AS post_campaign_name,
             p.ai_summary AS post_ai_summary, p.ai_ad_type AS post_ai_ad_type, p.message AS post_message,
             p.full_picture_url AS post_picture, p.permalink_url AS post_permalink,
             a.category AS ai_category, a.severity AS ai_severity, a.english_translation AS ai_translation,
             a.explanation AS ai_explanation, a.recommended_action AS ai_recommended_action,
             a.action_reason AS ai_action_reason, a.model AS ai_model,
             pc.from_name AS parent_from_name, pc.message AS parent_message, pc.deleted AS parent_deleted
      FROM comments c
      LEFT JOIN ad_posts p ON p.id = c.post_id
      LEFT JOIN comment_analyses a ON a.comment_id = c.id
      LEFT JOIN comments pc ON pc.id = c.parent_id
      WHERE c.id = ?
    `).get(commentId) ?? null;
  },

  getInboxComments({ filter = 'all', sort = 'severity_desc', postId = null, minSev = 0, q = '', since = null, createdSince = null, limit = 100, offset = 0 } = {}) {
    const clauses = ['c.deleted = 0'];
    const params = [];
    const filterClause = CM_INBOX_FILTERS[filter] !== undefined ? CM_INBOX_FILTERS[filter] : CM_INBOX_FILTERS.all;
    if (filterClause) clauses.push(filterClause);
    if (postId) { clauses.push('c.post_id = ?'); params.push(postId); }
    if (minSev > 0) { clauses.push('COALESCE(a.severity, -1) >= ?'); params.push(minSev); }
    if (since) { clauses.push('c.first_seen_at >= ?'); params.push(since); }
    if (createdSince) { clauses.push('substr(c.created_time, 1, 19) >= ?'); params.push(createdSince); }
    if (q) { clauses.push('(c.message LIKE ? OR c.from_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const orderBy = CM_INBOX_SORTS[sort] ? CM_INBOX_SORTS[sort] : CM_INBOX_SORTS.severity_desc;
    const lim = Math.min(500, Math.max(1, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    const rows = db.prepare(`
      SELECT c.id, c.post_id, c.ad_id, c.parent_id, c.message, c.from_id, c.from_name, c.from_picture_url,
             c.created_time, c.like_count, c.comment_count, c.is_hidden, c.can_hide, c.can_remove,
             c.user_likes, c.permalink_url, c.has_url, c.my_reply_id, c.flagged, c.flag_reasons,
             c.attachment_type, c.attachment_url,
             p.ad_name AS post_ad_name, p.campaign_name AS post_campaign_name, p.full_picture_url AS post_picture,
             a.category AS ai_category, a.severity AS ai_severity, a.english_translation AS ai_translation,
             a.explanation AS ai_explanation, a.recommended_action AS ai_recommended_action, a.action_reason AS ai_action_reason,
             pc.from_name AS parent_from_name, pc.message AS parent_message, pc.deleted AS parent_deleted
      FROM comments c
      LEFT JOIN ad_posts p ON p.id = c.post_id
      LEFT JOIN comment_analyses a ON a.comment_id = c.id
      LEFT JOIN comments pc ON pc.id = c.parent_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${lim} OFFSET ${off}
    `).all(...params);
    const total = db.prepare(`
      SELECT COUNT(*) AS n FROM comments c
      LEFT JOIN comment_analyses a ON a.comment_id = c.id
      ${where}
    `).get(...params).n;
    return { rows, total, limit: lim, offset: off };
  },

  getCmSummary(postId = null) {
    const where = postId ? 'WHERE c.deleted = 0 AND c.post_id = ?' : 'WHERE c.deleted = 0';
    const args = postId ? [postId] : [];
    return db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN c.is_hidden = 0 THEN 1 ELSE 0 END) AS visible,
        SUM(CASE WHEN c.is_hidden = 1 THEN 1 ELSE 0 END) AS hidden,
        SUM(CASE WHEN c.has_url = 1 AND c.is_hidden = 0 THEN 1 ELSE 0 END) AS has_url,
        SUM(CASE WHEN c.my_reply_id IS NULL AND c.is_hidden = 0 THEN 1 ELSE 0 END) AS needs_reply,
        SUM(CASE WHEN a.recommended_action = 'delete' AND c.is_hidden = 0 THEN 1 ELSE 0 END) AS suggest_delete,
        SUM(CASE WHEN a.category IN ('hate','harassment','threat','scam_accusation','ai_accusation','fake_accusation','spam') AND c.is_hidden = 0 THEN 1 ELSE 0 END) AS flagged,
        SUM(CASE WHEN a.comment_id IS NULL AND c.is_hidden = 0 THEN 1 ELSE 0 END) AS unanalyzed,
        SUM(CASE WHEN COALESCE(a.severity, -1) >= 8 AND c.is_hidden = 0 THEN 1 ELSE 0 END) AS sev_high
      FROM comments c
      LEFT JOIN comment_analyses a ON a.comment_id = c.id
      ${where}
    `).get(...args);
  },

  getNewSinceCounts(lastVisits = {}) {
    const counts = {};
    const stmt = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ? AND deleted = 0 AND is_hidden = 0 AND created_time > ?');
    for (const [postId, since] of Object.entries(lastVisits)) {
      if (typeof since !== 'string') { counts[postId] = 0; continue; }
      try { counts[postId] = stmt.get(postId, since)?.n || 0; } catch { counts[postId] = 0; }
    }
    return counts;
  },

  setCommentReplyId(commentId, replyId) {
    db.prepare('UPDATE comments SET my_reply_id = ?, comment_count = comment_count + 1 WHERE id = ?').run(replyId, commentId);
  },

  setCommentUserLikes(commentId, liked) {
    if (liked) db.prepare('UPDATE comments SET user_likes = 1, like_count = like_count + 1 WHERE id = ? AND user_likes = 0').run(commentId);
    else db.prepare('UPDATE comments SET user_likes = 0, like_count = MAX(0, like_count - 1) WHERE id = ? AND user_likes = 1').run(commentId);
  },

  // ---------- Comments Manager: auto-mod rules ----------

  listRules({ enabledOnly = false } = {}) {
    const where = enabledOnly ? 'WHERE is_enabled = 1' : '';
    return db.prepare(`SELECT * FROM auto_mod_rules ${where} ORDER BY id DESC`).all();
  },
  createRule({ name, pattern, match_type, case_sensitive = 0, is_enabled = 1 }) {
    const info = db.prepare(`
      INSERT INTO auto_mod_rules (name, pattern, match_type, action, case_sensitive, is_enabled)
      VALUES (?, ?, ?, 'hide', ?, ?)
    `).run(name, pattern, match_type, case_sensitive ? 1 : 0, is_enabled ? 1 : 0);
    return info.lastInsertRowid;
  },
  updateRule(id, fields) {
    const allowed = ['name', 'pattern', 'match_type', 'case_sensitive', 'is_enabled'];
    const sets = [];
    const args = [];
    for (const k of allowed) {
      if (k in fields) { sets.push(`${k} = ?`); args.push(typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]); }
    }
    if (!sets.length) return 0;
    args.push(id);
    return db.prepare(`UPDATE auto_mod_rules SET ${sets.join(', ')} WHERE id = ?`).run(...args).changes;
  },
  deleteRule(id) {
    return db.prepare('DELETE FROM auto_mod_rules WHERE id = ?').run(id).changes;
  },
  bumpRuleHit(id, n = 1) {
    db.prepare('UPDATE auto_mod_rules SET hit_count = hit_count + ? WHERE id = ?').run(n, id);
  },

  // ---------- Comments Manager: moderation log ----------

  logModeration(entry) {
    insertModLogStmt.run({
      action: entry.action,
      comment_id: entry.commentId ?? null,
      post_id: entry.postId ?? null,
      commenter_psid: entry.commenterPsid ?? null,
      commenter_name: entry.commenterName ?? null,
      message_preview: entry.messagePreview ? String(entry.messagePreview).slice(0, 200) : null,
      payload_json: entry.payload ? JSON.stringify(entry.payload) : null,
      response_json: entry.response ? JSON.stringify(entry.response).slice(0, 2000) : null,
      success: entry.success ? 1 : 0,
      error_message: entry.errorMessage ?? null,
    });
  },
  getModLog(limit = 100) {
    return db.prepare('SELECT * FROM moderation_log ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, Number(limit) || 100)));
  },

  // ---------- Comments Manager: blocked users ----------

  upsertBlocked({ psid, name = null, reason = null }) {
    db.prepare(`
      INSERT INTO blocked_users (psid, name, blocked_at, reason)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(psid) DO UPDATE SET
        name = COALESCE(excluded.name, blocked_users.name),
        blocked_at = excluded.blocked_at,
        unblocked_at = NULL,
        reason = COALESCE(excluded.reason, blocked_users.reason)
    `).run(psid, name, reason);
  },
  markUnblocked(psid) {
    db.prepare(`UPDATE blocked_users SET unblocked_at = datetime('now') WHERE psid = ?`).run(psid);
  },
  getBlocked() {
    return db.prepare('SELECT * FROM blocked_users ORDER BY (unblocked_at IS NULL) DESC, blocked_at DESC').all();
  },
};
