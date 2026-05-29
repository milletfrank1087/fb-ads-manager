import { config } from './env.js';
import { store } from './store.js';
import { log } from './logger.js';

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004]);
const RATE_LIMIT_SUBCODES = new Set([1504022, 2446079, 1487534]);

const accountTzDayCache = { day: null, fetchedAtMs: 0 };

function todayInAccountTz() {
  const now = Date.now();
  if (accountTzDayCache.day && now - accountTzDayCache.fetchedAtMs < 60_000) {
    return accountTzDayCache.day;
  }
  const tz = config.primaryAccountTz;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = fmt.formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year').value;
    const m = parts.find((p) => p.type === 'month').value;
    const d = parts.find((p) => p.type === 'day').value;
    accountTzDayCache.day = `${y}-${m}-${d}`;
    accountTzDayCache.fetchedAtMs = now;
    return accountTzDayCache.day;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

let runtimeKillSwitch = config.killSwitch;

export const safety = {
  isKillSwitchActive() {
    return runtimeKillSwitch;
  },

  setKillSwitch(on, reason) {
    runtimeKillSwitch = !!on;
    log.warn('safety.killSwitch', { on: runtimeKillSwitch, reason });
  },

  isReadonly() {
    return config.readonly;
  },

  isModerationAllowed() {
    return config.allowCommentModeration && !runtimeKillSwitch;
  },

  isAdManagementAllowed() {
    return config.allowAdManagement && !runtimeKillSwitch;
  },

  isAccountAllowed(accountId) {
    return accountId === config.primaryAccountId;
  },

  preflight(endpoint, method = 'GET') {
    if (runtimeKillSwitch) {
      return { ok: false, error: 'kill_switch_on', message: 'Kill switch is engaged. All Meta API calls are halted.' };
    }
    if (method === 'MODERATE') {
      if (!config.allowCommentModeration) {
        return { ok: false, error: 'moderation_disabled', message: 'Comment moderation is disabled. Set FB_ALLOW_COMMENT_MODERATION=true to enable destructive comment actions.' };
      }
    } else if (method === 'MANAGE') {
      if (!config.allowAdManagement) {
        return { ok: false, error: 'ad_management_disabled', message: 'Ad management is disabled. Set FB_ALLOW_AD_MANAGEMENT=true to enable status/budget changes.' };
      }
    } else if (config.readonly && method !== 'GET' && method !== 'POST_BATCH') {
      return { ok: false, error: 'readonly_mode', message: `${method} blocked by FB_READONLY. Only reads are permitted.` };
    }
    const day = todayInAccountTz();
    const calls = store.getDailyCallCount(day);
    if (calls >= config.maxDailyCalls) {
      return {
        ok: false,
        error: 'daily_cap_reached',
        message: `Daily call cap of ${config.maxDailyCalls} reached (used ${calls}). Resets at account-tz midnight.`,
        cap: config.maxDailyCalls,
        used: calls,
      };
    }
    const cd = store.getCooldown(endpoint);
    if (cd) {
      const until = Date.parse(cd.cooldown_until);
      if (Number.isFinite(until) && until > Date.now()) {
        return {
          ok: false,
          error: 'endpoint_cooldown',
          message: `Endpoint ${endpoint} is in cooldown until ${cd.cooldown_until} (reason: ${cd.reason}).`,
          cooldownUntil: cd.cooldown_until,
          reason: cd.reason,
        };
      }
      store.clearCooldown(endpoint);
    }
    return { ok: true };
  },

  recordCall() {
    store.incrementDailyCallCount(todayInAccountTz());
  },

  recordSuccess(endpoint) {
    const cd = store.getCooldown(endpoint);
    if (cd && cd.consecutive_errors > 0) {
      store.clearCooldown(endpoint);
      log.info('safety.cooldown.cleared', { endpoint });
    }
  },

  recordError(endpoint, { code, subcode, httpStatus, estimatedTimeToRegainAccess, message }) {
    const isRl = (code != null && RATE_LIMIT_CODES.has(Number(code))) || (subcode != null && RATE_LIMIT_SUBCODES.has(Number(subcode))) || httpStatus === 429;
    const prev = store.getCooldown(endpoint);
    const consecutive = (prev?.consecutive_errors ?? 0) + 1;

    let cooldownMs;
    if (isRl) {
      const fromMeta = Number(estimatedTimeToRegainAccess) * 60 * 1000;
      cooldownMs = Math.max(config.circuitBreakerCooldownMs, Number.isFinite(fromMeta) && fromMeta > 0 ? fromMeta : 0);
    } else if (consecutive >= config.circuitBreakerThreshold) {
      cooldownMs = config.circuitBreakerCooldownMs;
    } else {
      log.warn('safety.error.tracked', { endpoint, consecutive, code, subcode, message: (message || '').slice(0, 120) });
      return { tripped: false, consecutive };
    }
    const until = new Date(Date.now() + cooldownMs).toISOString();
    const reason = isRl ? `rate_limit:code=${code}:subcode=${subcode}` : `consecutive_errors:${consecutive}`;
    store.setCooldown(endpoint, until, reason, consecutive);
    log.warn('safety.circuit.tripped', { endpoint, until, reason, cooldownMs });
    return { tripped: true, consecutive, until, reason };
  },

  snapshot() {
    const day = todayInAccountTz();
    const dailyCalls = store.getDailyCallCount(day);
    return {
      killSwitch: runtimeKillSwitch,
      readonly: config.readonly,
      allowCommentModeration: config.allowCommentModeration,
      allowAdManagement: config.allowAdManagement,
      allowAdvisorWrites: config.allowAdvisorWrites,
      primaryAccountId: config.primaryAccountId,
      primaryAccountTz: config.primaryAccountTz,
      dailyCallCap: config.maxDailyCalls,
      dailyCallsUsed: dailyCalls,
      dailyCallDay: day,
      cooldowns: store.getAllCooldowns(),
      proxy: `${config.proxyHost}:${config.proxyPort}`,
      graphVersion: config.graphVersion,
      circuitBreakerThreshold: config.circuitBreakerThreshold,
      circuitBreakerCooldownSeconds: Math.round(config.circuitBreakerCooldownMs / 1000),
    };
  },
};
