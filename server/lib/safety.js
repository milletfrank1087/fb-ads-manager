import { config } from './env.js';
import { store } from './store.js';
import { log } from './logger.js';

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004]);
const RATE_LIMIT_SUBCODES = new Set([1504022, 2446079, 1487534]);

function todayInTz() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const counterKey = (budget) => (budget === 'ads' ? `ads:${todayInTz()}` : todayInTz());

let runtimeKillSwitch =config.killSwitch || store.getSetting('kill_switch', false) === true;

export const safety = {
  isKillSwitchActive: () => runtimeKillSwitch,

  setKillSwitch(on, reason) {
    runtimeKillSwitch = !!on;
    store.setSetting('kill_switch', runtimeKillSwitch);
    log.warn('safety.killSwitch', { on: runtimeKillSwitch, reason });
  },

  canModerate: () => config.allowModeration && !runtimeKillSwitch,

  // kind: 'READ' for GETs / read-only batches, 'WRITE' for anything that changes Facebook.
  // budget: 'default' (moderation) or 'ads' (insights for the campaign app) — separate daily
  // caps, so ads polling can never starve moderation.
  preflight(endpoint, kind, budget = 'default') {
    if (runtimeKillSwitch) return { ok: false, error: 'kill_switch_on', message: 'Kill switch is on. No Meta calls are made.' };
    if (kind === 'WRITE' && !config.allowModeration) {
      return { ok: false, error: 'moderation_disabled', message: 'Writes are disabled. Set FB_ALLOW_COMMENT_MODERATION=1.' };
    }
    const cap = budget === 'ads' ? config.adsMaxDailyCalls : config.maxDailyCalls;
    const used = store.getDailyCallCount(counterKey(budget));
    if (used >= cap) {
      return { ok: false, error: 'daily_cap_reached', message: `Daily cap of ${cap} ${budget === 'ads' ? 'ads ' : ''}Meta calls reached. Resets at midnight (${config.timezone}).` };
    }
    // The row also carries the consecutive-error count, so it is only cleared on success.
    const cd = store.getCooldown(endpoint);
    const until = cd ? Date.parse(cd.cooldown_until) : NaN;
    if (Number.isFinite(until) && until > Date.now()) {
      return { ok: false, error: 'endpoint_cooldown', message: `Paused after errors until ${cd.cooldown_until} (${cd.reason}).` };
    }
    return { ok: true };
  },

  recordCall(budget = 'default') {
    store.incrementDailyCallCount(counterKey(budget));
  },

  recordSuccess(endpoint) {
    if (store.getCooldown(endpoint)) store.clearCooldown(endpoint);
  },

  recordError(endpoint, { code, subcode, httpStatus, etaMinutes, message }) {
    const isRl = RATE_LIMIT_CODES.has(Number(code)) || RATE_LIMIT_SUBCODES.has(Number(subcode)) || httpStatus === 429;
    const consecutive = (store.getCooldown(endpoint)?.consecutive_errors ?? 0) + 1;
    let ms = null;
    if (isRl) ms = Math.max(60 * 60 * 1000, Number(etaMinutes) > 0 ? Number(etaMinutes) * 60 * 1000 : 0);
    else if (consecutive >= config.circuitBreakerThreshold) ms = config.circuitBreakerCooldownMs;
    const until = new Date(Date.now() + (ms ?? 0)).toISOString();
    const reason = isRl ? `rate_limit code=${code}` : `consecutive_errors=${consecutive}`;
    store.setCooldown(endpoint, ms ? until : new Date(0).toISOString(), reason, consecutive);
    if (ms) log.warn('safety.cooldown', { endpoint, until, reason, message: (message || '').slice(0, 120) });
  },

  snapshot() {
    const day = todayInTz();
    return {
      killSwitch: runtimeKillSwitch,
      moderationAllowed: config.allowModeration,
      proxy: config.proxyUrl ? `${config.proxyHost}:${config.proxyPort}` : null,
      dailyCallsUsed: store.getDailyCallCount(day),
      dailyCallCap: config.maxDailyCalls,
      adsDailyCallsUsed: store.getDailyCallCount(counterKey('ads')),
      adsDailyCallCap: config.adsMaxDailyCalls,
      cooldowns: store.activeCooldowns(),
    };
  },
};
