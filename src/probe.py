"""Probe: permissions + rate-limit headers + ad-account inventory.

One script. Verifies the proxy, then runs a small number of batched Graph API
calls to discover:

  1. What permissions each token actually has (via /debug_token).
  2. Which Pages we can manage (and with what task scopes).
  3. Which Ad Accounts we can see, their currency/timezone/funding/business.
  4. Whether ads_management is genuinely usable on the first ad account
     (we read 3 endpoints: campaigns, ads, insights — all batched).
  5. Current x-app-usage, x-business-use-case-usage, x-ad-account-usage values.
  6. What we CAN and CANNOT do for our stated goals (ads + posts + comments).

Output: pretty stdout summary + data/probe_report.json.

All HTTP goes through PROXY_*. NO code path bypasses the proxy.
See AGENTS.md before editing.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")


REQUIRED_PERMS_FOR_FULL_AD_MGMT = {
    "ads_management": "Create / edit / pause campaigns, ad sets, ads (write).",
    "ads_read": "Read insights and ad objects (auto-granted with ads_management).",
    "pages_show_list": "Enumerate Pages on /me/accounts.",
    "pages_read_engagement": "Read posts, comments, reactions on the Page.",
    "pages_manage_engagement": "Like / reply / hide / unhide / delete comments.",
    "pages_manage_posts": "Create / edit / delete posts (organic + dark posts).",
    "pages_manage_metadata": "Block / unblock users on the Page (/{page}/blocked).",
    "pages_read_user_content": "Read user-generated comments (incl. non-page accounts).",
    "business_management": "Access Business Manager assets / system users (optional but helpful).",
    "read_insights": "Page-level + post-level insights.",
    "public_profile": "Granted by default.",
}

RATE_LIMIT_CODES = {4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004}


def _mask(s: str, head: int = 8, tail: int = 4) -> str:
    if not s:
        return "<empty>"
    if len(s) <= head + tail:
        return "*" * len(s)
    return f"{s[:head]}...{s[-tail:]} (len={len(s)})"


def _required(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        sys.exit(f"[probe] missing required env var: {name}")
    return v


def _optional(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _fmt_unix(ts: int | None) -> str:
    if not ts or int(ts) == 0:
        return "never (long-lived / system / never expires)"
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat()


def log(event: str, **fields: Any) -> None:
    payload = {"ts": datetime.now(timezone.utc).isoformat(), "event": event}
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False, default=str))


@dataclass
class FbConfig:
    page_token: str
    user_token: str
    target_page_id: str
    app_id: str
    app_secret: str
    proxy_host: str
    proxy_port: str
    proxy_user: str
    proxy_pass: str
    graph_version: str
    timeout_s: int
    min_interval_ms: int

    @classmethod
    def load(cls) -> "FbConfig":
        return cls(
            page_token=_required("FB_ACCESS_TOKEN"),
            user_token=_optional("FB_USER_ACCESS_TOKEN"),
            target_page_id=_optional("FB_TARGET_PAGE_ID"),
            app_id=_optional("FB_APP_ID"),
            app_secret=_optional("FB_APP_SECRET"),
            proxy_host=_required("PROXY_HOST"),
            proxy_port=_required("PROXY_PORT"),
            proxy_user=_required("PROXY_USER"),
            proxy_pass=_required("PROXY_PASS"),
            graph_version=_optional("GRAPH_API_VERSION", "v25.0"),
            timeout_s=int(_optional("REQUEST_TIMEOUT_SECONDS", "30")),
            min_interval_ms=int(_optional("MIN_REQUEST_INTERVAL_MS", "750")),
        )

    def proxy_url(self) -> str:
        return (
            f"http://{quote(self.proxy_user, safe='')}:"
            f"{quote(self.proxy_pass, safe='')}@{self.proxy_host}:{self.proxy_port}"
        )

    def graph_base(self) -> str:
        return f"https://graph.facebook.com/{self.graph_version}"

    def public_summary(self) -> dict:
        return {
            "graphApiVersion": self.graph_version,
            "proxy": f"{self.proxy_host}:{self.proxy_port}",
            "proxyUser": _mask(self.proxy_user, 4, 2),
            "fbAccessToken": _mask(self.page_token),
            "fbUserAccessToken": _mask(self.user_token) if self.user_token else "<not set>",
            "fbTargetPageId": self.target_page_id or "<not set>",
            "fbAppId": self.app_id or "<not set>",
        }


@dataclass
class UsageState:
    app: dict | None = None
    business: dict | None = None
    ad_account: dict | None = None
    page: dict | None = None
    rate_limited_until: float = 0.0
    samples: list[dict] = field(default_factory=list)

    def capture(self, response_headers: dict, where: str) -> None:
        sample = {"where": where, "ts": datetime.now(timezone.utc).isoformat()}
        for h_key, attr in (
            ("x-app-usage", "app"),
            ("x-business-use-case-usage", "business"),
            ("x-ad-account-usage", "ad_account"),
            ("x-page-usage", "page"),
        ):
            raw = response_headers.get(h_key)
            if not raw:
                continue
            try:
                parsed = json.loads(raw) if isinstance(raw, str) else raw
            except (ValueError, TypeError):
                continue
            setattr(self, attr, parsed)
            sample[attr] = parsed
        if len(sample) > 2:
            self.samples.append(sample)


class FbClient:
    """Proxied Graph API client with throttle + batch + usage capture.

    Every request flows through PROXY_*. trust_env=False so OS proxies cannot
    interfere. No GET/POST/DELETE path skips the proxy.
    """

    def __init__(self, cfg: FbConfig, token: str, label: str, usage: UsageState):
        self.cfg = cfg
        self.token = token
        self.label = label
        self.usage = usage
        self._last_request = 0.0
        self.call_count = 0
        self.session = requests.Session()
        self.session.trust_env = False
        proxy = cfg.proxy_url()
        self.session.proxies = {"http": proxy, "https": proxy}
        self.session.headers.update(
            {
                "User-Agent": "fb-ads-manager/0.1 (+probe)",
                "Accept": "application/json",
            }
        )

    def _throttle(self) -> None:
        min_gap_s = self.cfg.min_interval_ms / 1000.0
        elapsed = time.time() - self._last_request
        if elapsed < min_gap_s:
            sleep_for = (min_gap_s - elapsed) + random.uniform(0, 0.25)
            time.sleep(sleep_for)
        self._last_request = time.time()

    def get(self, path: str, params: dict | None = None) -> dict:
        params = dict(params or {})
        params.setdefault("access_token", self.token)
        return self._send("GET", path, params=params, where=f"get:{path}")

    def post(self, path: str, data: dict | None = None) -> dict:
        data = dict(data or {})
        data.setdefault("access_token", self.token)
        return self._send("POST", path, data=data, where=f"post:{path}")

    def batch(self, ops: list[dict]) -> list[dict]:
        """Send up to 50 ops in one HTTP request.

        Each op: {method, relative_url, body?, name?}. Token is auto-added to
        the OUTER call; sub-ops inherit the auth context.
        """
        if not ops:
            return []
        if len(ops) > 50:
            return self.batch(ops[:50]) + self.batch(ops[50:])

        def encode(op: dict) -> dict:
            sub = {"method": op["method"], "relative_url": op["relative_url"].lstrip("/")}
            if op.get("body"):
                sub["body"] = op["body"]
            if op.get("name"):
                sub["name"] = op["name"]
            return sub

        payload = {
            "access_token": self.token,
            "include_headers": "false",
            "batch": json.dumps([encode(op) for op in ops]),
        }
        log("fb.batch.start", label=self.label, count=len(ops), methods=[o["method"] for o in ops])
        started = time.time()
        body = self._send("POST", "/", data=payload, where=f"batch:{len(ops)}")
        elapsed_ms = int((time.time() - started) * 1000)
        parsed = body if isinstance(body, list) else []
        if not parsed and isinstance(body, dict) and body.get("error"):
            log("fb.batch.outer_error", error=body.get("error"), elapsed_ms=elapsed_ms)
            return [{"_outer_error": body.get("error"), "_op": op} for op in ops]
        succeeded = sum(1 for r in parsed if r and 200 <= int(r.get("code", 0)) < 300)
        failed = sum(1 for r in parsed if not r or int(r.get("code", 0)) >= 400)
        log("fb.batch.done", count=len(ops), succeeded=succeeded, failed=failed, elapsed_ms=elapsed_ms)
        return parsed

    def _send(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        data: dict | None = None,
        where: str = "",
    ) -> Any:
        clean = path if path.startswith("/") else f"/{path}"
        url = self.cfg.graph_base() + clean
        self._throttle()
        self.call_count += 1
        masked = {
            k: (_mask(v) if "token" in k.lower() or "secret" in k.lower() else v)
            for k, v in ((params or data) or {}).items()
        }
        log("fb.request", label=self.label, method=method, path=clean, params=masked, call=self.call_count)
        try:
            resp = self.session.request(
                method,
                url,
                params=params if method == "GET" else None,
                data=data if method != "GET" else None,
                timeout=self.cfg.timeout_s,
                allow_redirects=False,
            )
        except requests.RequestException as err:
            log(
                "fb.transport_error",
                label=self.label,
                method=method,
                path=clean,
                error=str(err),
                error_type=type(err).__name__,
            )
            return {"error": {"code": -1, "message": f"transport: {err}"}}
        self.usage.capture(resp.headers, where or f"{method}:{clean}")
        try:
            body = resp.json()
        except ValueError:
            body = {"_non_json": resp.text[:500]}
        if isinstance(body, dict) and body.get("error"):
            err = body["error"]
            code = err.get("code")
            if code in RATE_LIMIT_CODES:
                self.usage.rate_limited_until = time.time() + 60 * 60
            log(
                "fb.api_error",
                label=self.label,
                method=method,
                path=clean,
                status=resp.status_code,
                code=code,
                subcode=err.get("error_subcode"),
                message=err.get("message"),
            )
        else:
            keys = list(body.keys()) if isinstance(body, dict) else f"array(len={len(body)})"
            log(
                "fb.response.ok",
                label=self.label,
                method=method,
                path=clean,
                status=resp.status_code,
                body=keys,
            )
        return body


def verify_proxy(cfg: FbConfig) -> dict:
    log("proxy.verify.start", **cfg.public_summary())
    session = requests.Session()
    session.trust_env = False
    proxy = cfg.proxy_url()
    session.proxies = {"http": proxy, "https": proxy}
    try:
        r = session.get("https://ipinfo.io/json", timeout=cfg.timeout_s)
    except requests.RequestException as err:
        log("proxy.verify.transport_error", error=str(err), error_type=type(err).__name__)
        sys.exit("[probe] proxy unreachable — fix PROXY_* before running again")
    if r.status_code != 200:
        log("proxy.verify.http_error", status=r.status_code, body=r.text[:300])
        sys.exit(f"[probe] proxy returned HTTP {r.status_code}")
    info = r.json()
    out = {
        "egressIp": info.get("ip"),
        "country": info.get("country"),
        "region": info.get("region"),
        "city": info.get("city"),
        "org": info.get("org"),
    }
    log("proxy.verify.ok", **out)
    return out


def parse_batch_body(item: dict) -> Any:
    """Sub-op response bodies come back as JSON strings. Parse safely."""
    if not item:
        return None
    body = item.get("body")
    if body is None:
        return item
    if isinstance(body, str):
        try:
            return json.loads(body)
        except ValueError:
            return {"_raw": body[:500]}
    return body


def debug_token(client: FbClient, target_token: str, label: str) -> dict:
    raw = client.get(
        "/debug_token",
        {"input_token": target_token, "access_token": client.token},
    )
    data = (raw or {}).get("data") if isinstance(raw, dict) else None
    if not isinstance(data, dict):
        return {"label": label, "error": raw}
    return {
        "label": label,
        "isValid": data.get("is_valid"),
        "type": data.get("type"),
        "appId": data.get("app_id"),
        "application": data.get("application"),
        "userId": data.get("user_id"),
        "profileId": data.get("profile_id"),
        "expiresAt": _fmt_unix(data.get("expires_at")),
        "dataAccessExpiresAt": _fmt_unix(data.get("data_access_expires_at")),
        "issuedAt": _fmt_unix(data.get("issued_at")),
        "scopes": sorted(data.get("scopes") or []),
        "granularScopes": data.get("granular_scopes") or [],
    }


def assess_capabilities(scopes: set[str], pages: list[dict], ad_accounts: list[dict]) -> dict:
    def has(*needed: str) -> dict:
        missing = [p for p in needed if p not in scopes]
        return {"ok": not missing, "missing": missing}
    can_manage_ads = has("ads_management")
    can_read_ads = has("ads_read")
    can_read_page_comments = has("pages_read_engagement")
    can_moderate_comments = has("pages_manage_engagement")
    can_manage_posts = has("pages_manage_posts")
    can_block_users = has("pages_manage_metadata")
    can_read_user_content = has("pages_read_user_content")
    can_list_pages = has("pages_show_list")
    return {
        "fullAdManagement": {
            **can_manage_ads,
            "note": "Without ads_management you can read insights with ads_read but not create/edit/pause campaigns, ad sets, or ads.",
            "adAccountsVisible": len(ad_accounts),
        },
        "readAdInsights": can_read_ads,
        "readPageContent": can_read_page_comments,
        "moderateComments": {
            **can_moderate_comments,
            "note": "Required for like / reply / hide / unhide / delete actions on comments.",
        },
        "managePosts": can_manage_posts,
        "blockUsers": can_block_users,
        "readUserGeneratedContent": can_read_user_content,
        "enumeratePages": can_list_pages,
        "pagesVisible": [
            {"id": p.get("id"), "name": p.get("name"), "tasks": p.get("tasks") or []}
            for p in pages
        ],
    }


def main() -> int:
    cfg = FbConfig.load()
    log("probe.start", **cfg.public_summary())

    proxy_result = verify_proxy(cfg)

    usage = UsageState()
    page_client = FbClient(cfg, cfg.page_token, "page", usage)
    user_client = (
        FbClient(cfg, cfg.user_token, "user", usage) if cfg.user_token else None
    )

    report: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "settings": cfg.public_summary(),
        "proxy": proxy_result,
        "tokens": {},
        "page": None,
        "pages": [],
        "businesses": [],
        "adAccounts": [],
        "adManagementSmokeTest": None,
        "usageHeaders": None,
        "capabilities": None,
        "callCounts": {},
        "errors": [],
    }

    report["tokens"]["pageToken"] = debug_token(page_client, cfg.page_token, "FB_ACCESS_TOKEN (page)")
    if user_client:
        report["tokens"]["userToken"] = debug_token(user_client, cfg.user_token, "FB_USER_ACCESS_TOKEN (user)")

    page_scopes = set(report["tokens"]["pageToken"].get("scopes") or [])
    user_scopes = (
        set(report["tokens"].get("userToken", {}).get("scopes") or []) if user_client else set()
    )
    all_scopes = page_scopes | user_scopes

    if user_client:
        ops = [
            {"method": "GET", "relative_url": "me?fields=id,name", "name": "me"},
            {
                "method": "GET",
                "relative_url": (
                    "me/accounts?fields=id,name,category,tasks,fan_count&limit=200"
                ),
                "name": "pages",
            },
            {
                "method": "GET",
                "relative_url": (
                    "me/adaccounts?fields=id,account_id,name,account_status,currency,"
                    "timezone_name,business{id,name},funding_source_details,"
                    "amount_spent,balance,disable_reason&limit=200"
                ),
                "name": "adaccounts",
            },
            {
                "method": "GET",
                "relative_url": "me/businesses?fields=id,name,verification_status&limit=200",
                "name": "businesses",
            },
        ]
        if cfg.target_page_id:
            ops.append({
                "method": "GET",
                "relative_url": (
                    f"{cfg.target_page_id}?fields=id,name,category,fan_count,"
                    "followers_count,link,verification_status,can_post"
                ),
                "name": "targetPage",
            })

        batch_results = user_client.batch(ops)
        by_name = {op["name"]: parse_batch_body(r) for op, r in zip(ops, batch_results)}

        report["me"] = by_name.get("me")
        report["pages"] = (by_name.get("pages") or {}).get("data") or []
        report["adAccounts"] = (by_name.get("adaccounts") or {}).get("data") or []
        report["businesses"] = (by_name.get("businesses") or {}).get("data") or []
        report["page"] = by_name.get("targetPage")

        for name, body in by_name.items():
            if isinstance(body, dict) and body.get("error"):
                report["errors"].append({"step": name, "error": body["error"]})
    else:
        report["errors"].append(
            {"step": "user-token-required", "error": "FB_USER_ACCESS_TOKEN not set — cannot enumerate adaccounts/pages"}
        )

    fallback_acct = _optional("FB_AD_ACCOUNT_ID")
    if not report["adAccounts"] and fallback_acct and user_client:
        acct_id = fallback_acct if fallback_acct.startswith("act_") else f"act_{fallback_acct}"
        log("probe.fallback_ad_account", acct_id=acct_id)
        meta = user_client.get(
            f"/{acct_id}",
            {
                "fields": (
                    "id,account_id,name,account_status,currency,timezone_name,"
                    "business{id,name},funding_source_details,amount_spent,balance,"
                    "disable_reason"
                )
            },
        )
        if isinstance(meta, dict) and not meta.get("error"):
            report["adAccounts"] = [meta]

    if report["adAccounts"] and user_client:
        first = report["adAccounts"][0]
        acct_id = first.get("id")
        ops = [
            {
                "method": "GET",
                "relative_url": (
                    f"{acct_id}/campaigns?fields=id,name,objective,status,"
                    "effective_status,daily_budget,lifetime_budget&limit=5"
                ),
                "name": "campaigns",
            },
            {
                "method": "GET",
                "relative_url": (
                    f"{acct_id}/ads?fields=id,name,status,effective_status,"
                    "campaign{id,name},adset{id,name},creative{id,object_story_id,"
                    "effective_object_story_id,thumbnail_url}&limit=5"
                ),
                "name": "ads",
            },
            {
                "method": "GET",
                "relative_url": (
                    f"{acct_id}/insights?fields=spend,impressions,clicks,reach,"
                    "actions&date_preset=last_7d&level=account&limit=1"
                ),
                "name": "insights",
            },
        ]
        smoke_results = user_client.batch(ops)
        smoke = {op["name"]: parse_batch_body(r) for op, r in zip(ops, smoke_results)}
        report["adManagementSmokeTest"] = {
            "adAccount": {"id": acct_id, "name": first.get("name")},
            "campaigns": smoke.get("campaigns"),
            "ads": smoke.get("ads"),
            "insights": smoke.get("insights"),
        }

    report["usageHeaders"] = {
        "app": usage.app,
        "business": usage.business,
        "adAccount": usage.ad_account,
        "page": usage.page,
        "samples": usage.samples[-5:],
    }

    pages = report["pages"] or ([report["page"]] if report["page"] else [])
    report["capabilities"] = assess_capabilities(all_scopes, pages, report["adAccounts"])
    report["scopesPresent"] = sorted(all_scopes)
    report["scopesMissingForOurGoals"] = sorted(
        set(REQUIRED_PERMS_FOR_FULL_AD_MGMT) - all_scopes
    )
    report["scopeRequirements"] = REQUIRED_PERMS_FOR_FULL_AD_MGMT

    report["callCounts"] = {
        "page": page_client.call_count,
        "user": user_client.call_count if user_client else 0,
        "total": page_client.call_count + (user_client.call_count if user_client else 0),
    }

    out_dir = ROOT / "data"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / "probe_report.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    log("probe.written", path=str(out_path))

    print_summary(report)
    return 0


def print_summary(r: dict) -> None:
    print("\n" + "=" * 72)
    print("PROBE SUMMARY")
    print("=" * 72)
    print(f"Graph API:      {r['settings']['graphApiVersion']}")
    print(f"Proxy egress:   {r['proxy'].get('egressIp')} ({r['proxy'].get('country')}/{r['proxy'].get('city')})")
    print(f"FB calls used:  {r['callCounts']['total']} (proxy-only)")
    print()
    for label, t in r["tokens"].items():
        print(f"[{label}]")
        if "error" in t:
            print(f"  ERROR: {t['error']}")
            continue
        print(f"  valid={t.get('isValid')}  type={t.get('type')}  app={t.get('application')}({t.get('appId')})")
        print(f"  user={t.get('userId')}  profile={t.get('profileId')}")
        print(f"  expires:      {t.get('expiresAt')}")
        print(f"  data-access:  {t.get('dataAccessExpiresAt')}")
        print(f"  scopes ({len(t.get('scopes', []))}):")
        for s in t.get("scopes", []):
            print(f"    - {s}")
    print()
    if r.get("page"):
        p = r["page"]
        print(f"[Target Page]  {p.get('name')} ({p.get('id')})  fans={p.get('fan_count')}  tasks={p.get('tasks')}")
    print()
    print(f"Pages visible:    {len(r.get('pages') or [])}")
    for p in (r.get("pages") or [])[:10]:
        print(f"  - {p.get('name')} ({p.get('id')})  tasks={p.get('tasks')}")
    print()
    print(f"Ad accounts:     {len(r.get('adAccounts') or [])}")
    for a in (r.get("adAccounts") or [])[:10]:
        biz = (a.get("business") or {}).get("name") or "(no BM)"
        print(
            f"  - {a.get('name')} ({a.get('id')})  status={a.get('account_status')}  "
            f"currency={a.get('currency')}  business={biz}"
        )
    print()
    print(f"Businesses:      {len(r.get('businesses') or [])}")
    for b in (r.get("businesses") or [])[:10]:
        print(f"  - {b.get('name')} ({b.get('id')})  verification={b.get('verification_status')}")
    print()
    smoke = r.get("adManagementSmokeTest")
    if smoke:
        print(f"[Smoke test on {smoke['adAccount']['name']} ({smoke['adAccount']['id']})]")
        for k in ("campaigns", "ads", "insights"):
            v = smoke.get(k)
            if isinstance(v, dict) and v.get("error"):
                print(f"  {k}: ERROR code={v['error'].get('code')} msg={v['error'].get('message')}")
            elif isinstance(v, dict) and "data" in v:
                print(f"  {k}: ok, {len(v['data'])} row(s)")
            else:
                print(f"  {k}: {type(v).__name__}")
    print()
    print("Capabilities for our goals:")
    caps = r.get("capabilities") or {}
    for k, v in caps.items():
        if k == "pagesVisible":
            continue
        if isinstance(v, dict) and "ok" in v:
            status = "OK " if v["ok"] else "NO "
            missing = f"  missing: {v['missing']}" if v.get("missing") else ""
            note = f"  ({v['note']})" if v.get("note") else ""
            print(f"  [{status}] {k}{missing}{note}")
    print()
    missing = r.get("scopesMissingForOurGoals") or []
    if missing:
        print(f"Permissions MISSING for full goals ({len(missing)}):")
        for s in missing:
            print(f"  - {s}  ({REQUIRED_PERMS_FOR_FULL_AD_MGMT.get(s, '')})")
    else:
        print("All target permissions present.")
    print()
    uh = r.get("usageHeaders") or {}
    print("Rate-limit headers seen during this probe:")
    print(f"  x-app-usage:                {uh.get('app')}")
    print(f"  x-business-use-case-usage:  {uh.get('business')}")
    print(f"  x-ad-account-usage:         {uh.get('adAccount')}")
    print(f"  x-page-usage:               {uh.get('page')}")
    print()
    if r.get("errors"):
        print("Errors during probe:")
        for e in r["errors"]:
            print(f"  - {e}")
    print("=" * 72)
    print(f"Full JSON written to: data/probe_report.json")
    print("=" * 72)


if __name__ == "__main__":
    sys.exit(main())
