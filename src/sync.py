r"""Daily sync: pulls every active ad account into data/dashboard.db.

For each active account:
  1. Account meta (1 GET, field-expanded)
  2. Campaigns w/ field expansion (1 paginated GET)
  3. Ad sets w/ targeting + bid + campaign expansion (1 paginated GET)
  4. Ads w/ creative + adset + campaign expansion (1 paginated GET)
  5. Insights last-30-days at 4 levels (account / campaign / adset / ad)
  6. Insights last-7-days w/ 4 breakdowns (placement / age-gender / device / country)

Idempotent (upserts on natural ids). Captures every usage header into
usage_samples. Writes a sync_runs row at start/finish with counters.

Run:  .\.venv\Scripts\python.exe src\sync.py
Opts:
  --account act_xxx   limit to a single account
  --days 7|14|30      override the insights look-back (default 30)
  --no-breakdowns     skip breakdown pulls (faster, fewer API calls)
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from lib import Cfg, Fb, Usage, Store, log


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "dashboard.db"


CAMPAIGN_FIELDS = ",".join([
    "id", "name", "objective", "buying_type", "status", "effective_status",
    "configured_status", "daily_budget", "lifetime_budget", "budget_remaining",
    "bid_strategy", "special_ad_categories", "start_time", "stop_time",
    "created_time", "updated_time",
])

ADSET_FIELDS = ",".join([
    "id", "name", "status", "effective_status", "configured_status",
    "campaign{id,name}", "optimization_goal", "billing_event", "bid_amount",
    "bid_strategy", "daily_budget", "lifetime_budget", "start_time", "end_time",
    "created_time", "updated_time", "targeting", "promoted_object",
    "attribution_spec", "destination_type",
])

AD_FIELDS = ",".join([
    "id", "name", "status", "effective_status",
    "campaign{id,name}", "adset{id,name}",
    "creative{id,object_story_id,effective_object_story_id,thumbnail_url,call_to_action_type}",
    "created_time", "updated_time", "issues_info",
])

INSIGHTS_FIELDS = ",".join([
    "spend", "impressions", "clicks", "reach", "frequency", "ctr", "cpc", "cpm", "cpp",
    "actions", "action_values", "cost_per_action_type",
    "purchase_roas", "website_purchase_roas",
    "date_start", "date_stop",
])


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--account", help="Limit to a single account id (act_xxx)")
    p.add_argument("--days", type=int, default=30, help="Insights look-back days (default 30)")
    p.add_argument("--no-breakdowns", action="store_true", help="Skip breakdown pulls")
    p.add_argument("--quick", action="store_true", help="Quick mode: skip ad-level and breakdown insights")
    return p.parse_args()


def daterange_preset(days: int) -> str:
    if days <= 1:
        return "yesterday"
    if days <= 7:
        return "last_7d"
    if days <= 14:
        return "last_14d"
    if days <= 30:
        return "last_30d"
    if days <= 90:
        return "last_90d"
    return "last_30d"


def get_active_accounts(fb: Fb, account_filter: str | None) -> list[dict]:
    accts = fb.get_all(
        "/me/adaccounts",
        params={
            "fields": (
                "id,account_id,name,account_status,currency,timezone_name,age,"
                "amount_spent,balance,spend_cap,disable_reason,business{id,name},"
                "capabilities"
            ),
            "limit": 100,
        },
    )
    if account_filter:
        accts = [a for a in accts if a.get("id") == account_filter or a.get("account_id") == account_filter.removeprefix("act_")]
    return [a for a in accts if a.get("account_status") == 1]


def pull_account_entities(fb: Fb, store: Store, account_id: str, counters: dict) -> dict:
    campaigns = fb.get_all(f"/{account_id}/campaigns", params={"fields": CAMPAIGN_FIELDS, "limit": 100})
    for c in campaigns:
        store.upsert_campaign(account_id, c)
        counters["campaigns"] += 1

    adsets = fb.get_all(f"/{account_id}/adsets", params={"fields": ADSET_FIELDS, "limit": 100})
    for a in adsets:
        store.upsert_adset(account_id, a)
        counters["adsets"] += 1

    ads = fb.get_all(f"/{account_id}/ads", params={"fields": AD_FIELDS, "limit": 100})
    for ad in ads:
        store.upsert_ad(account_id, ad)
        counters["ads"] += 1

    return {"campaigns": len(campaigns), "adsets": len(adsets), "ads": len(ads)}


def pull_insights(
    fb: Fb,
    store: Store,
    *,
    account_id: str,
    level: str,
    days: int,
    time_increment: int = 1,
    counters: dict,
) -> int:
    preset = daterange_preset(days)
    rows = fb.get_all(
        f"/{account_id}/insights",
        params={
            "fields": INSIGHTS_FIELDS,
            "date_preset": preset,
            "level": level,
            "time_increment": time_increment,
            "limit": 500,
        },
        max_pages=30,
    )
    written = 0
    for r in rows:
        entity_id = r.get(f"{level}_id") or r.get("ad_id") or r.get("adset_id") or r.get("campaign_id") or account_id
        if level == "account":
            entity_id = account_id
        store.upsert_insights(entity_id, level, account_id, r)
        written += 1
    counters["insights"] += written
    return written


def pull_breakdown(
    fb: Fb,
    store: Store,
    *,
    account_id: str,
    breakdown_type: str,
    breakdowns_param: str,
    days: int,
    counters: dict,
) -> int:
    preset = daterange_preset(days)
    rows = fb.get_all(
        f"/{account_id}/insights",
        params={
            "fields": "spend,impressions,clicks,actions,date_start,date_stop",
            "breakdowns": breakdowns_param,
            "date_preset": preset,
            "level": "account",
            "limit": 500,
        },
        max_pages=10,
    )
    written = 0
    keys = breakdowns_param.split(",")
    for r in rows:
        key_parts = [str(r.get(k) or "") for k in keys]
        breakdown_key = "|".join(key_parts)
        store.upsert_brk(
            entity_id=account_id,
            entity_type="account",
            breakdown_type=breakdown_type,
            breakdown_key=breakdown_key,
            account_id=account_id,
            row=r,
        )
        written += 1
    counters["breakdowns"] += written
    return written


def sync_account(fb: Fb, store: Store, acct: dict, args, counters: dict) -> dict[str, int]:
    acct_id = acct["id"]
    log("sync.account.start", acct=acct_id, name=acct.get("name"))

    full = fb.get(
        f"/{acct_id}",
        params={
            "fields": (
                "id,account_id,name,account_status,currency,timezone_name,age,"
                "amount_spent,balance,spend_cap,disable_reason,business{id,name},"
                "capabilities,funding_source_details,io_number,business_country_code"
            )
        },
    )
    if isinstance(full, dict) and not full.get("error"):
        store.upsert_account(full)
    else:
        store.upsert_account(acct)
    counters["accounts"] += 1

    ent = pull_account_entities(fb, store, acct_id, counters)
    log("sync.entities", acct=acct_id, **ent)

    pull_insights(fb, store, account_id=acct_id, level="account", days=args.days, counters=counters)
    pull_insights(fb, store, account_id=acct_id, level="campaign", days=args.days, counters=counters)
    pull_insights(fb, store, account_id=acct_id, level="adset", days=args.days, counters=counters)
    if not args.quick:
        pull_insights(fb, store, account_id=acct_id, level="ad", days=args.days, counters=counters)

    if not args.no_breakdowns and not args.quick:
        log("sync.breakdowns.start", acct=acct_id)
        pull_breakdown(fb, store, account_id=acct_id, breakdown_type="placement", breakdowns_param="publisher_platform,platform_position", days=min(args.days, 7), counters=counters)
        pull_breakdown(fb, store, account_id=acct_id, breakdown_type="age_gender", breakdowns_param="age,gender", days=min(args.days, 7), counters=counters)
        pull_breakdown(fb, store, account_id=acct_id, breakdown_type="device", breakdowns_param="device_platform,impression_device", days=min(args.days, 7), counters=counters)
        pull_breakdown(fb, store, account_id=acct_id, breakdown_type="country", breakdowns_param="country", days=min(args.days, 7), counters=counters)

    log("sync.account.done", acct=acct_id, name=acct.get("name"))
    return ent


def main() -> int:
    args = parse_args()
    cfg = Cfg.load()
    store = Store(DB_PATH)
    counters = {"accounts": 0, "campaigns": 0, "adsets": 0, "ads": 0, "insights": 0, "breakdowns": 0, "http_requests": 0}

    run_id = store.start_sync_run()
    log("sync.start", run_id=run_id, days=args.days, account=args.account, quick=args.quick, no_breakdowns=args.no_breakdowns)

    tier_from_buc: list[str] = []

    def on_sample(sample: dict) -> None:
        buc = sample.get("business_use_case")
        if isinstance(buc, dict):
            for entries in buc.values():
                if isinstance(entries, list):
                    for e in entries:
                        if isinstance(e, dict) and e.get("ads_api_access_tier"):
                            tier_from_buc.append(e["ads_api_access_tier"])
        store.insert_usage_sample(
            sample,
            ads_api_access_tier=(tier_from_buc[-1] if tier_from_buc else None),
        )

    usage = Usage(on_sample=on_sample)
    fb = Fb(cfg, cfg.sysuser_token, "sysuser", usage)

    errors: list[dict] = []

    try:
        accts = get_active_accounts(fb, args.account)
        log("sync.accounts.found", count=len(accts), ids=[a.get("id") for a in accts])
        for acct in accts:
            try:
                sync_account(fb, store, acct, args, counters)
            except Exception as err:
                errors.append({"acct": acct.get("id"), "error": str(err), "type": type(err).__name__})
                log("sync.account.error", acct=acct.get("id"), err=str(err))
        status = "ok" if not errors else "partial"
    except Exception as err:
        log("sync.fatal", err=str(err))
        errors.append({"step": "main", "error": str(err), "type": type(err).__name__})
        status = "failed"

    counters["http_requests"] = fb.calls
    store.finish_sync_run(run_id, counters, errors or None, status)

    print("\n" + "=" * 72)
    print(f"SYNC RUN #{run_id}  status={status}")
    print("=" * 72)
    print(f"HTTP requests:      {counters['http_requests']}")
    print(f"Accounts:           {counters['accounts']}")
    print(f"Campaigns:          {counters['campaigns']}")
    print(f"Ad sets:            {counters['adsets']}")
    print(f"Ads:                {counters['ads']}")
    print(f"Insights rows:      {counters['insights']}")
    print(f"Breakdown rows:     {counters['breakdowns']}")
    print(f"Errors:             {len(errors)}")
    if errors:
        for e in errors[:5]:
            print(f"  - {e}")
    print(f"DB:                 {DB_PATH}")
    print(f"x-app-usage:        {usage.app}")
    print(f"x-buc-usage:        {(json.dumps(usage.business_use_case)[:160] + '...') if isinstance(usage.business_use_case, dict) else usage.business_use_case}")
    print(f"ads_api_access_tier: {tier_from_buc[-1] if tier_from_buc else 'unknown'}")
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
