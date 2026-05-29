"""SQLite persistence for the dashboard.

Single .db file at data/dashboard.db. Tables:

  - accounts          one row per ad account
  - campaigns         one row per campaign, references account
  - adsets            one row per ad set, references campaign
  - ads               one row per ad, references ad set
  - insights          time-series of metrics at any granularity (entity_type)
  - insights_brk      breakdown rows (placement/age-gender/device/country/...)
  - usage_samples     rate-limit headers captured across every API response
  - change_log        audit trail of writes we will eventually make
  - sync_runs         metadata for each sync invocation (started_at, ended_at, ...)

Writes are upserts keyed on natural ids so re-running the sync is idempotent.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT,
    currency TEXT,
    timezone_name TEXT,
    account_status INTEGER,
    disable_reason INTEGER,
    business_id TEXT,
    business_name TEXT,
    amount_spent REAL,
    balance REAL,
    spend_cap REAL,
    age REAL,
    capabilities TEXT,
    raw TEXT,
    last_synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT,
    objective TEXT,
    buying_type TEXT,
    status TEXT,
    effective_status TEXT,
    configured_status TEXT,
    daily_budget REAL,
    lifetime_budget REAL,
    budget_remaining REAL,
    bid_strategy TEXT,
    special_ad_categories TEXT,
    start_time TEXT,
    stop_time TEXT,
    created_time TEXT,
    updated_time TEXT,
    raw TEXT,
    last_synced_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS ix_campaigns_account ON campaigns(account_id);

CREATE TABLE IF NOT EXISTS adsets (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    name TEXT,
    status TEXT,
    effective_status TEXT,
    configured_status TEXT,
    optimization_goal TEXT,
    billing_event TEXT,
    bid_amount REAL,
    bid_strategy TEXT,
    daily_budget REAL,
    lifetime_budget REAL,
    start_time TEXT,
    end_time TEXT,
    created_time TEXT,
    updated_time TEXT,
    targeting TEXT,
    promoted_object TEXT,
    attribution_spec TEXT,
    destination_type TEXT,
    raw TEXT,
    last_synced_at TEXT NOT NULL,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);
CREATE INDEX IF NOT EXISTS ix_adsets_campaign ON adsets(campaign_id);
CREATE INDEX IF NOT EXISTS ix_adsets_account ON adsets(account_id);
CREATE INDEX IF NOT EXISTS ix_adsets_effective_status ON adsets(effective_status);

CREATE TABLE IF NOT EXISTS ads (
    id TEXT PRIMARY KEY,
    adset_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    name TEXT,
    status TEXT,
    effective_status TEXT,
    creative_id TEXT,
    creative_object_story_id TEXT,
    creative_effective_object_story_id TEXT,
    creative_thumbnail_url TEXT,
    created_time TEXT,
    updated_time TEXT,
    issues_info TEXT,
    raw TEXT,
    last_synced_at TEXT NOT NULL,
    FOREIGN KEY (adset_id) REFERENCES adsets(id)
);
CREATE INDEX IF NOT EXISTS ix_ads_adset ON ads(adset_id);
CREATE INDEX IF NOT EXISTS ix_ads_campaign ON ads(campaign_id);
CREATE INDEX IF NOT EXISTS ix_ads_account ON ads(account_id);

CREATE TABLE IF NOT EXISTS insights (
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    date_start TEXT NOT NULL,
    date_stop TEXT NOT NULL,
    account_id TEXT NOT NULL,
    spend REAL,
    impressions INTEGER,
    clicks INTEGER,
    reach INTEGER,
    frequency REAL,
    ctr REAL,
    cpc REAL,
    cpm REAL,
    cpp REAL,
    purchase_roas REAL,
    website_purchase_roas REAL,
    actions TEXT,
    action_values TEXT,
    cost_per_action_type TEXT,
    raw TEXT,
    last_synced_at TEXT NOT NULL,
    PRIMARY KEY (entity_id, entity_type, date_start, date_stop)
);
CREATE INDEX IF NOT EXISTS ix_insights_account_date ON insights(account_id, date_start);
CREATE INDEX IF NOT EXISTS ix_insights_entity ON insights(entity_type, entity_id, date_start);

CREATE TABLE IF NOT EXISTS insights_brk (
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    breakdown_type TEXT NOT NULL,
    breakdown_key TEXT NOT NULL,
    date_start TEXT NOT NULL,
    date_stop TEXT NOT NULL,
    account_id TEXT NOT NULL,
    spend REAL,
    impressions INTEGER,
    clicks INTEGER,
    actions TEXT,
    raw TEXT,
    last_synced_at TEXT NOT NULL,
    PRIMARY KEY (entity_id, entity_type, breakdown_type, breakdown_key, date_start, date_stop)
);
CREATE INDEX IF NOT EXISTS ix_brk_account_date ON insights_brk(account_id, breakdown_type, date_start);

CREATE TABLE IF NOT EXISTS usage_samples (
    ts TEXT NOT NULL,
    where_str TEXT NOT NULL,
    app_call_count REAL,
    app_total_time REAL,
    app_total_cputime REAL,
    buc TEXT,
    ad_account_usage TEXT,
    page_usage TEXT,
    ads_api_access_tier TEXT,
    raw TEXT
);
CREATE INDEX IF NOT EXISTS ix_usage_ts ON usage_samples(ts);

CREATE TABLE IF NOT EXISTS change_log (
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    source TEXT,
    request_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_change_log_ts ON change_log(ts);
CREATE INDEX IF NOT EXISTS ix_change_log_entity ON change_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    accounts_touched INTEGER DEFAULT 0,
    campaigns_touched INTEGER DEFAULT 0,
    adsets_touched INTEGER DEFAULT 0,
    ads_touched INTEGER DEFAULT 0,
    insights_rows INTEGER DEFAULT 0,
    breakdown_rows INTEGER DEFAULT 0,
    http_requests INTEGER DEFAULT 0,
    errors TEXT,
    status TEXT
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _j(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False, default=str)


def _f(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _i(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


class Store:
    def __init__(self, db_path: Path):
        self.path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    @contextmanager
    def tx(self):
        try:
            yield self.conn
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def upsert_account(self, acct: dict) -> None:
        business = acct.get("business") or {}
        cols = {
            "id": acct.get("id"),
            "name": acct.get("name"),
            "currency": acct.get("currency"),
            "timezone_name": acct.get("timezone_name"),
            "account_status": _i(acct.get("account_status")),
            "disable_reason": _i(acct.get("disable_reason")),
            "business_id": business.get("id"),
            "business_name": business.get("name"),
            "amount_spent": _f(acct.get("amount_spent")),
            "balance": _f(acct.get("balance")),
            "spend_cap": _f(acct.get("spend_cap")),
            "age": _f(acct.get("age")),
            "capabilities": _j(acct.get("capabilities")),
            "raw": _j(acct),
            "last_synced_at": _now(),
        }
        self._upsert("accounts", cols, "id")

    def upsert_campaign(self, account_id: str, c: dict) -> None:
        cols = {
            "id": c.get("id"),
            "account_id": account_id,
            "name": c.get("name"),
            "objective": c.get("objective"),
            "buying_type": c.get("buying_type"),
            "status": c.get("status"),
            "effective_status": c.get("effective_status"),
            "configured_status": c.get("configured_status"),
            "daily_budget": _f(c.get("daily_budget")),
            "lifetime_budget": _f(c.get("lifetime_budget")),
            "budget_remaining": _f(c.get("budget_remaining")),
            "bid_strategy": c.get("bid_strategy"),
            "special_ad_categories": _j(c.get("special_ad_categories")),
            "start_time": c.get("start_time"),
            "stop_time": c.get("stop_time"),
            "created_time": c.get("created_time"),
            "updated_time": c.get("updated_time"),
            "raw": _j(c),
            "last_synced_at": _now(),
        }
        self._upsert("campaigns", cols, "id")

    def upsert_adset(self, account_id: str, a: dict) -> None:
        campaign_id = (a.get("campaign") or {}).get("id") or a.get("campaign_id")
        cols = {
            "id": a.get("id"),
            "campaign_id": campaign_id,
            "account_id": account_id,
            "name": a.get("name"),
            "status": a.get("status"),
            "effective_status": a.get("effective_status"),
            "configured_status": a.get("configured_status"),
            "optimization_goal": a.get("optimization_goal"),
            "billing_event": a.get("billing_event"),
            "bid_amount": _f(a.get("bid_amount")),
            "bid_strategy": a.get("bid_strategy"),
            "daily_budget": _f(a.get("daily_budget")),
            "lifetime_budget": _f(a.get("lifetime_budget")),
            "start_time": a.get("start_time"),
            "end_time": a.get("end_time"),
            "created_time": a.get("created_time"),
            "updated_time": a.get("updated_time"),
            "targeting": _j(a.get("targeting")),
            "promoted_object": _j(a.get("promoted_object")),
            "attribution_spec": _j(a.get("attribution_spec")),
            "destination_type": a.get("destination_type"),
            "raw": _j(a),
            "last_synced_at": _now(),
        }
        self._upsert("adsets", cols, "id")

    def upsert_ad(self, account_id: str, ad: dict) -> None:
        adset = ad.get("adset") or {}
        campaign = ad.get("campaign") or {}
        creative = ad.get("creative") or {}
        cols = {
            "id": ad.get("id"),
            "adset_id": adset.get("id") or ad.get("adset_id"),
            "campaign_id": campaign.get("id") or ad.get("campaign_id"),
            "account_id": account_id,
            "name": ad.get("name"),
            "status": ad.get("status"),
            "effective_status": ad.get("effective_status"),
            "creative_id": creative.get("id"),
            "creative_object_story_id": creative.get("object_story_id"),
            "creative_effective_object_story_id": creative.get("effective_object_story_id"),
            "creative_thumbnail_url": creative.get("thumbnail_url"),
            "created_time": ad.get("created_time"),
            "updated_time": ad.get("updated_time"),
            "issues_info": _j(ad.get("issues_info")),
            "raw": _j(ad),
            "last_synced_at": _now(),
        }
        self._upsert("ads", cols, "id")

    def upsert_insights(self, entity_id: str, entity_type: str, account_id: str, row: dict) -> None:
        cols = {
            "entity_id": entity_id,
            "entity_type": entity_type,
            "date_start": row.get("date_start"),
            "date_stop": row.get("date_stop"),
            "account_id": account_id,
            "spend": _f(row.get("spend")),
            "impressions": _i(row.get("impressions")),
            "clicks": _i(row.get("clicks")),
            "reach": _i(row.get("reach")),
            "frequency": _f(row.get("frequency")),
            "ctr": _f(row.get("ctr")),
            "cpc": _f(row.get("cpc")),
            "cpm": _f(row.get("cpm")),
            "cpp": _f(row.get("cpp")),
            "purchase_roas": _f(_first_value(row.get("purchase_roas"))),
            "website_purchase_roas": _f(_first_value(row.get("website_purchase_roas"))),
            "actions": _j(row.get("actions")),
            "action_values": _j(row.get("action_values")),
            "cost_per_action_type": _j(row.get("cost_per_action_type")),
            "raw": _j(row),
            "last_synced_at": _now(),
        }
        self._upsert("insights", cols, ("entity_id", "entity_type", "date_start", "date_stop"))

    def upsert_brk(
        self,
        *,
        entity_id: str,
        entity_type: str,
        breakdown_type: str,
        breakdown_key: str,
        account_id: str,
        row: dict,
    ) -> None:
        cols = {
            "entity_id": entity_id,
            "entity_type": entity_type,
            "breakdown_type": breakdown_type,
            "breakdown_key": breakdown_key,
            "date_start": row.get("date_start"),
            "date_stop": row.get("date_stop"),
            "account_id": account_id,
            "spend": _f(row.get("spend")),
            "impressions": _i(row.get("impressions")),
            "clicks": _i(row.get("clicks")),
            "actions": _j(row.get("actions")),
            "raw": _j(row),
            "last_synced_at": _now(),
        }
        self._upsert(
            "insights_brk",
            cols,
            ("entity_id", "entity_type", "breakdown_type", "breakdown_key", "date_start", "date_stop"),
        )

    def insert_usage_sample(self, sample: dict, ads_api_access_tier: str | None = None) -> None:
        app = sample.get("app") or {}
        with self.tx() as c:
            c.execute(
                "INSERT INTO usage_samples (ts, where_str, app_call_count, app_total_time, app_total_cputime, "
                "buc, ad_account_usage, page_usage, ads_api_access_tier, raw) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    sample.get("ts"),
                    sample.get("where"),
                    _f(app.get("call_count")) if isinstance(app, dict) else None,
                    _f(app.get("total_time")) if isinstance(app, dict) else None,
                    _f(app.get("total_cputime")) if isinstance(app, dict) else None,
                    _j(sample.get("business_use_case")),
                    _j(sample.get("ad_account_usage")),
                    _j(sample.get("page_usage")),
                    ads_api_access_tier,
                    _j(sample),
                ),
            )

    def start_sync_run(self) -> int:
        with self.tx() as c:
            cur = c.execute(
                "INSERT INTO sync_runs (started_at, status) VALUES (?, ?)",
                (_now(), "running"),
            )
            return int(cur.lastrowid)

    def finish_sync_run(self, run_id: int, counters: dict, errors: list[dict] | None, status: str) -> None:
        with self.tx() as c:
            c.execute(
                "UPDATE sync_runs SET ended_at=?, accounts_touched=?, campaigns_touched=?, adsets_touched=?, "
                "ads_touched=?, insights_rows=?, breakdown_rows=?, http_requests=?, errors=?, status=? WHERE id=?",
                (
                    _now(),
                    counters.get("accounts", 0),
                    counters.get("campaigns", 0),
                    counters.get("adsets", 0),
                    counters.get("ads", 0),
                    counters.get("insights", 0),
                    counters.get("breakdowns", 0),
                    counters.get("http_requests", 0),
                    _j(errors) if errors else None,
                    status,
                    run_id,
                ),
            )

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        return list(self.conn.execute(sql, tuple(params)))

    def _upsert(self, table: str, cols: dict[str, Any], pk: str | tuple[str, ...]) -> None:
        keys = list(cols.keys())
        placeholders = ", ".join("?" * len(keys))
        col_list = ", ".join(keys)
        pk_cols = (pk,) if isinstance(pk, str) else pk
        update_set = ", ".join(f"{k}=excluded.{k}" for k in keys if k not in pk_cols)
        sql = (
            f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) "
            f"ON CONFLICT({', '.join(pk_cols)}) DO UPDATE SET {update_set}"
        )
        with self.tx() as c:
            c.execute(sql, [cols[k] for k in keys])


def _first_value(v: Any) -> Any:
    """Meta returns purchase_roas as a list of {action_type, value} pairs."""
    if isinstance(v, list) and v:
        first = v[0]
        if isinstance(first, dict):
            return first.get("value")
    return v
