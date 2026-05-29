"""End-to-end smoke test on the new system-user token.

Runs ONE batched call against each active ad account: campaigns + ads + insights.
Confirms ads_management actually works and captures the first
x-business-use-case-usage header so we know our BUC starting position.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
from pathlib import Path
from urllib.parse import quote

import requests
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")


def req(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        sys.exit(f"missing env: {name}")
    return v


def proof(token: str, secret: str) -> str:
    return hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()


def main() -> int:
    token = req("FB_SYSTEM_USER_ACCESS_TOKEN")
    secret = req("FB_APP_SECRET")
    graph = os.environ.get("GRAPH_API_VERSION", "v25.0").strip()
    proxy = (
        f"http://{quote(req('PROXY_USER'), safe='')}:"
        f"{quote(req('PROXY_PASS'), safe='')}@"
        f"{req('PROXY_HOST')}:{req('PROXY_PORT')}"
    )
    s = requests.Session()
    s.trust_env = False
    s.proxies = {"http": proxy, "https": proxy}
    s.headers.update({"User-Agent": "fb-ads-manager/0.2 (+smoke)"})

    accts_resp = s.get(
        f"https://graph.facebook.com/{graph}/me/adaccounts",
        params={
            "fields": "id,account_id,name,account_status,currency",
            "limit": 50,
            "access_token": token,
            "appsecret_proof": proof(token, secret),
        },
        timeout=30,
    )
    accts = (accts_resp.json() or {}).get("data") or []
    active = [a for a in accts if a.get("account_status") == 1]
    print(f"Active ad accounts: {len(active)}/{len(accts)}\n")

    buc_samples = []
    for a in active:
        acct_id = a["id"]
        ap = proof(token, secret)
        ops = [
            {"method": "GET", "relative_url": f"{acct_id}/campaigns?fields=id,name,objective,status,effective_status,daily_budget,lifetime_budget&limit=5"},
            {"method": "GET", "relative_url": f"{acct_id}/ads?fields=id,name,status,effective_status,campaign{{id,name}},adset{{id,name}},creative{{id,thumbnail_url,object_story_id}}&limit=5"},
            {"method": "GET", "relative_url": f"{acct_id}/insights?fields=spend,impressions,clicks,reach,ctr,cpc&date_preset=last_7d&level=account&limit=1"},
            {"method": "GET", "relative_url": f"{acct_id}?fields=id,name,balance,amount_spent,spend_cap,currency,disable_reason,timezone_name,age"},
        ]
        payload = {
            "access_token": token,
            "appsecret_proof": ap,
            "include_headers": "false",
            "batch": json.dumps(
                [{"method": o["method"], "relative_url": o["relative_url"].lstrip("/")} for o in ops]
            ),
        }
        r = s.post(f"https://graph.facebook.com/{graph}/", data=payload, timeout=60)
        buc_raw = r.headers.get("x-business-use-case-usage")
        app_raw = r.headers.get("x-app-usage")
        try:
            buc = json.loads(buc_raw) if buc_raw else None
        except Exception:
            buc = buc_raw
        try:
            app = json.loads(app_raw) if app_raw else None
        except Exception:
            app = app_raw

        parsed = r.json() if r.status_code < 500 else []
        print(f"=== {a['name']} ({acct_id}) ===")
        labels = ["campaigns", "ads", "insights", "account"]
        for i, sub in enumerate(parsed):
            label = labels[i]
            if not isinstance(sub, dict):
                print(f"  {label}: malformed")
                continue
            code = sub.get("code")
            body_raw = sub.get("body")
            try:
                body = json.loads(body_raw) if isinstance(body_raw, str) else body_raw
            except Exception:
                body = body_raw
            if code and 200 <= code < 300 and isinstance(body, dict) and not body.get("error"):
                if "data" in body:
                    print(f"  {label}: OK ({len(body['data'])} rows)")
                    if label == "campaigns":
                        for c in body["data"][:3]:
                            print(f"    - {c.get('name')} [{c.get('effective_status')}] obj={c.get('objective')}")
                    elif label == "ads":
                        for ad in body["data"][:3]:
                            print(f"    - {ad.get('name')} [{ad.get('effective_status')}]  campaign={(ad.get('campaign') or {}).get('name')}")
                    elif label == "insights" and body["data"]:
                        ins = body["data"][0]
                        print(f"    7d spend={ins.get('spend')} impressions={ins.get('impressions')} clicks={ins.get('clicks')} ctr={ins.get('ctr')} cpc={ins.get('cpc')}")
                elif isinstance(body, dict):
                    print(f"  {label}: OK {body}")
            else:
                err = (body or {}).get("error") if isinstance(body, dict) else None
                print(f"  {label}: HTTP {code} err={(err or {}).get('message')}")
        buc_samples.append({"acct": acct_id, "name": a["name"], "buc": buc, "app": app})
        print()

    print("=" * 72)
    print("BUC HEADER SAMPLES")
    print("=" * 72)
    for s_ in buc_samples:
        print(f"\n{s_['name']} ({s_['acct']}):")
        print(f"  x-app-usage: {s_['app']}")
        print(f"  x-business-use-case-usage: {json.dumps(s_['buc'], indent=4) if isinstance(s_['buc'], dict) else s_['buc']}")
    print()

    out = ROOT / "data" / "smoke_test.json"
    out.write_text(json.dumps({"samples": buc_samples}, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Full BUC data -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
