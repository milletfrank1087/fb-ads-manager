"""Rate-limit observatory.

Reads usage_samples and sync_runs from data/dashboard.db and surfaces:
  * Current ads_api_access_tier (last seen)
  * x-app-usage trajectory (call_count / total_time / total_cputime over time)
  * Per-BUC-account utilization (last value + max-in-window)
  * Sync-run history (success rate, errors, throughput)

Read-only. Zero Graph API calls. Run any time.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from lib import Store


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "dashboard.db"


def fmt_row(headers: list[str], row: list[str], widths: list[int]) -> str:
    return "  ".join(c.ljust(w) for c, w in zip(row, widths))


def main() -> int:
    if not DB_PATH.exists():
        print(f"No database yet at {DB_PATH}. Run `python src\\sync.py` first.")
        return 1
    store = Store(DB_PATH)

    print("=" * 78)
    print("RATE-LIMIT OBSERVATORY")
    print("=" * 78)

    tier_row = store.query(
        "SELECT ads_api_access_tier, ts FROM usage_samples "
        "WHERE ads_api_access_tier IS NOT NULL ORDER BY ts DESC LIMIT 1"
    )
    tier = tier_row[0]["ads_api_access_tier"] if tier_row else "unknown"
    tier_seen_at = tier_row[0]["ts"] if tier_row else "n/a"
    print(f"\nads_api_access_tier (latest):  {tier}    [seen {tier_seen_at}]")
    if tier == "development_access":
        print("  > Limited tier. ~60 quota points / 300s window. Apply for Standard Access after ~500 calls / 15d.")
    elif tier == "standard_access":
        print("  > Standard tier. ~9,000 quota points / 300s window.")
    elif tier:
        print(f"  > Tier code: {tier}")

    print("\nX-APP-USAGE (most recent 10 captures)")
    app_rows = store.query(
        "SELECT ts, where_str, app_call_count, app_total_time, app_total_cputime "
        "FROM usage_samples WHERE app_call_count IS NOT NULL "
        "ORDER BY ts DESC LIMIT 10"
    )
    if not app_rows:
        print("  (none captured yet)")
    else:
        print(fmt_row([], ["ts", "where", "call_count%", "total_time%", "total_cputime%"], [27, 32, 12, 12, 14]))
        print("-" * 78)
        for r in app_rows:
            print(fmt_row(
                [],
                [
                    str(r["ts"])[:23],
                    str(r["where_str"])[:32],
                    f"{r['app_call_count']:.1f}" if r["app_call_count"] is not None else "-",
                    f"{r['app_total_time']:.1f}" if r["app_total_time"] is not None else "-",
                    f"{r['app_total_cputime']:.1f}" if r["app_total_cputime"] is not None else "-",
                ],
                [27, 32, 12, 12, 14],
            ))

    print("\nBUC UTILIZATION (per ad-account, latest sample)")
    buc_rows = store.query(
        "SELECT ts, where_str, buc FROM usage_samples WHERE buc IS NOT NULL "
        "ORDER BY ts DESC LIMIT 50"
    )
    seen_accounts: dict[str, dict] = {}
    for r in buc_rows:
        try:
            buc = json.loads(r["buc"])
        except (ValueError, TypeError):
            continue
        if not isinstance(buc, dict):
            continue
        for acct_id, entries in buc.items():
            if acct_id in seen_accounts:
                continue
            if not isinstance(entries, list):
                continue
            for e in entries:
                if not isinstance(e, dict):
                    continue
                seen_accounts[acct_id] = {"ts": r["ts"], "where": r["where_str"], **e}
                break
    if not seen_accounts:
        print("  (no BUC headers seen yet — Meta only emits these after sufficient Marketing API volume)")
    else:
        print(fmt_row([], ["ad_account", "type", "call%", "time%", "cpu%", "tier", "regain"], [22, 16, 6, 6, 6, 22, 8]))
        print("-" * 78)
        for acct, info in seen_accounts.items():
            print(fmt_row(
                [],
                [
                    acct,
                    str(info.get("type") or ""),
                    f"{info.get('call_count', 0):.0f}",
                    f"{info.get('total_time', 0):.0f}",
                    f"{info.get('total_cputime', 0):.0f}",
                    str(info.get("ads_api_access_tier") or ""),
                    str(info.get("estimated_time_to_regain_access") or 0),
                ],
                [22, 16, 6, 6, 6, 22, 8],
            ))

    print("\nSYNC-RUN HISTORY (most recent 10)")
    runs = store.query(
        "SELECT id, started_at, ended_at, status, accounts_touched, campaigns_touched, adsets_touched, ads_touched, "
        "insights_rows, breakdown_rows, http_requests, errors FROM sync_runs ORDER BY id DESC LIMIT 10"
    )
    if not runs:
        print("  (no sync runs recorded yet)")
    else:
        print(fmt_row([], ["id", "started_at", "status", "http", "acc", "camp", "adset", "ads", "ins", "brk"], [4, 26, 10, 6, 4, 5, 6, 5, 7, 6]))
        print("-" * 78)
        for r in runs:
            print(fmt_row(
                [],
                [
                    str(r["id"]),
                    str(r["started_at"])[:23],
                    str(r["status"] or ""),
                    str(r["http_requests"] or 0),
                    str(r["accounts_touched"] or 0),
                    str(r["campaigns_touched"] or 0),
                    str(r["adsets_touched"] or 0),
                    str(r["ads_touched"] or 0),
                    str(r["insights_rows"] or 0),
                    str(r["breakdown_rows"] or 0),
                ],
                [4, 26, 10, 6, 4, 5, 6, 5, 7, 6],
            ))
            if r["errors"]:
                print(f"     errors: {str(r['errors'])[:150]}")

    totals = store.query(
        "SELECT "
        "(SELECT COUNT(*) FROM accounts) AS accounts, "
        "(SELECT COUNT(*) FROM campaigns) AS campaigns, "
        "(SELECT COUNT(*) FROM adsets) AS adsets, "
        "(SELECT COUNT(*) FROM ads) AS ads, "
        "(SELECT COUNT(*) FROM insights) AS insights, "
        "(SELECT COUNT(*) FROM insights_brk) AS brk, "
        "(SELECT COUNT(*) FROM usage_samples) AS usage, "
        "(SELECT COUNT(*) FROM sync_runs) AS runs"
    )[0]
    print("\nSTORE TOTALS")
    print("-" * 78)
    print(f"  accounts={totals['accounts']}  campaigns={totals['campaigns']}  adsets={totals['adsets']}  ads={totals['ads']}")
    print(f"  insights={totals['insights']}  breakdowns={totals['brk']}  usage_samples={totals['usage']}  sync_runs={totals['runs']}")

    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
