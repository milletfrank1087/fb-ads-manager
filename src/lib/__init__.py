"""Shared library for the FB Ads Manager dashboard.

`client` provides the proxied, appsecret-proof-signed, throttled, BUC-aware
Graph API client used by every script in this project. `store` provides the
SQLite persistence layer that backs the dashboard (entities + insights +
usage_samples + change_log).

Every Graph API call in this project MUST go through `client.Fb` — direct
`requests.get/post` to graph.facebook.com is forbidden (AGENTS.md §1).
"""

from .client import Cfg, Fb, Usage, log, mask, proof
from .store import Store

__all__ = ["Cfg", "Fb", "Usage", "Store", "log", "mask", "proof"]
