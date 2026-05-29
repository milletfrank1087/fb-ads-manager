"""Verify proxy egress with ZERO Facebook Graph API calls.

Run me BEFORE any FB script. If this fails, every other script will also fail,
but with more confusing errors. See AGENTS.md rule 1.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import quote

import requests
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")


def _mask(s: str, head: int = 4, tail: int = 2) -> str:
    if not s:
        return "<empty>"
    if len(s) <= head + tail:
        return "*" * len(s)
    return f"{s[:head]}...{s[-tail:]} (len={len(s)})"


def _require(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        sys.exit(f"[proxy_check] missing required env var: {name}")
    return v


def build_proxy_url() -> tuple[str, dict]:
    host = _require("PROXY_HOST")
    port = _require("PROXY_PORT")
    user = _require("PROXY_USER")
    password = _require("PROXY_PASS")
    url = f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}"
    summary = {
        "proxyHost": host,
        "proxyPort": port,
        "proxyUser": _mask(user, 4, 2),
        "proxyPass": _mask(password, 2, 2),
    }
    return url, summary


def log(event: str, **fields) -> None:
    payload = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": event, **fields}
    print(json.dumps(payload, ensure_ascii=False))


def main() -> int:
    proxy_url, summary = build_proxy_url()
    log("proxy_check.start", **summary)

    session = requests.Session()
    session.trust_env = False
    proxies = {"http": proxy_url, "https": proxy_url}
    timeout = int(os.environ.get("REQUEST_TIMEOUT_SECONDS", "30"))

    started = time.time()
    try:
        resp = session.get(
            "https://ipinfo.io/json",
            proxies=proxies,
            timeout=timeout,
            headers={"User-Agent": "fb-ads-manager/0.1 (proxy-check)"},
        )
    except requests.RequestException as err:
        log(
            "proxy_check.transport_error",
            error=str(err),
            error_type=type(err).__name__,
            elapsed_ms=int((time.time() - started) * 1000),
        )
        log(
            "proxy_check.hint",
            hint="proxy unreachable or rejected credentials — check PROXY_HOST/PORT/USER/PASS",
        )
        return 2

    elapsed_ms = int((time.time() - started) * 1000)
    if resp.status_code != 200:
        log(
            "proxy_check.http_error",
            status=resp.status_code,
            body_preview=resp.text[:300],
            elapsed_ms=elapsed_ms,
        )
        return 3

    try:
        info = resp.json()
    except ValueError:
        log("proxy_check.bad_json", body_preview=resp.text[:300], elapsed_ms=elapsed_ms)
        return 4

    result = {
        "egressIp": info.get("ip"),
        "country": info.get("country"),
        "region": info.get("region"),
        "city": info.get("city"),
        "org": info.get("org"),
        "timezone": info.get("timezone"),
        "elapsedMs": elapsed_ms,
        "expectedProxyHost": summary["proxyHost"],
        "egressMatchesProxy": info.get("ip") == summary["proxyHost"],
    }
    log("proxy_check.success", **result)

    out_dir = ROOT / "data"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "proxy_check.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    log("proxy_check.written", path=str(out_dir / "proxy_check.json"))

    if not result["egressMatchesProxy"]:
        log(
            "proxy_check.warn_ip_mismatch",
            expected=summary["proxyHost"],
            actual=result["egressIp"],
            note="egress IP differs from PROXY_HOST — proxy may be a load-balancer / NAT, this is often OK but worth knowing",
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
