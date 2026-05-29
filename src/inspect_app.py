"""Inspect Comments app metadata via app access token (proxied).

Used to diagnose why install-on-system-user fails with 'TOS-ing the app'.
"""

from __future__ import annotations

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


def main() -> int:
    proxy = (
        f"http://{quote(req('PROXY_USER'), safe='')}:"
        f"{quote(req('PROXY_PASS'), safe='')}@"
        f"{req('PROXY_HOST')}:{req('PROXY_PORT')}"
    )
    app_id = req("FB_APP_ID")
    secret = req("FB_APP_SECRET")
    graph = os.environ.get("GRAPH_API_VERSION", "v25.0").strip()

    s = requests.Session()
    s.trust_env = False
    s.proxies = {"http": proxy, "https": proxy}

    app_token = f"{app_id}|{secret}"
    fields = ",".join([
        "id", "name", "namespace", "category",
        "privacy_policy_url", "terms_of_service_url",
        "app_domains", "website_url",
        "company",
        "user_support_url", "user_support_email",
        "auth_dialog_data_help_url",
        "ipad_app_store_id", "iphone_app_store_id",
    ])
    r = s.get(
        f"https://graph.facebook.com/{graph}/{app_id}",
        params={"fields": fields, "access_token": app_token},
        timeout=30,
    )
    print(json.dumps({"app_basic": r.json()}, indent=2, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
