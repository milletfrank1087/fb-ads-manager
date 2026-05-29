"""Learning-phase health view.

For each active ad set, computes:
  * effective_status (LEARNING / LEARNING_LIMITED / ACTIVE / PAUSED / ...)
  * weekly_purchase_events  — sum of purchases over last 7d from insights.actions
  * weekly_conversion_events — sum of optimization-goal events when known
  * 50_event_threshold_met  — whether Meta's exit threshold is plausibly met
  * days_in_learning        — approx, based on updated_time when in LEARNING
  * recent_change_log_count — number of writes in the last 7d (high = reset risk)
  * budget_today / 7d_avg_spend / target_daily_spend_for_50_events

Read-only. Zero Graph API calls.

Run:  .\.venv\Scripts\python.exe src\health.py
Opts:
  --account act_xxx   filter to one account
  --status LEARNING   filter by effective_status (use --status all for everything)
  --json              emit machine-readable JSON
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from lib import Store


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "dashboard.db"


LEARNING_STATUSES = {"LEARNING", "LEARNING_LIMITED"}
ACTIVE_STATUSES = {"ACTIVE", "LEARNING", "LEARNING_LIMITED"}


def actions_sum_for(actions_json: str | None, types: list[str]) -> int:
    if not actions_json:
        return 0
    try:
        actions = json.loads(actions_json)
    except ValueError:
        return 0
    if not isinstance(actions, list):
        return 0
    total = 0
    for a in actions:
        if not isinstance(a, dict):
            continue
        if a.get("action_type") in types:
            try:
                total += int(float(a.get("value") or 0))
            except (TypeError, ValueError):
                continue
    return total


def collect_health(store: Store, *, account_filter: str | None, status_filter: str | None) -> list[dict]:
    where = ["a.account_status = 1"]
    params: list = []
    if account_filter:
        where.append("ad.account_id = ?")
        params.append(account_filter)
    if status_filter and status_filter.lower() != "all":
        where.append("ad.effective_status = ?")
        params.append(status_filter.upper())

    sql = f"""
        SELECT ad.id AS adset_id, ad.name AS adset_name, ad.effective_status,
               ad.optimization_goal, ad.daily_budget, ad.lifetime_budget,
               ad.created_time, ad.updated_time, ad.bid_strategy,
               c.id AS campaign_id, c.name AS campaign_name, c.objective,
               a.id AS account_id, a.name AS account_name, a.currency
        FROM adsets ad
        JOIN campaigns c ON c.id = ad.campaign_id
        JOIN accounts a ON a.id = ad.account_id
        WHERE {' AND '.join(where)}
        ORDER BY a.name, c.name, ad.name
    """
    adsets = store.query(sql, params)

    out: list[dict] = []
    for r in adsets:
        adset_id = r["adset_id"]
        ins = store.query(
            "SELECT spend, impressions, clicks, frequency, ctr, actions FROM insights "
            "WHERE entity_id = ? AND entity_type='adset' "
            "ORDER BY date_start DESC LIMIT 7",
            (adset_id,),
        )
        spend_7d = sum((row["spend"] or 0) for row in ins)
        impressions_7d = sum((row["impressions"] or 0) for row in ins)
        clicks_7d = sum((row["clicks"] or 0) for row in ins)
        purchases_7d = sum(actions_sum_for(row["actions"], ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]) for row in ins)
        leads_7d = sum(actions_sum_for(row["actions"], ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"]) for row in ins)
        link_clicks_7d = sum(actions_sum_for(row["actions"], ["link_click"]) for row in ins)

        goal = (r["optimization_goal"] or "").upper()
        if goal == "OFFSITE_CONVERSIONS" or goal == "VALUE":
            optimization_events = purchases_7d
            event_label = "purchases"
        elif goal == "LEADS":
            optimization_events = leads_7d
            event_label = "leads"
        elif goal == "LINK_CLICKS":
            optimization_events = link_clicks_7d
            event_label = "link_clicks"
        elif goal == "IMPRESSIONS" or goal == "REACH":
            optimization_events = impressions_7d
            event_label = "impressions"
        else:
            optimization_events = max(purchases_7d, leads_7d, link_clicks_7d)
            event_label = goal.lower() if goal else "unknown"

        cpa_7d = (spend_7d / optimization_events) if optimization_events else None
        daily_budget = (r["daily_budget"] or 0) / 100.0 if r["daily_budget"] else 0
        target_daily = (cpa_7d * 50 / 7) if cpa_7d else None

        recent_changes = store.query(
            "SELECT COUNT(*) AS n FROM change_log WHERE entity_id = ? AND entity_type='adset' "
            "AND datetime(ts) >= datetime('now', '-7 days')",
            (adset_id,),
        )
        recent_change_count = recent_changes[0]["n"]

        effective_status = r["effective_status"] or "UNKNOWN"
        threshold_met = (optimization_events >= 50)

        if effective_status == "LEARNING_LIMITED":
            label = "LIMITED — needs consolidation or higher budget"
        elif effective_status == "LEARNING":
            label = f"LEARNING — {optimization_events}/{50} {event_label}"
        elif effective_status == "ACTIVE":
            label = f"ACTIVE — {optimization_events} {event_label}/7d"
        elif effective_status == "PAUSED":
            label = "PAUSED"
        else:
            label = effective_status

        out.append({
            "account_id": r["account_id"],
            "account_name": r["account_name"],
            "campaign_name": r["campaign_name"],
            "objective": r["objective"],
            "adset_id": adset_id,
            "adset_name": r["adset_name"],
            "effective_status": effective_status,
            "label": label,
            "optimization_goal": goal,
            "event_label": event_label,
            "events_7d": optimization_events,
            "purchases_7d": purchases_7d,
            "leads_7d": leads_7d,
            "link_clicks_7d": link_clicks_7d,
            "spend_7d": round(spend_7d, 2),
            "impressions_7d": impressions_7d,
            "clicks_7d": clicks_7d,
            "cpa_7d": round(cpa_7d, 2) if cpa_7d else None,
            "daily_budget": daily_budget,
            "target_daily_for_50_events": round(target_daily, 2) if target_daily else None,
            "currency": r["currency"],
            "bid_strategy": r["bid_strategy"],
            "threshold_50_met": threshold_met,
            "recent_changes_7d": recent_change_count,
            "updated_time": r["updated_time"],
        })

    return out


def print_table(rows: list[dict]) -> None:
    if not rows:
        print("(no ad sets matched the filter)")
        return

    by_account: dict[str, list[dict]] = {}
    for r in rows:
        by_account.setdefault(r["account_name"] or "<unknown>", []).append(r)

    print("=" * 100)
    print("LEARNING-PHASE HEALTH")
    print("=" * 100)

    totals = {
        "ACTIVE": 0, "LEARNING": 0, "LEARNING_LIMITED": 0, "PAUSED": 0,
        "ADSET_PAUSED": 0, "CAMPAIGN_PAUSED": 0, "DISAPPROVED": 0, "WITH_ISSUES": 0,
        "OTHER": 0, "OVER_50": 0,
    }
    for r in rows:
        st = r["effective_status"]
        totals[st] = totals.get(st, 0) + 1
        if r["threshold_50_met"]:
            totals["OVER_50"] += 1

    print(f"\nTotal ad sets: {len(rows)}")
    for k in ("ACTIVE", "LEARNING", "LEARNING_LIMITED", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "DISAPPROVED", "WITH_ISSUES"):
        if totals.get(k):
            print(f"  {k:<20}  {totals[k]}")
    print(f"  >=50 events / 7d:     {totals['OVER_50']}")
    print()

    for acct, items in by_account.items():
        print(f"\n[{acct}]  ({len(items)} ad sets)")
        print(f"  {'campaign':<30} {'ad set':<30} {'status':<18} {'events/7d':>10} {'cpa':>10} {'budget':>10} {'tgt-50':>10}")
        print("  " + "-" * 110)
        for r in items:
            ev = f"{r['events_7d']}"
            cpa = f"{r['cpa_7d']:.2f}" if r['cpa_7d'] else "-"
            bud = f"{r['daily_budget']:.0f}" if r['daily_budget'] else "-"
            tgt = f"{r['target_daily_for_50_events']:.0f}" if r['target_daily_for_50_events'] else "-"
            marker = ""
            if r["effective_status"] == "LEARNING_LIMITED":
                marker = "  !! limited"
            elif r["effective_status"] == "LEARNING" and not r["threshold_50_met"]:
                marker = "  -> needs more events"
            elif r["effective_status"] == "ACTIVE" and r["recent_changes_7d"] > 2:
                marker = f"  ~ {r['recent_changes_7d']} edits/7d (reset risk)"
            print(f"  {(r['campaign_name'] or '')[:30]:<30} {(r['adset_name'] or '')[:30]:<30} {r['effective_status']:<18} {ev:>10} {cpa:>10} {bud:>10} {tgt:>10}{marker}")

    print()
    print("=" * 100)
    learning_limited = [r for r in rows if r["effective_status"] == "LEARNING_LIMITED"]
    if learning_limited:
        print(f"\n!! {len(learning_limited)} ad set(s) in LEARNING_LIMITED — these are bleeding budget.")
        print("   Action: consolidate audiences OR raise budget OR switch to a higher-funnel optimization goal.")
    sub_threshold = [r for r in rows if r["effective_status"] in ACTIVE_STATUSES and not r["threshold_50_met"] and r["daily_budget"] and r["target_daily_for_50_events"] and r["target_daily_for_50_events"] > r["daily_budget"] * 2]
    if sub_threshold:
        print(f"\n!! {len(sub_threshold)} active ad set(s) cannot mathematically reach 50 events/week at current budget.")
        for r in sub_threshold[:5]:
            print(f"   - {r['account_name']} / {r['adset_name']}: needs ~{r['target_daily_for_50_events']:.0f} {r['currency']}/day, has {r['daily_budget']:.0f}")
    print("=" * 100)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--account", help="Filter to one account id (act_xxx)")
    p.add_argument("--status", default="all", help="Filter by effective_status (e.g. LEARNING, LEARNING_LIMITED, ACTIVE) — default all")
    p.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    args = p.parse_args()

    if not DB_PATH.exists():
        print(f"No database at {DB_PATH}. Run `python src\\sync.py` first.")
        return 1

    store = Store(DB_PATH)
    rows = collect_health(store, account_filter=args.account, status_filter=args.status)

    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False, default=str))
    else:
        print_table(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
