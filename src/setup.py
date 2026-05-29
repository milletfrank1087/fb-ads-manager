"""End-to-end bootstrap: turn a user token + BM id into a system user token.

Goal: do EVERYTHING programmatically that the Graph API allows. Stop only when
a step genuinely requires the Business Manager UI, and print the exact one-click
instruction the user needs to perform before re-running.

The script is idempotent. Re-running it after each manual fix continues from
where it left off:

  1. Proxy verify
  2. Token introspection (debug_token)
  3. Required-scope check (business_management is the gate)
  4. BM identity probe (/{business_id})
  5. App-to-BM link check (/{business_id}/owned_apps)
  6. Ad-account inventory (/{business_id}/owned_ad_accounts + /client_ad_accounts)
  7. Existing system-user lookup (/{business_id}/system_users)
  8. Create system user (if missing)
  9. Assign ad accounts to system user with MANAGE/ADVERTISE/ANALYZE tasks
 10. Install Comments app on the system user (appsecret_proof signed)
 11. Generate the system-user access token (appsecret_proof signed, 60-day)
 12. Verify the new token via /me + /me/adaccounts (using the new token)
 13. Persist token to .env and data/system_user_token.json

Every Graph call goes through the proxy. See AGENTS.md.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import random
import re
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
ENV_PATH = ROOT / ".env"
load_dotenv(ENV_PATH)


SYSTEM_USER_SCOPES = [
    "ads_management",
    "ads_read",
    "business_management",
    "pages_manage_ads",
    "pages_manage_posts",
    "pages_manage_engagement",
    "pages_manage_metadata",
    "pages_read_engagement",
    "pages_read_user_content",
    "pages_show_list",
    "read_insights",
]

REQUIRED_USER_TOKEN_SCOPES_FOR_BM_OPS = {"business_management"}

AD_ACCOUNT_TASKS = ["MANAGE", "ADVERTISE", "ANALYZE"]
PAGE_TASKS = ["MODERATE", "CREATE_CONTENT", "MANAGE", "ADVERTISE"]


def log(event: str, **fields: Any) -> None:
    payload = {"ts": datetime.now(timezone.utc).isoformat(), "event": event}
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False, default=str))


def mask(s: str | None, head: int = 8, tail: int = 4) -> str:
    if not s:
        return "<empty>"
    if len(s) <= head + tail:
        return "*" * len(s)
    return f"{s[:head]}...{s[-tail:]} (len={len(s)})"


def required_env(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        die(f"missing required env var {name} in .env")
    return v


def optional_env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def die(msg: str, *, instruction: str | None = None, exit_code: int = 1) -> None:
    log("setup.blocked", reason=msg)
    print()
    print("=" * 72)
    print("SETUP BLOCKED — manual action required")
    print("=" * 72)
    print(msg)
    if instruction:
        print()
        print(instruction)
    print("=" * 72)
    sys.exit(exit_code)


def appsecret_proof(token: str, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest()


@dataclass
class Cfg:
    user_token: str
    page_token: str
    business_id: str
    app_id: str
    app_secret: str
    target_page_id: str
    system_user_name: str
    proxy_url: str
    graph_version: str
    timeout: int
    min_interval_ms: int


def load_cfg() -> Cfg:
    return Cfg(
        user_token=required_env("FB_USER_ACCESS_TOKEN"),
        page_token=required_env("FB_ACCESS_TOKEN"),
        business_id=required_env("FB_BUSINESS_ID"),
        app_id=required_env("FB_APP_ID"),
        app_secret=required_env("FB_APP_SECRET"),
        target_page_id=optional_env("FB_TARGET_PAGE_ID"),
        system_user_name=optional_env("FB_SYSTEM_USER_NAME", "fb-ads-manager-sysuser"),
        proxy_url=(
            f"http://{quote(required_env('PROXY_USER'), safe='')}:"
            f"{quote(required_env('PROXY_PASS'), safe='')}@"
            f"{required_env('PROXY_HOST')}:{required_env('PROXY_PORT')}"
        ),
        graph_version=optional_env("GRAPH_API_VERSION", "v25.0"),
        timeout=int(optional_env("REQUEST_TIMEOUT_SECONDS", "30")),
        min_interval_ms=int(optional_env("MIN_REQUEST_INTERVAL_MS", "750")),
    )


class Fb:
    def __init__(self, cfg: Cfg, token: str, label: str, sign: bool = True):
        self.cfg = cfg
        self.token = token
        self.label = label
        self.sign = sign
        self._last = 0.0
        self.calls = 0
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.proxies = {"http": cfg.proxy_url, "https": cfg.proxy_url}
        self.session.headers.update(
            {
                "User-Agent": "fb-ads-manager/0.2 (+setup)",
                "Accept": "application/json",
            }
        )
        self.base = f"https://graph.facebook.com/{cfg.graph_version}"

    def _throttle(self) -> None:
        gap = self.cfg.min_interval_ms / 1000.0
        delta = time.time() - self._last
        if delta < gap:
            time.sleep(gap - delta + random.uniform(0, 0.25))
        self._last = time.time()

    def _signed(self, params: dict) -> dict:
        out = dict(params)
        out.setdefault("access_token", self.token)
        if self.sign and self.cfg.app_secret:
            out["appsecret_proof"] = appsecret_proof(out["access_token"], self.cfg.app_secret)
        return out

    def get(self, path: str, params: dict | None = None) -> dict:
        return self._send("GET", path, params=self._signed(params or {}))

    def post(self, path: str, data: dict | None = None) -> dict:
        return self._send("POST", path, data=self._signed(data or {}))

    def delete(self, path: str, params: dict | None = None) -> dict:
        return self._send("DELETE", path, params=self._signed(params or {}))

    def _send(self, method: str, path: str, *, params=None, data=None) -> Any:
        clean = path if path.startswith("/") else f"/{path}"
        url = self.base + clean
        self._throttle()
        self.calls += 1
        masked = {
            k: (mask(v) if "token" in k.lower() or "secret" in k.lower() or "proof" in k.lower() else v)
            for k, v in ((params or data) or {}).items()
        }
        log("fb.request", label=self.label, method=method, path=clean, params=masked, call=self.calls)
        try:
            r = self.session.request(
                method,
                url,
                params=params if method == "GET" else None,
                data=data if method != "GET" else None,
                timeout=self.cfg.timeout,
                allow_redirects=False,
            )
        except requests.RequestException as err:
            log("fb.transport_error", label=self.label, error=str(err))
            return {"error": {"code": -1, "message": f"transport: {err}"}}
        try:
            body = r.json()
        except ValueError:
            body = {"_non_json": r.text[:500]}
        if isinstance(body, dict) and body.get("error"):
            err = body["error"]
            log(
                "fb.api_error",
                label=self.label,
                method=method,
                path=clean,
                status=r.status_code,
                code=err.get("code"),
                subcode=err.get("error_subcode"),
                message=err.get("message"),
            )
        else:
            keys = list(body.keys()) if isinstance(body, dict) else f"array(len={len(body)})"
            log("fb.response.ok", label=self.label, method=method, path=clean, status=r.status_code, body=keys)
        return body


def err_code(body: Any) -> int | None:
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return body["error"].get("code")
    return None


def err_message(body: Any) -> str:
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return body["error"].get("message", "")
    return ""


def verify_proxy(cfg: Cfg) -> dict:
    log("stage", n=1, name="proxy.verify")
    s = requests.Session()
    s.trust_env = False
    s.proxies = {"http": cfg.proxy_url, "https": cfg.proxy_url}
    try:
        r = s.get("https://ipinfo.io/json", timeout=cfg.timeout)
    except requests.RequestException as err:
        die(f"proxy unreachable: {err}")
    if r.status_code != 200:
        die(f"proxy returned HTTP {r.status_code}: {r.text[:200]}")
    info = r.json()
    log("proxy.ok", egress=info.get("ip"), country=info.get("country"))
    return info


def debug_token(client: Fb, target: str, label: str) -> dict:
    raw = client.get("/debug_token", {"input_token": target})
    data = (raw or {}).get("data") if isinstance(raw, dict) else None
    if not isinstance(data, dict):
        die(f"debug_token failed for {label}: {raw}")
    return {
        "label": label,
        "isValid": data.get("is_valid"),
        "type": data.get("type"),
        "userId": data.get("user_id"),
        "scopes": set(data.get("scopes") or []),
        "expiresAt": data.get("expires_at"),
        "dataAccessExpiresAt": data.get("data_access_expires_at"),
    }


def graph_explorer_relink_url(cfg: Cfg) -> str:
    return (
        f"https://developers.facebook.com/tools/explorer/?"
        f"method=GET&path=me&version={cfg.graph_version}&"
        f"select=app_id={cfg.app_id}"
    )


def check_required_scopes(token_info: dict, cfg: Cfg) -> None:
    missing = REQUIRED_USER_TOKEN_SCOPES_FOR_BM_OPS - token_info["scopes"]
    if not missing:
        log("scopes.ok", scopes=sorted(token_info["scopes"]))
        return
    instruction = (
        f"The user token is missing the following scope(s): {sorted(missing)}.\n"
        f"\n"
        f"ONE-TIME UI ACTION (1 minute):\n"
        f"  1. Open Graph API Explorer:\n"
        f"     {graph_explorer_relink_url(cfg)}\n"
        f"  2. Top-right: pick app 'Comments' ({cfg.app_id}), 'User Token'.\n"
        f"  3. Click 'Add a Permission' and check:\n"
        f"        - business_management   (REQUIRED: BM ops)\n"
        f"        - read_insights         (recommended: organic Page analytics)\n"
        f"     (Keep all your existing scopes ticked.)\n"
        f"  4. Click 'Generate Access Token' -> approve the FB dialog.\n"
        f"  5. Copy the new short-lived token.\n"
        f"  6. Convert it to long-lived (this script will do it for you next time;\n"
        f"     or run this curl one-liner, replacing SHORT_TOKEN):\n"
        f"\n"
        f"     curl -G \\\n"
        f"       --data-urlencode 'grant_type=fb_exchange_token' \\\n"
        f"       --data-urlencode 'client_id={cfg.app_id}' \\\n"
        f"       --data-urlencode 'client_secret={cfg.app_secret}' \\\n"
        f"       --data-urlencode 'fb_exchange_token=SHORT_TOKEN' \\\n"
        f"       'https://graph.facebook.com/{cfg.graph_version}/oauth/access_token'\n"
        f"\n"
        f"  7. Paste the resulting access_token into .env as FB_USER_ACCESS_TOKEN.\n"
        f"  8. Re-run: python src\\setup.py"
    )
    die(f"user token missing scopes: {sorted(missing)}", instruction=instruction)


def probe_business(client: Fb, business_id: str) -> dict:
    log("stage", n=4, name="business.identity")
    res = client.get(f"/{business_id}", {"fields": "id,name,verification_status,primary_page,vertical,timezone_id,created_time"})
    if err_code(res):
        if err_code(res) == 100:
            die(
                f"GET /{business_id} returned (#100). The user is not an admin of this BM "
                f"or the BM id is wrong.",
                instruction=(
                    f"Verify FB_BUSINESS_ID={business_id} matches the BM in "
                    f"business.facebook.com -> Business Info -> Business ID. If correct, "
                    f"ensure your user account has Admin role on that BM."
                ),
            )
        die(f"business probe failed: {err_message(res)}")
    log("business.identity.ok", id=res.get("id"), name=res.get("name"), verification=res.get("verification_status"))
    return res


def list_owned_apps(client: Fb, business_id: str) -> list[dict]:
    log("stage", n=5, name="business.owned_apps")
    res = client.get(f"/{business_id}/owned_apps", {"fields": "id,name", "limit": 200})
    if err_code(res):
        log("business.owned_apps.error", code=err_code(res), msg=err_message(res))
        return []
    return res.get("data") or []


def list_owned_ad_accounts(client: Fb, business_id: str) -> list[dict]:
    log("stage", n=6, name="business.owned_ad_accounts")
    fields = "id,account_id,name,account_status,currency,timezone_name,amount_spent,balance,disable_reason"
    res = client.get(f"/{business_id}/owned_ad_accounts", {"fields": fields, "limit": 200})
    out: list[dict] = []
    if err_code(res):
        log("business.owned_ad_accounts.error", code=err_code(res), msg=err_message(res))
    else:
        out.extend(res.get("data") or [])
    res2 = client.get(f"/{business_id}/client_ad_accounts", {"fields": fields, "limit": 200})
    if err_code(res2):
        log("business.client_ad_accounts.error", code=err_code(res2), msg=err_message(res2))
    else:
        out.extend(res2.get("data") or [])
    seen = set()
    dedup = []
    for a in out:
        if a.get("id") in seen:
            continue
        seen.add(a.get("id"))
        dedup.append(a)
    log("business.ad_accounts.found", count=len(dedup))
    return dedup


def list_owned_pages(client: Fb, business_id: str) -> list[dict]:
    log("stage", n=6.5, name="business.owned_pages")
    res = client.get(f"/{business_id}/owned_pages", {"fields": "id,name,category", "limit": 200})
    if err_code(res):
        log("business.owned_pages.error", code=err_code(res), msg=err_message(res))
        return []
    return res.get("data") or []


def list_system_users(client: Fb, business_id: str) -> list[dict]:
    log("stage", n=7, name="business.system_users")
    res = client.get(f"/{business_id}/system_users", {"fields": "id,name,role,access_type", "limit": 200})
    if err_code(res):
        log("business.system_users.error", code=err_code(res), msg=err_message(res))
        return []
    return res.get("data") or []


def find_or_create_system_user(client: Fb, cfg: Cfg) -> dict:
    existing = list_system_users(client, cfg.business_id)
    for u in existing:
        if (u.get("name") or "").lower() == cfg.system_user_name.lower():
            log("system_user.reuse", id=u["id"], name=u.get("name"))
            return u
    log("stage", n=8, name="system_user.create", target_name=cfg.system_user_name)
    res = client.post(
        f"/{cfg.business_id}/system_users",
        {"name": cfg.system_user_name, "role": "EMPLOYEE"},
    )
    if err_code(res):
        die(
            f"could not create system user: {err_message(res)} (code {err_code(res)}).",
            instruction=(
                "If error is 'requires business_management', the token still doesn't have it. "
                "If error is 'Not all businesses have access to system users', your BM may need "
                "to be approved first by Meta. Run the setup again after the BM has system-user "
                "feature enabled (visible at business.facebook.com -> Business Settings -> Users -> "
                "System Users)."
            ),
        )
    sid = res.get("id")
    if not sid:
        die(f"unexpected response when creating system user: {res}")
    log("system_user.created", id=sid)
    return {"id": sid, "name": cfg.system_user_name, "role": "EMPLOYEE"}


def assign_ad_account_to_system_user(client: Fb, cfg: Cfg, sysuser_id: str, ad_account_id: str) -> dict:
    log("stage", n=9, name="system_user.assign_ad_account", ad_account=ad_account_id, sysuser=sysuser_id)
    res = client.post(
        f"/act_{strip_act(ad_account_id)}/assigned_users",
        {
            "user": sysuser_id,
            "tasks": json.dumps(AD_ACCOUNT_TASKS),
            "business": cfg.business_id,
        },
    )
    if err_code(res):
        log("system_user.assign_ad_account.error", code=err_code(res), msg=err_message(res))
    else:
        log("system_user.assign_ad_account.ok", ad_account=ad_account_id, response=res)
    return res


def assign_page_to_system_user(client: Fb, cfg: Cfg, sysuser_id: str, page_id: str) -> dict:
    log("stage", n=9.5, name="system_user.assign_page", page=page_id, sysuser=sysuser_id)
    res = client.post(
        f"/{page_id}/assigned_users",
        {
            "user": sysuser_id,
            "tasks": json.dumps(PAGE_TASKS),
            "business": cfg.business_id,
        },
    )
    if err_code(res):
        log("system_user.assign_page.error", code=err_code(res), msg=err_message(res))
    else:
        log("system_user.assign_page.ok", page=page_id, response=res)
    return res


def strip_act(acct_id: str) -> str:
    return re.sub(r"^act_", "", str(acct_id))


def install_app_on_system_user(client: Fb, cfg: Cfg, sysuser_id: str) -> dict:
    log("stage", n=10, name="system_user.install_app", sysuser=sysuser_id, app=cfg.app_id)
    res = client.post(f"/{sysuser_id}/applications", {"business_app": cfg.app_id})
    if err_code(res):
        if "already" in err_message(res).lower() or err_code(res) == 6087:
            log("system_user.install_app.already_installed")
            return {"success": True, "already_installed": True}
        die(f"install app on system user failed: {err_message(res)} (code {err_code(res)})")
    log("system_user.install_app.ok", response=res)
    return res


def generate_system_user_token(client: Fb, cfg: Cfg, sysuser_id: str) -> str:
    log("stage", n=11, name="system_user.generate_token", sysuser=sysuser_id, scopes=SYSTEM_USER_SCOPES)
    res = client.post(
        f"/{sysuser_id}/access_tokens",
        {
            "business_app": cfg.app_id,
            "scope": ",".join(SYSTEM_USER_SCOPES),
            "set_token_expires_in_60_days": "true",
        },
    )
    if err_code(res):
        die(f"generate system-user token failed: {err_message(res)} (code {err_code(res)})")
    token = (res or {}).get("access_token")
    if not token:
        die(f"unexpected response when generating token: {res}")
    log("system_user.token.generated", token_masked=mask(token))
    return token


def verify_system_user_token(cfg: Cfg, token: str) -> dict:
    log("stage", n=12, name="system_user.verify_token")
    client = Fb(cfg, token, label="sysuser", sign=True)
    me = client.get("/me", {"fields": "id,name"})
    if err_code(me):
        die(f"new system-user token failed /me: {err_message(me)}")
    accts = client.get("/me/adaccounts", {"fields": "id,account_id,name,account_status,currency", "limit": 50})
    pages = client.get("/me/accounts", {"fields": "id,name,tasks", "limit": 50})
    info = client.get(
        "/debug_token",
        {"input_token": token, "access_token": token},
    )
    return {
        "me": me,
        "adaccounts": (accts or {}).get("data") if isinstance(accts, dict) else None,
        "pages": (pages or {}).get("data") if isinstance(pages, dict) else None,
        "tokenInfo": (info or {}).get("data") if isinstance(info, dict) else None,
    }


def persist_token_to_env(token: str) -> None:
    log("stage", n=13, name="persist.token")
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
                "expires_at_estimate": (
                    datetime.now(timezone.utc).timestamp() + 60 * 86400
                ),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    log("persist.token.ok", env=str(ENV_PATH), data=str(out_dir / "system_user_token.json"))


def report(state: dict) -> None:
    print()
    print("=" * 72)
    print("SETUP COMPLETE")
    print("=" * 72)
    print(f"Business: {state['business']['name']} ({state['business']['id']})")
    print(f"  verification: {state['business'].get('verification_status')}")
    print(f"System user: {state['sysuser']['name']} ({state['sysuser']['id']})")
    print(f"Ad accounts assigned: {len(state['assigned_ad_accounts'])}")
    for a in state["assigned_ad_accounts"]:
        print(f"  - {a.get('name')} ({a.get('id')})")
    print(f"Pages assigned: {len(state['assigned_pages'])}")
    for p in state["assigned_pages"]:
        print(f"  - {p.get('name')} ({p.get('id')})")
    print()
    v = state.get("verify", {})
    print("Token verification on the new system-user token:")
    print(f"  /me -> {(v.get('me') or {}).get('name')} ({(v.get('me') or {}).get('id')})")
    print(f"  /me/adaccounts -> {len(v.get('adaccounts') or [])} ad account(s)")
    print(f"  /me/accounts -> {len(v.get('pages') or [])} page(s)")
    ti = v.get("tokenInfo") or {}
    print(f"  token type: {ti.get('type')} expires_at: {ti.get('expires_at')}")
    print(f"  scopes ({len(ti.get('scopes') or [])}):")
    for s in ti.get("scopes") or []:
        print(f"    - {s}")
    print()
    print("Saved to:")
    print("  .env -> FB_SYSTEM_USER_ACCESS_TOKEN=<set>")
    print("  data/system_user_token.json")
    print("=" * 72)


def main() -> int:
    cfg = load_cfg()
    log("setup.start", graph=cfg.graph_version, bm=cfg.business_id, app=cfg.app_id, page=cfg.target_page_id)

    verify_proxy(cfg)

    user_client = Fb(cfg, cfg.user_token, label="user", sign=True)

    log("stage", n=2, name="debug_token")
    user_info = debug_token(user_client, cfg.user_token, "FB_USER_ACCESS_TOKEN")
    log("debug_token.user", user=user_info["userId"], scopes=sorted(user_info["scopes"]))

    log("stage", n=3, name="scope.check")
    check_required_scopes(user_info, cfg)

    business = probe_business(user_client, cfg.business_id)

    owned_apps = list_owned_apps(user_client, cfg.business_id)
    log("owned_apps", count=len(owned_apps), ids=[a.get("id") for a in owned_apps])
    app_in_bm = any(str(a.get("id")) == str(cfg.app_id) for a in owned_apps)
    if not app_in_bm:
        die(
            f"app {cfg.app_id} ('Comments') is not claimed by BM {cfg.business_id}.",
            instruction=(
                "ONE-TIME UI ACTION (30 seconds):\n"
                "  1. Open https://business.facebook.com/settings/apps\n"
                "     (or business.facebook.com -> Business Settings -> Accounts -> Apps)\n"
                "  2. Click 'Add' -> 'Add an App'.\n"
                f"  3. Paste App ID: {cfg.app_id}\n"
                "  4. Confirm.\n"
                "  5. Re-run: python src\\setup.py"
            ),
        )

    ad_accounts = list_owned_ad_accounts(user_client, cfg.business_id)
    pages = list_owned_pages(user_client, cfg.business_id)

    if not ad_accounts:
        die(
            f"BM {cfg.business_id} owns 0 ad accounts visible to this token.",
            instruction=(
                "ONE-TIME UI ACTION (1-2 minutes):\n"
                "  1. Open https://business.facebook.com/settings/ad-accounts\n"
                "  2. Click 'Add' -> 'Claim an Ad Account' (if it's yours) or\n"
                "     'Request Access to an Ad Account' (if it's someone else's).\n"
                "  3. Paste the act_xxxxxxxxx id and confirm.\n"
                "  4. Re-run: python src\\setup.py\n"
                "\n"
                "OR: if you want to just probe an existing account without\n"
                "claiming it into this BM, set FB_AD_ACCOUNT_ID in .env and re-run\n"
                "src\\probe.py (no BM required for that path)."
            ),
        )

    sysuser = find_or_create_system_user(user_client, cfg)

    assigned_ad_accounts = []
    for a in ad_accounts:
        result = assign_ad_account_to_system_user(user_client, cfg, sysuser["id"], a["id"])
        if not err_code(result):
            assigned_ad_accounts.append(a)
        else:
            log("assign.warn", ad_account=a["id"], code=err_code(result), msg=err_message(result))

    assigned_pages = []
    if cfg.target_page_id:
        target_in_owned = next(
            (p for p in pages if str(p.get("id")) == str(cfg.target_page_id)), None
        )
        if not target_in_owned:
            log(
                "page.warn",
                msg=f"target page {cfg.target_page_id} is not owned by BM {cfg.business_id}",
                hint=(
                    "If you want the system user to manage RiseHope, claim the page into "
                    "this BM via business.facebook.com -> Pages -> Add. Skipping page assignment."
                ),
            )
        else:
            result = assign_page_to_system_user(user_client, cfg, sysuser["id"], cfg.target_page_id)
            if not err_code(result):
                assigned_pages.append(target_in_owned)

    install_app_on_system_user(user_client, cfg, sysuser["id"])

    token = generate_system_user_token(user_client, cfg, sysuser["id"])

    persist_token_to_env(token)
    verify = verify_system_user_token(cfg, token)

    report({
        "business": business,
        "sysuser": sysuser,
        "assigned_ad_accounts": assigned_ad_accounts,
        "assigned_pages": assigned_pages,
        "verify": verify,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
