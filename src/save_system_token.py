"""Persist + verify a system-user access token generated in the BM UI.

If install_app_on_system_user fails via API (e.g. "TOS-ing the app" / code 3957),
the cleanest workaround is to generate the token in business.facebook.com:

  Business Settings -> Users -> System Users -> fb-ads-manager-sysuser
    -> 'Generate New Token' -> select 'Comments' app
    -> tick all required scopes -> Generate -> copy.

Then run:
  python src\\save_system_token.py PASTED_TOKEN

This script (proxied):
  1. Calls /debug_token to confirm the token is valid + lists scopes.
  2. Probes /me, /me/adaccounts, /me/accounts with the new token.
  3. Writes the token into .env as FB_SYSTEM_USER_ACCESS_TOKEN.
  4. Backs up to data/system_user_token.json.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
load_dotenv(ENV_PATH)


def mask(s: str | None, head: int = 8, tail: int = 4) -> str:
    if not s:
        return "<empty>"
    if len(s) <= head + tail:
        return "*" * len(s)
    return f"{s[:head]}...{s[-tail:]} (len={len(s)})"


def req(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        sys.exit(f"missing env: {name}")
    return v


def proof(token: str, secret: str) -> str:
    return hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit("usage: python src\\save_system_token.py SYSTEM_USER_TOKEN")
    token = sys.argv[1].strip()
    if not token.startswith("EAA"):
        sys.exit("token does not look like a Facebook access token (should start with 'EAA')")

    app_id = req("FB_APP_ID")
    app_secret = req("FB_APP_SECRET")
    graph = os.environ.get("GRAPH_API_VERSION", "v25.0").strip()

    proxy = (
        f"http://{quote(req('PROXY_USER'), safe='')}:"
        f"{quote(req('PROXY_PASS'), safe='')}@"
        f"{req('PROXY_HOST')}:{req('PROXY_PORT')}"
    )

    s = requests.Session()
    s.trust_env = False
    s.proxies = {"http": proxy, "https": proxy}
    s.headers.update({"User-Agent": "fb-ads-manager/0.2 (+save-token)"})

    ap = proof(token, app_secret)

    print(json.dumps({"event": "save.start", "token": mask(token)}))

    di = s.get(
        f"https://graph.facebook.com/{graph}/debug_token",
        params={"input_token": token, "access_token": token, "appsecret_proof": ap},
        timeout=30,
    ).json()
    data = (di or {}).get("data") or {}
    if not data.get("is_valid"):
        sys.exit(f"token is not valid: {di}")
    scopes = sorted(data.get("scopes") or [])
    print(
        json.dumps(
            {
                "event": "debug_token",
                "is_valid": data.get("is_valid"),
                "type": data.get("type"),
                "user_id": data.get("user_id"),
                "profile_id": data.get("profile_id"),
                "app_id": data.get("app_id"),
                "expires_at": data.get("expires_at"),
                "data_access_expires_at": data.get("data_access_expires_at"),
                "scope_count": len(scopes),
                "scopes": scopes,
            }
        )
    )
    if data.get("type") != "SYSTEM_USER":
        print(
            json.dumps(
                {
                    "event": "warn.token_type",
                    "got": data.get("type"),
                    "expected": "SYSTEM_USER",
                    "note": "Token works but isn't a system user token. Still saving.",
                }
            )
        )

    me = s.get(
        f"https://graph.facebook.com/{graph}/me",
        params={"fields": "id,name", "access_token": token, "appsecret_proof": ap},
        timeout=30,
    ).json()
    print(json.dumps({"event": "me", "data": me}, ensure_ascii=False))

    aa = s.get(
        f"https://graph.facebook.com/{graph}/me/adaccounts",
        params={
            "fields": "id,account_id,name,account_status,currency,timezone_name",
            "limit": 50,
            "access_token": token,
            "appsecret_proof": ap,
        },
        timeout=30,
    ).json()
    aa_list = (aa or {}).get("data") or []
    print(json.dumps({"event": "adaccounts", "count": len(aa_list), "data": aa_list}, ensure_ascii=False))

    pages = s.get(
        f"https://graph.facebook.com/{graph}/me/accounts",
        params={
            "fields": "id,name,tasks",
            "limit": 50,
            "access_token": token,
            "appsecret_proof": ap,
        },
        timeout=30,
    ).json()
    p_list = (pages or {}).get("data") or []
    print(json.dumps({"event": "pages", "count": len(p_list), "data": p_list}, ensure_ascii=False))

    text = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
    if re.search(r"^FB_SYSTEM_USER_ACCESS_TOKEN=", text, flags=re.M):
        new_text = re.sub(
            r"^FB_SYSTEM_USER_ACCESS_TOKEN=.*$",
            f"FB_SYSTEM_USER_ACCESS_TOKEN={token}",
            text,
            flags=re.M,
        )
    else:
        new_text = text.rstrip() + f"\nFB_SYSTEM_USER_ACCESS_TOKEN={token}\n"
    ENV_PATH.write_text(new_text, encoding="utf-8")

    out_dir = ROOT / "data"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "system_user_token.json").write_text(
        json.dumps(
            {
                "token": token,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "debug_token": data,
                "adaccounts": aa_list,
                "pages": p_list,
                "me": me,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    print()
    print("=" * 72)
    print("SYSTEM USER TOKEN SAVED")
    print("=" * 72)
    print(f"Token: {mask(token)}  type={data.get('type')}")
    print(f"Scopes ({len(scopes)}):")
    for sc in scopes:
        print(f"  - {sc}")
    print(f"\nAd accounts visible to this token: {len(aa_list)}")
    for a in aa_list:
        print(f"  - {a.get('name')} ({a.get('id')})  status={a.get('account_status')}  currency={a.get('currency')}")
    print(f"\nPages visible to this token: {len(p_list)}")
    for p in p_list:
        print(f"  - {p.get('name')} ({p.get('id')})  tasks={p.get('tasks')}")
    print()
    print("Written to: .env and data\\system_user_token.json")
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
