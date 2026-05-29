"""Exchange a short-lived user token for a long-lived one and persist it.

Usage:
  python src\\exchange_token.py SHORT_LIVED_TOKEN

The token argument is the short-lived user token that Graph Explorer hands you
after you click 'Generate Access Token'. This script:

  1. Calls /oauth/access_token with grant_type=fb_exchange_token (proxied).
  2. Confirms scopes via /debug_token.
  3. Writes the new long-lived token into .env as FB_USER_ACCESS_TOKEN.
  4. Saves a copy to data/long_lived_user_token.json.

All traffic goes through PROXY_*. See AGENTS.md.
"""

from __future__ import annotations

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


def required(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        sys.exit(f"missing required env var {name}")
    return v


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit("usage: python src\\exchange_token.py SHORT_LIVED_TOKEN")
    short_token = sys.argv[1].strip()
    if not short_token.startswith("EAA"):
        sys.exit("token does not look like a Facebook user token (should start with 'EAA')")

    app_id = required("FB_APP_ID")
    app_secret = required("FB_APP_SECRET")
    graph_v = (os.environ.get("GRAPH_API_VERSION") or "v25.0").strip()

    proxy_url = (
        f"http://{quote(required('PROXY_USER'), safe='')}:"
        f"{quote(required('PROXY_PASS'), safe='')}@"
        f"{required('PROXY_HOST')}:{required('PROXY_PORT')}"
    )

    s = requests.Session()
    s.trust_env = False
    s.proxies = {"http": proxy_url, "https": proxy_url}
    s.headers.update({"User-Agent": "fb-ads-manager/0.2 (+exchange)"})

    print(json.dumps({"event": "exchange.start", "app_id": app_id, "short_token": mask(short_token)}))

    r = s.get(
        f"https://graph.facebook.com/{graph_v}/oauth/access_token",
        params={
            "grant_type": "fb_exchange_token",
            "client_id": app_id,
            "client_secret": app_secret,
            "fb_exchange_token": short_token,
        },
        timeout=30,
    )
    body = r.json()
    if r.status_code != 200 or "access_token" not in body:
        sys.exit(f"exchange failed: HTTP {r.status_code} {body}")
    long_token = body["access_token"]
    expires_in = body.get("expires_in")
    print(
        json.dumps(
            {
                "event": "exchange.ok",
                "long_token": mask(long_token),
                "expires_in_seconds": expires_in,
                "expires_in_days": (
                    round(expires_in / 86400, 1) if isinstance(expires_in, (int, float)) else None
                ),
            }
        )
    )

    info = s.get(
        f"https://graph.facebook.com/{graph_v}/debug_token",
        params={"input_token": long_token, "access_token": long_token},
        timeout=30,
    ).json()
    data = (info or {}).get("data") or {}
    scopes = sorted(data.get("scopes") or [])
    print(
        json.dumps(
            {
                "event": "debug_token",
                "is_valid": data.get("is_valid"),
                "type": data.get("type"),
                "user_id": data.get("user_id"),
                "expires_at": data.get("expires_at"),
                "data_access_expires_at": data.get("data_access_expires_at"),
                "scope_count": len(scopes),
                "scopes": scopes,
            }
        )
    )

    text = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
    if re.search(r"^FB_USER_ACCESS_TOKEN=", text, flags=re.M):
        new_text = re.sub(
            r"^FB_USER_ACCESS_TOKEN=.*$",
            f"FB_USER_ACCESS_TOKEN={long_token}",
            text,
            flags=re.M,
        )
    else:
        new_text = text.rstrip() + f"\nFB_USER_ACCESS_TOKEN={long_token}\n"
    ENV_PATH.write_text(new_text, encoding="utf-8")

    out_dir = ROOT / "data"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "long_lived_user_token.json").write_text(
        json.dumps(
            {
                "token": long_token,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "expires_in_seconds": expires_in,
                "debug_token": data,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps({"event": "persisted", "env": str(ENV_PATH), "json": str(out_dir / "long_lived_user_token.json")}))

    print()
    print("=" * 72)
    print("LONG-LIVED USER TOKEN WRITTEN TO .env")
    print("=" * 72)
    if "business_management" not in scopes:
        print("WARNING: business_management is STILL NOT in the granted scopes.")
        print("  -> When you ran Graph Explorer's 'Add a Permission', business_management")
        print("     was not ticked or you didn't approve it in the FB dialog.")
        print("  -> Re-do the Graph Explorer step, ensuring business_management is checked,")
        print("     then re-run this script with the new short token.")
    else:
        print("business_management is present. Next step:")
        print()
        print("    python src\\setup.py")
        print()
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
