"""Proxied Graph API client.

Mandatory rules (AGENTS.md):
  * Every HTTP request goes through PROXY_HOST:PROXY_PORT (trust_env=False).
  * Every Graph call is signed with appsecret_proof.
  * Every response captures x-app-usage and x-business-use-case-usage.
  * Throttle at MIN_REQUEST_INTERVAL_MS between top-level requests.
  * Batches respect Meta's 50-op limit and capture outer headers.

This module is the ONLY place that touches `requests.Session` directly for
Graph API calls. All other scripts import `Fb` from here.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import requests
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


RATE_LIMIT_CODES = {4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004}


def _req(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        sys.exit(f"missing env: {name}")
    return v


def _opt(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def mask(s: str, head: int = 8, tail: int = 4) -> str:
    if not s:
        return "<empty>"
    if len(s) <= head + tail:
        return "*" * len(s)
    return f"{s[:head]}...{s[-tail:]} (len={len(s)})"


def proof(token: str, secret: str) -> str:
    return hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()


def log(event: str, **fields: Any) -> None:
    payload = {"ts": datetime.now(timezone.utc).isoformat(), "event": event}
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False, default=str))


@dataclass
class Cfg:
    sysuser_token: str
    page_token: str
    page_id: str
    business_id: str
    app_id: str
    app_secret: str
    proxy: str
    graph_base: str
    graph_version: str
    timeout_s: int
    min_gap_s: float

    @classmethod
    def load(cls) -> "Cfg":
        proxy_url = (
            f"http://{quote(_req('PROXY_USER'), safe='')}:"
            f"{quote(_req('PROXY_PASS'), safe='')}@"
            f"{_req('PROXY_HOST')}:{_req('PROXY_PORT')}"
        )
        version = _opt("GRAPH_API_VERSION", "v25.0")
        return cls(
            sysuser_token=_req("FB_SYSTEM_USER_ACCESS_TOKEN"),
            page_token=_opt("FB_ACCESS_TOKEN"),
            page_id=_opt("FB_TARGET_PAGE_ID"),
            business_id=_opt("FB_BUSINESS_ID"),
            app_id=_opt("FB_APP_ID"),
            app_secret=_req("FB_APP_SECRET"),
            proxy=proxy_url,
            graph_base=f"https://graph.facebook.com/{version}",
            graph_version=version,
            timeout_s=int(_opt("REQUEST_TIMEOUT_SECONDS", "30")),
            min_gap_s=int(_opt("MIN_REQUEST_INTERVAL_MS", "750")) / 1000.0,
        )


@dataclass
class Usage:
    """Captures rate-limit headers across every request.

    `on_sample` is an optional callback fired after each capture so the
    persistence layer can record the sample. The most recent value of each
    header sits on the dataclass for fast access.
    """

    app: dict | None = None
    business_use_case: dict | None = None
    ad_account: dict | None = None
    page: dict | None = None
    samples: list[dict] = field(default_factory=list)
    on_sample: Callable[[dict], None] | None = None

    def capture(self, hdrs: Any, where: str) -> None:
        sample: dict[str, Any] = {
            "where": where,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        seen = False
        for h_name, attr in (
            ("x-app-usage", "app"),
            ("x-business-use-case-usage", "business_use_case"),
            ("x-ad-account-usage", "ad_account"),
            ("x-page-usage", "page"),
        ):
            raw = hdrs.get(h_name) if hasattr(hdrs, "get") else None
            if not raw:
                continue
            try:
                parsed = json.loads(raw) if isinstance(raw, str) else raw
            except (ValueError, TypeError):
                continue
            setattr(self, attr, parsed)
            sample[attr] = parsed
            seen = True
        if seen:
            self.samples.append(sample)
            if self.on_sample:
                try:
                    self.on_sample(sample)
                except Exception as err:
                    log("usage.on_sample.error", error=str(err))

    def app_max_util(self) -> float:
        if not isinstance(self.app, dict):
            return 0.0
        return float(max((self.app.get(k) or 0) for k in ("call_count", "total_time", "total_cputime")))

    def buc_max_util(self) -> float:
        if not isinstance(self.business_use_case, dict):
            return 0.0
        worst = 0.0
        for entries in self.business_use_case.values():
            if not isinstance(entries, list):
                continue
            for e in entries:
                if not isinstance(e, dict):
                    continue
                worst = max(worst, float(max((e.get(k) or 0) for k in ("call_count", "total_time", "total_cputime"))))
        return worst


class Fb:
    """Proxied Graph API client.

    Construct one per token; pass it around. Throttling, signing, and usage
    capture all happen here.
    """

    def __init__(self, cfg: Cfg, token: str, label: str, usage: Usage):
        self.cfg = cfg
        self.token = token
        self.label = label
        self.usage = usage
        self._last = 0.0
        self.calls = 0
        self.s = requests.Session()
        self.s.trust_env = False
        self.s.proxies = {"http": cfg.proxy, "https": cfg.proxy}
        self.s.headers.update({"User-Agent": "fb-ads-manager/0.4 (+sync)"})

    def _wait(self) -> None:
        gap = time.time() - self._last
        if gap < self.cfg.min_gap_s:
            time.sleep(self.cfg.min_gap_s - gap + random.uniform(0, 0.2))

        if self.usage.app_max_util() >= 90 or self.usage.buc_max_util() >= 90:
            log("fb.preemptive_backoff", app=self.usage.app, buc=self.usage.business_use_case)
            time.sleep(60.0)
        elif self.usage.app_max_util() >= 80 or self.usage.buc_max_util() >= 80:
            time.sleep(5.0)

        self._last = time.time()

    def _send(self, method: str, path: str, *, params: dict | None = None, data: dict | None = None) -> Any:
        clean = path if path.startswith("/") else f"/{path}"
        url = self.cfg.graph_base + clean
        self._wait()
        self.calls += 1
        ap = proof(self.token, self.cfg.app_secret)
        kwargs: dict[str, Any] = {"timeout": self.cfg.timeout_s, "allow_redirects": False}
        if method == "GET":
            p = dict(params or {})
            p.setdefault("access_token", self.token)
            p.setdefault("appsecret_proof", ap)
            kwargs["params"] = p
        else:
            d = dict(data or {})
            d.setdefault("access_token", self.token)
            d.setdefault("appsecret_proof", ap)
            kwargs["data"] = d
        try:
            r = self.s.request(method, url, **kwargs)
        except requests.RequestException as err:
            log("fb.transport_error", label=self.label, method=method, path=clean, err=str(err))
            return {"error": {"code": -1, "message": f"transport: {err}"}}
        self.usage.capture(r.headers, where=f"{method}:{clean}")
        try:
            body = r.json()
        except ValueError:
            body = {"_non_json": r.text[:300]}
        if isinstance(body, dict) and body.get("error"):
            err = body["error"]
            code = err.get("code")
            if code in RATE_LIMIT_CODES:
                log("fb.rate_limited", label=self.label, path=clean, code=code, msg=err.get("message"))
                time.sleep(60.0)
            log(
                "fb.api_error",
                label=self.label,
                path=clean,
                code=code,
                subcode=err.get("error_subcode"),
                msg=(err.get("message") or "")[:160],
            )
        return body

    def get(self, path: str, params: dict | None = None) -> Any:
        return self._send("GET", path, params=params)

    def post(self, path: str, data: dict | None = None) -> Any:
        return self._send("POST", path, data=data)

    def get_all(self, path: str, params: dict | None = None, *, max_pages: int = 50) -> list[dict]:
        """Auto-paginate a list endpoint. Returns flat list of `data` rows."""
        out: list[dict] = []
        p = dict(params or {})
        next_url: str | None = None
        for _ in range(max_pages):
            if next_url:
                self._wait()
                self.calls += 1
                try:
                    r = self.s.get(next_url, timeout=self.cfg.timeout_s, allow_redirects=False)
                    self.usage.capture(r.headers, where=f"GET:{path}(next)")
                    body = r.json()
                except (requests.RequestException, ValueError) as err:
                    log("fb.paginate_error", path=path, err=str(err))
                    break
            else:
                body = self.get(path, p)
            if not isinstance(body, dict) or body.get("error"):
                break
            out.extend(body.get("data") or [])
            next_url = ((body.get("paging") or {}).get("next")) or None
            if not next_url:
                break
        return out

    def batch(self, ops: list[dict]) -> dict[str, Any]:
        """Run up to 50 ops in one HTTP request.

        Each op: {name, method, relative_url}. Returns dict keyed by op name
        with {code, body, error?} sub-dicts.
        """
        if not ops:
            return {}
        if len(ops) > 50:
            a = self.batch(ops[:50])
            b = self.batch(ops[50:])
            return {**a, **b}
        ap = proof(self.token, self.cfg.app_secret)
        payload = {
            "access_token": self.token,
            "appsecret_proof": ap,
            "include_headers": "false",
            "batch": json.dumps(
                [
                    {"method": o["method"], "relative_url": o["relative_url"].lstrip("/"), "name": o["name"]}
                    for o in ops
                ]
            ),
        }
        log("fb.batch.start", label=self.label, count=len(ops), names=[o["name"] for o in ops])
        t0 = time.time()
        raw = self._send("POST", "/", data=payload)
        elapsed_ms = int((time.time() - t0) * 1000)
        out: dict[str, Any] = {}
        if isinstance(raw, dict) and raw.get("error"):
            log("fb.batch.outer_error", error=raw["error"], elapsed_ms=elapsed_ms)
            for o in ops:
                out[o["name"]] = {"_outer_error": raw["error"]}
            return out
        if not isinstance(raw, list):
            return out
        ok, fail = 0, 0
        for o, item in zip(ops, raw):
            if not isinstance(item, dict):
                out[o["name"]] = {"_malformed": item}
                fail += 1
                continue
            code = int(item.get("code") or 0)
            body_raw = item.get("body")
            try:
                body = json.loads(body_raw) if isinstance(body_raw, str) else body_raw
            except ValueError:
                body = {"_raw": body_raw[:300] if isinstance(body_raw, str) else None}
            out[o["name"]] = {"code": code, "body": body}
            if 200 <= code < 300 and isinstance(body, dict) and not body.get("error"):
                ok += 1
            else:
                fail += 1
        log("fb.batch.done", count=len(ops), ok=ok, fail=fail, elapsed_ms=elapsed_ms)
        return out
