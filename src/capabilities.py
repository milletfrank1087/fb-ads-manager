"""Exhaustive capability probe for our system-user token + page token.

Goal: enumerate EVERY surface we can read/write so we can plan the dashboard.

Coverage areas:
  A. Ad accounts (system-user token, per active account):
     - account meta, capabilities flag list, balance, spend_cap, io_number
     - campaigns, ad sets, ads with field expansion
     - insights at account level + breakdowns (placement, device, age, gender, country)
     - custom audiences, lookalikes, saved audiences
     - pixels/datasets, custom conversions
     - lead gen forms
     - saved creatives, ad images, ad videos
     - automated rules
     - account activities (audit log)
     - reach estimate + delivery estimate
     - targeting browse / search
     - async report job (create + immediate poll)

  B. Pages (page token for RiseHope while it's not in BM):
     - page meta (full), insights, recent posts with engagement
     - post comments sample + replies
     - blocked users, page roles, CTA, conversations (inbox)

  C. Business Manager (system-user token at BM scope):
     - business meta, owned ad accounts/pages/pixels/catalogs/apps/system_users
     - pending invitations, agreements

Every HTTP call is proxied (trust_env=False) and signed with appsecret_proof.
Throttled at MIN_REQUEST_INTERVAL_MS. Output: data/capabilities_report.json.
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
from typing import Any
from urllib.parse import quote

import requests
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")


def _req(name: str) -> str:
    v = (os.environ.get(name) or "").strip()
    if not v:
        sys.exit(f"missing env: {name}")
    return v


def _opt(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _mask(s: str, head: int = 8, tail: int = 4) -> str:
    if not s:
        return "<empty>"
    if len(s) <= head + tail:
        return "*" * len(s)
    return f"{s[:head]}...{s[-tail:]} (len={len(s)})"


def _log(event: str, **fields: Any) -> None:
    payload = {"ts": datetime.now(timezone.utc).isoformat(), "event": event}
    payload.update(fields)
    print(json.dumps(payload, ensure_ascii=False, default=str))


def _proof(token: str, secret: str) -> str:
    return hmac.new(secret.encode(), token.encode(), hashlib.sha256).hexdigest()


@dataclass
class Cfg:
    sysuser_token: str
    page_token: str
    page_id: str
    business_id: str
    app_secret: str
    proxy: str
    graph_base: str
    timeout_s: int
    min_gap_s: float

    @classmethod
    def load(cls) -> "Cfg":
        proxy = (
            f"http://{quote(_req('PROXY_USER'), safe='')}:"
            f"{quote(_req('PROXY_PASS'), safe='')}@"
            f"{_req('PROXY_HOST')}:{_req('PROXY_PORT')}"
        )
        version = _opt("GRAPH_API_VERSION", "v25.0")
        return cls(
            sysuser_token=_req("FB_SYSTEM_USER_ACCESS_TOKEN"),
            page_token=_opt("FB_ACCESS_TOKEN"),
            page_id=_opt("FB_TARGET_PAGE_ID"),
            business_id=_req("FB_BUSINESS_ID"),
            app_secret=_req("FB_APP_SECRET"),
            proxy=proxy,
            graph_base=f"https://graph.facebook.com/{version}",
            timeout_s=int(_opt("REQUEST_TIMEOUT_SECONDS", "30")),
            min_gap_s=int(_opt("MIN_REQUEST_INTERVAL_MS", "750")) / 1000.0,
        )


@dataclass
class Usage:
    app: dict | None = None
    business_use_case: dict | None = None
    ad_account: dict | None = None
    page: dict | None = None
    samples: list[dict] = field(default_factory=list)

    def capture(self, hdrs: dict, where: str) -> None:
        sample: dict[str, Any] = {"where": where, "ts": datetime.now(timezone.utc).isoformat()}
        for h, attr in (
            ("x-app-usage", "app"),
            ("x-business-use-case-usage", "business_use_case"),
            ("x-ad-account-usage", "ad_account"),
            ("x-page-usage", "page"),
        ):
            raw = hdrs.get(h)
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


class Fb:
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
        self.s.headers.update({"User-Agent": "fb-ads-manager/0.3 (+capabilities)"})

    def _wait(self) -> None:
        gap = time.time() - self._last
        if gap < self.cfg.min_gap_s:
            time.sleep(self.cfg.min_gap_s - gap + random.uniform(0, 0.2))
        self._last = time.time()

    def _send(self, method: str, path: str, *, params: dict | None = None, data: dict | None = None) -> Any:
        clean = path if path.startswith("/") else f"/{path}"
        url = self.cfg.graph_base + clean
        self._wait()
        self.calls += 1
        kwargs: dict[str, Any] = {"timeout": self.cfg.timeout_s, "allow_redirects": False}
        if method == "GET":
            p = dict(params or {})
            p.setdefault("access_token", self.token)
            p.setdefault("appsecret_proof", _proof(self.token, self.cfg.app_secret))
            kwargs["params"] = p
        else:
            d = dict(data or {})
            d.setdefault("access_token", self.token)
            d.setdefault("appsecret_proof", _proof(self.token, self.cfg.app_secret))
            kwargs["data"] = d
        try:
            r = self.s.request(method, url, **kwargs)
        except requests.RequestException as err:
            _log("fb.transport_error", label=self.label, method=method, path=clean, err=str(err))
            return {"error": {"code": -1, "message": f"transport: {err}"}}
        self.usage.capture(r.headers, where=f"{method}:{clean}")
        try:
            body = r.json()
        except ValueError:
            body = {"_non_json": r.text[:300]}
        if isinstance(body, dict) and body.get("error"):
            err = body["error"]
            _log(
                "fb.api_error",
                label=self.label,
                path=clean,
                code=err.get("code"),
                subcode=err.get("error_subcode"),
                msg=(err.get("message") or "")[:160],
            )
        return body

    def get(self, path: str, params: dict | None = None) -> Any:
        return self._send("GET", path, params=params)

    def post(self, path: str, data: dict | None = None) -> Any:
        return self._send("POST", path, data=data)

    def batch(self, ops: list[dict]) -> dict[str, Any]:
        if not ops:
            return {}
        if len(ops) > 50:
            a = self.batch(ops[:50])
            b = self.batch(ops[50:])
            return {**a, **b}
        payload = {
            "access_token": self.token,
            "appsecret_proof": _proof(self.token, self.cfg.app_secret),
            "include_headers": "false",
            "batch": json.dumps(
                [
                    {"method": o["method"], "relative_url": o["relative_url"].lstrip("/"), "name": o["name"]}
                    for o in ops
                ]
            ),
        }
        _log("fb.batch.start", label=self.label, count=len(ops), names=[o["name"] for o in ops])
        t0 = time.time()
        raw = self._send("POST", "/", data=payload)
        elapsed_ms = int((time.time() - t0) * 1000)
        out: dict[str, Any] = {}
        if isinstance(raw, dict) and raw.get("error"):
            _log("fb.batch.outer_error", error=raw["error"], elapsed_ms=elapsed_ms)
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
        _log("fb.batch.done", count=len(ops), ok=ok, fail=fail, elapsed_ms=elapsed_ms)
        return out


def _summarize_list(label: str, body: Any, fields: list[str]) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {"label": label, "ok": False, "error": "non-dict response"}
    if body.get("error"):
        return {"label": label, "ok": False, "error": body["error"]}
    data = body.get("data") or []
    return {
        "label": label,
        "ok": True,
        "count": len(data),
        "has_more": bool((body.get("paging") or {}).get("next")),
        "sample": [{k: row.get(k) for k in fields if k in row} for row in data[:3]],
    }


def probe_business_manager(fb: Fb, bm_id: str) -> dict:
    """One batched probe of BM-level inventory."""
    ops = [
        {"name": "bm", "method": "GET", "relative_url": f"{bm_id}?fields=id,name,verification_status,primary_page,is_disabled_for_integrity_reasons,timezone_id,vertical,two_factor_type"},
        {"name": "owned_ad_accounts", "method": "GET", "relative_url": f"{bm_id}/owned_ad_accounts?fields=id,name,account_status,currency,timezone_name,age,amount_spent,balance,disable_reason,owner&limit=50"},
        {"name": "client_ad_accounts", "method": "GET", "relative_url": f"{bm_id}/client_ad_accounts?fields=id,name,account_status,currency&limit=50"},
        {"name": "owned_pages", "method": "GET", "relative_url": f"{bm_id}/owned_pages?fields=id,name,category,fan_count,followers_count&limit=50"},
        {"name": "client_pages", "method": "GET", "relative_url": f"{bm_id}/client_pages?fields=id,name,category&limit=50"},
        {"name": "owned_pixels", "method": "GET", "relative_url": f"{bm_id}/owned_pixels?fields=id,name,code,last_fired_time,creation_time,is_unavailable,enable_automatic_matching&limit=50"},
        {"name": "owned_product_catalogs", "method": "GET", "relative_url": f"{bm_id}/owned_product_catalogs?fields=id,name,product_count,vertical&limit=20"},
        {"name": "owned_apps", "method": "GET", "relative_url": f"{bm_id}/owned_apps?fields=id,name,category&limit=20"},
        {"name": "system_users", "method": "GET", "relative_url": f"{bm_id}/system_users?fields=id,name,created_by,role&limit=20"},
        {"name": "pending_owned_ad_accounts", "method": "GET", "relative_url": f"{bm_id}/pending_owned_ad_accounts?fields=id,name&limit=20"},
        {"name": "pending_owned_pages", "method": "GET", "relative_url": f"{bm_id}/pending_owned_pages?fields=id,name&limit=20"},
        {"name": "agencies", "method": "GET", "relative_url": f"{bm_id}/agencies?fields=id,name,permitted_roles&limit=20"},
        {"name": "business_users", "method": "GET", "relative_url": f"{bm_id}/business_users?fields=id,name,role,email&limit=20"},
        {"name": "instagram_business_accounts", "method": "GET", "relative_url": f"{bm_id}/instagram_business_accounts?fields=id,username,followers_count&limit=20"},
    ]
    return fb.batch(ops)


def probe_ad_account(fb: Fb, acct_id: str) -> dict:
    """Per-account batched probe — covers all surfaces we'd use in the dashboard."""
    a = acct_id
    ops = [
        {"name": "account", "method": "GET", "relative_url": f"{a}?fields=id,account_id,name,account_status,disable_reason,currency,timezone_name,timezone_offset_hours_utc,age,amount_spent,balance,spend_cap,business_country_code,business{{id,name}},funding_source,funding_source_details,io_number,owner,capabilities,min_daily_budget,end_advertiser_name,offsite_pixels_tos_accepted,tax_id_status"},
        {"name": "campaigns", "method": "GET", "relative_url": f"{a}/campaigns?fields=id,name,objective,buying_type,status,effective_status,configured_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,special_ad_categories,start_time,stop_time,created_time,updated_time,can_use_spend_cap&limit=5"},
        {"name": "adsets", "method": "GET", "relative_url": f"{a}/adsets?fields=id,name,status,effective_status,campaign{{id,name}},optimization_goal,billing_event,bid_amount,bid_strategy,daily_budget,lifetime_budget,start_time,end_time,targeting,promoted_object,attribution_spec,destination_type,pacing_type&limit=5"},
        {"name": "ads", "method": "GET", "relative_url": f"{a}/ads?fields=id,name,status,effective_status,campaign{{id,name}},adset{{id,name,optimization_goal}},creative{{id,name,object_story_id,effective_object_story_id,thumbnail_url,image_url,body,title,call_to_action_type,instagram_actor_id,asset_feed_spec}},tracking_specs,conversion_specs,issues_info&limit=5"},
        {"name": "insights_account_7d", "method": "GET", "relative_url": f"{a}/insights?fields=spend,impressions,clicks,reach,frequency,ctr,cpc,cpm,cpp,actions,action_values,cost_per_action_type,purchase_roas,website_purchase_roas&date_preset=last_7d&level=account&limit=1"},
        {"name": "insights_breakdown_placement_7d", "method": "GET", "relative_url": f"{a}/insights?fields=spend,impressions,clicks&breakdowns=publisher_platform,platform_position&date_preset=last_7d&level=account&limit=20"},
        {"name": "insights_breakdown_age_gender_7d", "method": "GET", "relative_url": f"{a}/insights?fields=spend,impressions,clicks&breakdowns=age,gender&date_preset=last_7d&level=account&limit=20"},
        {"name": "insights_breakdown_device_7d", "method": "GET", "relative_url": f"{a}/insights?fields=spend,impressions,clicks&breakdowns=device_platform,impression_device&date_preset=last_7d&level=account&limit=20"},
        {"name": "insights_breakdown_country_7d", "method": "GET", "relative_url": f"{a}/insights?fields=spend,impressions,clicks,actions&breakdowns=country&date_preset=last_7d&level=account&limit=30"},
        {"name": "customaudiences", "method": "GET", "relative_url": f"{a}/customaudiences?fields=id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,retention_days,rule,external_event_source{{id,name}},lookalike_spec,data_source,time_updated&limit=10"},
        {"name": "saved_audiences", "method": "GET", "relative_url": f"{a}/saved_audiences?fields=id,name,description,targeting&limit=10"},
        {"name": "adspixels", "method": "GET", "relative_url": f"{a}/adspixels?fields=id,name,code,last_fired_time,is_created_by_business,enable_automatic_matching,creation_time&limit=10"},
        {"name": "customconversions", "method": "GET", "relative_url": f"{a}/customconversions?fields=id,name,rule,description,event_source_type,event_source_id,creation_time,is_archived,offline_conversion_data_set_id,custom_event_type&limit=10"},
        {"name": "adimages", "method": "GET", "relative_url": f"{a}/adimages?fields=id,hash,name,url,width,height,permalink_url,creatives&limit=5"},
        {"name": "advideos", "method": "GET", "relative_url": f"{a}/advideos?fields=id,title,source,created_time,length,picture&limit=5"},
        {"name": "adcreatives", "method": "GET", "relative_url": f"{a}/adcreatives?fields=id,name,object_story_id,thumbnail_url,call_to_action_type,instagram_actor_id&limit=5"},
        {"name": "adrules_library", "method": "GET", "relative_url": f"{a}/adrules_library?fields=id,name,status,created_time,schedule,trigger,execution_spec&limit=10"},
        {"name": "activities", "method": "GET", "relative_url": f"{a}/activities?fields=event_type,event_time,actor_id,actor_name,object_id,object_name,extra_data&limit=10"},
        {"name": "ads_volume", "method": "GET", "relative_url": f"{a}/ads_volume?limit=1"},
        {"name": "matched_search_applications", "method": "GET", "relative_url": f"{a}/matched_search_applications?limit=1"},
        {"name": "minimum_budgets", "method": "GET", "relative_url": f"{a}/minimum_budgets?limit=5"},
        {"name": "asyncadrequestsets", "method": "GET", "relative_url": f"{a}/asyncadrequestsets?limit=5"},
        {"name": "delivery_estimate", "method": "GET", "relative_url": f"{a}/delivery_estimate?optimization_goal=LINK_CLICKS&targeting_spec=" + quote(json.dumps({"geo_locations": {"countries": ["US"]}, "age_min": 18, "age_max": 65}), safe="")},
        {"name": "reachestimate", "method": "GET", "relative_url": f"{a}/reachestimate?targeting_spec=" + quote(json.dumps({"geo_locations": {"countries": ["US"]}, "age_min": 18, "age_max": 65}), safe="") + "&optimize_for=LINK_CLICKS"},
    ]
    return fb.batch(ops)


def probe_targeting_search(fb: Fb) -> dict:
    ops = [
        {"name": "targeting_search_fitness", "method": "GET", "relative_url": "search?type=adinterest&q=fitness&limit=5"},
        {"name": "targeting_search_cooking", "method": "GET", "relative_url": "search?type=adinterest&q=cooking&limit=5"},
        {"name": "geo_search_paris", "method": "GET", "relative_url": "search?type=adgeolocation&q=paris&limit=5"},
        {"name": "locale_list", "method": "GET", "relative_url": "search?type=adlocale&q=english&limit=5"},
        {"name": "education_majors", "method": "GET", "relative_url": "search?type=adeducationmajor&q=computer&limit=5"},
        {"name": "behaviors", "method": "GET", "relative_url": "search?type=adTargetingCategory&class=behaviors&limit=10"},
        {"name": "industries", "method": "GET", "relative_url": "search?type=adworkemployer&q=meta&limit=5"},
    ]
    return fb.batch(ops)


def probe_async_insights(fb: Fb, acct_id: str) -> dict:
    """Create an async insights report job, immediately poll its status.

    This validates that we can use the async pattern for big reports.
    """
    _log("async.create", acct=acct_id)
    create = fb.post(
        f"/{acct_id}/insights",
        {"level": "campaign", "date_preset": "last_30d", "fields": "campaign_id,campaign_name,spend,impressions,clicks,actions"},
    )
    if not isinstance(create, dict) or create.get("error"):
        return {"create_ok": False, "create": create}
    report_run_id = create.get("report_run_id") or create.get("id")
    if not report_run_id:
        return {"create_ok": False, "create": create}
    poll = fb.get(f"/{report_run_id}", {"fields": "id,async_status,async_percent_completion,date_start,date_stop"})
    return {"create_ok": True, "report_run_id": report_run_id, "first_poll": poll}


def probe_page(fb: Fb, page_id: str) -> dict:
    p = page_id
    ops = [
        {"name": "page_meta", "method": "GET", "relative_url": f"{p}?fields=id,name,category,category_list,fan_count,followers_count,link,picture,verification_status,can_post,is_published,is_unclaimed,about,phone,location,emails,website,country_page_likes,unread_message_count,unseen_message_count,unread_notif_count"},
        {"name": "page_insights_30d", "method": "GET", "relative_url": f"{p}/insights?metric=page_impressions,page_engaged_users,page_post_engagements,page_video_views,page_fans,page_fan_adds,page_fan_removes&date_preset=last_30d"},
        {"name": "posts_recent", "method": "GET", "relative_url": f"{p}/posts?fields=id,message,story,created_time,permalink_url,status_type,is_published,is_hidden,full_picture,attachments{{media_type,title,description,url,subattachments}},reactions.summary(true).limit(0),comments.summary(true).limit(0),shares,insights.metric(post_impressions,post_engaged_users,post_clicks,post_reactions_by_type_total)&limit=5"},
        {"name": "published_posts", "method": "GET", "relative_url": f"{p}/published_posts?fields=id,message,created_time,permalink_url,is_published,scheduled_publish_time&limit=5"},
        {"name": "scheduled_posts", "method": "GET", "relative_url": f"{p}/scheduled_posts?fields=id,message,scheduled_publish_time&limit=5"},
        {"name": "blocked", "method": "GET", "relative_url": f"{p}/blocked?limit=5"},
        {"name": "roles", "method": "GET", "relative_url": f"{p}/roles?fields=id,name,tasks&limit=10"},
        {"name": "page_cta", "method": "GET", "relative_url": f"{p}/page_call_to_actions?fields=id,type,status,iphone_app,android_app,intl_number_with_plus,email_address,web_url&limit=5"},
        {"name": "tabs", "method": "GET", "relative_url": f"{p}/tabs?limit=20"},
        {"name": "global_brand_children", "method": "GET", "relative_url": f"{p}/global_brand_children?limit=5"},
        {"name": "page_videos", "method": "GET", "relative_url": f"{p}/videos?fields=id,title,description,length,views,created_time&limit=5"},
        {"name": "page_albums", "method": "GET", "relative_url": f"{p}/albums?fields=id,name,count,created_time&limit=5"},
        {"name": "conversations", "method": "GET", "relative_url": f"{p}/conversations?fields=id,updated_time,message_count,unread_count,participants&limit=5"},
        {"name": "lead_gen_forms", "method": "GET", "relative_url": f"{p}/leadgen_forms?fields=id,name,status,locale,leads_count,created_time,questions&limit=5"},
        {"name": "subscribed_apps", "method": "GET", "relative_url": f"{p}/subscribed_apps?fields=id,name,subscribed_fields&limit=10"},
        {"name": "instagram_account", "method": "GET", "relative_url": f"{p}?fields=instagram_business_account{{id,username,followers_count,media_count,profile_picture_url}}"},
    ]
    return fb.batch(ops)


def probe_post_comments(fb: Fb, page_id: str, post_id: str) -> dict:
    ops = [
        {"name": "comments", "method": "GET", "relative_url": f"{post_id}/comments?fields=id,from,message,created_time,like_count,comment_count,is_hidden,can_hide,can_comment,can_like,can_remove,user_likes,attachment&limit=10&order=reverse_chronological"},
        {"name": "reactions", "method": "GET", "relative_url": f"{post_id}/reactions?type=LIKE&limit=1&summary=total_count"},
        {"name": "post_full", "method": "GET", "relative_url": f"{post_id}?fields=id,message,created_time,permalink_url,status_type,is_published,is_hidden,full_picture,reactions.summary(true).limit(0),comments.summary(true).limit(0)"},
        {"name": "post_insights", "method": "GET", "relative_url": f"{post_id}/insights?metric=post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_reactions_by_type_total,post_negative_feedback"},
    ]
    return fb.batch(ops)


def main() -> int:
    cfg = Cfg.load()
    _log(
        "capabilities.start",
        sysuser_token=_mask(cfg.sysuser_token),
        page_token=_mask(cfg.page_token),
        page_id=cfg.page_id,
        business_id=cfg.business_id,
        proxy=cfg.proxy.split("@")[-1],
    )

    egress = requests.Session()
    egress.trust_env = False
    egress.proxies = {"http": cfg.proxy, "https": cfg.proxy}
    try:
        ip_info = egress.get("https://ipinfo.io/json", timeout=cfg.timeout_s).json()
    except Exception as err:
        sys.exit(f"proxy unreachable: {err}")
    _log("proxy.ok", **{k: ip_info.get(k) for k in ("ip", "country", "city", "org")})

    usage = Usage()
    sysuser = Fb(cfg, cfg.sysuser_token, "sysuser", usage)
    page_fb = Fb(cfg, cfg.page_token, "page", usage) if cfg.page_token else None

    report: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "egress": ip_info,
        "tokens": {
            "system_user": _mask(cfg.sysuser_token),
            "page": _mask(cfg.page_token) if cfg.page_token else None,
        },
        "business_manager": {},
        "ad_accounts": {},
        "targeting_search": {},
        "async_insights": {},
        "page": {},
        "post_comments": {},
        "summary": {},
        "usage_seen": {},
    }

    _log("step", what="business_manager")
    bm_raw = probe_business_manager(sysuser, cfg.business_id)
    report["business_manager"] = bm_raw

    owned_accts = (((bm_raw.get("owned_ad_accounts") or {}).get("body")) or {}).get("data") or []
    if not owned_accts:
        _log("warn", what="no_owned_ad_accounts_from_bm_falling_back_to_me_adaccounts")
        me_acct = sysuser.get("/me/adaccounts", {"fields": "id,name,account_status,currency", "limit": 50})
        owned_accts = (me_acct or {}).get("data") or []

    active = [a for a in owned_accts if a.get("account_status") == 1]
    _log("step", what="ad_accounts", total=len(owned_accts), active=len(active))

    for acct in active:
        acct_id = acct.get("id") or f"act_{acct.get('account_id')}"
        _log("step", what="probe_ad_account", acct=acct_id, name=acct.get("name"))
        report["ad_accounts"][acct_id] = {
            "name": acct.get("name"),
            "results": probe_ad_account(sysuser, acct_id),
        }

    if active:
        first_acct_id = active[0].get("id")
        _log("step", what="targeting_search")
        report["targeting_search"] = probe_targeting_search(sysuser)
        _log("step", what="async_insights", acct=first_acct_id)
        report["async_insights"] = probe_async_insights(sysuser, first_acct_id)

    if page_fb and cfg.page_id:
        _log("step", what="page", page=cfg.page_id)
        page_raw = probe_page(page_fb, cfg.page_id)
        report["page"] = page_raw
        posts = (((page_raw.get("posts_recent") or {}).get("body")) or {}).get("data") or []
        if posts:
            first_post = posts[0].get("id")
            _log("step", what="post_comments", post=first_post)
            report["post_comments"] = {
                "post_id": first_post,
                "results": probe_post_comments(page_fb, cfg.page_id, first_post),
            }

    report["usage_seen"] = {
        "app": usage.app,
        "business_use_case": usage.business_use_case,
        "ad_account": usage.ad_account,
        "page": usage.page,
        "samples": usage.samples,
    }

    summary: dict[str, Any] = {"capabilities_matrix": {}}
    for acct_id, payload in report["ad_accounts"].items():
        results = payload["results"]
        for name, item in results.items():
            ok = isinstance(item, dict) and item.get("code") and 200 <= int(item.get("code") or 0) < 300 and isinstance(item.get("body"), dict) and not item["body"].get("error")
            summary["capabilities_matrix"].setdefault(name, {"per_account": {}})["per_account"][acct_id] = bool(ok)
            if ok:
                body = item["body"]
                if "data" in body:
                    summary["capabilities_matrix"][name]["per_account"][acct_id + "__count"] = len(body["data"])
                    summary["capabilities_matrix"][name].setdefault("nonzero_accounts", 0)
                    if body["data"]:
                        summary["capabilities_matrix"][name]["nonzero_accounts"] += 1
            else:
                err = item.get("body", {}).get("error") if isinstance(item.get("body"), dict) else None
                if err:
                    summary["capabilities_matrix"][name].setdefault("errors", []).append({"acct": acct_id, "code": err.get("code"), "message": (err.get("message") or "")[:120]})

    bm_summary = {}
    for name, item in (report["business_manager"] or {}).items():
        if not isinstance(item, dict):
            continue
        code = int(item.get("code") or 0)
        body = item.get("body")
        ok = 200 <= code < 300 and isinstance(body, dict) and not body.get("error")
        if ok:
            if isinstance(body, dict) and "data" in body:
                bm_summary[name] = {"ok": True, "count": len(body["data"])}
            else:
                bm_summary[name] = {"ok": True, "value": "present"}
        else:
            err = (body or {}).get("error") if isinstance(body, dict) else None
            bm_summary[name] = {"ok": False, "code": err.get("code") if err else None, "message": (err.get("message") if err else "")[:120]}
    summary["business_manager"] = bm_summary

    page_summary = {}
    for name, item in (report["page"] or {}).items():
        if not isinstance(item, dict):
            continue
        code = int(item.get("code") or 0)
        body = item.get("body")
        ok = 200 <= code < 300 and isinstance(body, dict) and not body.get("error")
        if ok:
            if isinstance(body, dict) and "data" in body:
                page_summary[name] = {"ok": True, "count": len(body["data"])}
            else:
                page_summary[name] = {"ok": True, "value": "present"}
        else:
            err = (body or {}).get("error") if isinstance(body, dict) else None
            page_summary[name] = {"ok": False, "code": err.get("code") if err else None, "message": (err.get("message") if err else "")[:120]}
    summary["page"] = page_summary
    report["summary"] = summary

    out = ROOT / "data" / "capabilities_report.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    _log("capabilities.written", path=str(out), calls=sysuser.calls + (page_fb.calls if page_fb else 0))

    print("\n" + "=" * 78)
    print("CAPABILITY MATRIX (sysuser token vs each active ad account)")
    print("=" * 78)
    print(f"{'endpoint':<42} {'OK':>4} {'NONZERO':>8}  notes")
    print("-" * 78)
    for name, info in sorted(summary["capabilities_matrix"].items()):
        per = info.get("per_account") or {}
        oks = sum(1 for v in per.values() if v is True)
        total = sum(1 for k in per if not k.endswith("__count"))
        nz = info.get("nonzero_accounts", 0)
        err_note = ""
        if info.get("errors"):
            codes = sorted({str(e.get("code")) for e in info["errors"]})
            err_note = f"err codes={','.join(codes)}"
        print(f"{name:<42} {oks}/{total:<2} {nz:>8}  {err_note}")
    print()

    print("BUSINESS MANAGER INVENTORY")
    print("-" * 78)
    for name, v in sorted(summary["business_manager"].items()):
        flag = "OK" if v.get("ok") else "NO"
        extra = f"count={v.get('count')}" if "count" in v else (f"err={v.get('code')}/{v.get('message')}" if not v.get("ok") else v.get("value"))
        print(f"  [{flag}] {name:<32}  {extra}")
    print()

    print("PAGE INVENTORY (RiseHope via page token)")
    print("-" * 78)
    for name, v in sorted(summary["page"].items()):
        flag = "OK" if v.get("ok") else "NO"
        extra = f"count={v.get('count')}" if "count" in v else (f"err={v.get('code')}/{v.get('message')}" if not v.get("ok") else v.get("value"))
        print(f"  [{flag}] {name:<32}  {extra}")
    print()

    print("USAGE HEADERS CAPTURED")
    print("-" * 78)
    print(f"  x-app-usage:               {usage.app}")
    print(f"  x-business-use-case-usage: {usage.business_use_case}")
    print(f"  x-ad-account-usage:        {usage.ad_account}")
    print(f"  x-page-usage:              {usage.page}")
    print()
    print(f"Total HTTP requests: {sysuser.calls + (page_fb.calls if page_fb else 0)}  (all via {cfg.proxy.split('@')[-1]})")
    print(f"Full JSON: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
