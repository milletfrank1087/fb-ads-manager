import { config } from './env.js';
import { log } from './logger.js';
import { runCmAuto } from './autoRun.js';
import { runAutoPostCycle } from './postManager.js';

let timer = null;
let nextRunAt = null;

function parseScheduleHours() {
  const raw = config.cmAutoSchedule || '06:00,18:00';
  return raw.split(',').map((s) => {
    const [h, m] = s.trim().split(':').map(Number);
    return { h: h || 0, m: m || 0 };
  }).filter((t) => t.h >= 0 && t.h < 24 && t.m >= 0 && t.m < 60);
}

function toTimezone(date, tz) {
  const str = date.toLocaleString('en-US', { timeZone: tz, hour12: false });
  const [datePart, timePart] = str.split(', ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [h, m, s] = timePart.split(':').map(Number);
  return { year, month, day, h, m, s };
}

function msUntilNext() {
  const tz = config.primaryAccountTz || 'Europe/Kiev';
  const slots = parseScheduleHours();
  if (!slots.length) return null;

  const now = new Date();
  const local = toTimezone(now, tz);
  const nowMinutes = local.h * 60 + local.m;

  let targetMinutes = null;
  let daysAhead = 0;

  for (const slot of slots.sort((a, b) => (a.h * 60 + a.m) - (b.h * 60 + b.m))) {
    const slotMin = slot.h * 60 + slot.m;
    if (slotMin > nowMinutes + 1) {
      targetMinutes = slotMin;
      break;
    }
  }

  if (targetMinutes === null) {
    const first = slots.sort((a, b) => (a.h * 60 + a.m) - (b.h * 60 + b.m))[0];
    targetMinutes = first.h * 60 + first.m;
    daysAhead = 1;
  }

  const diffMinutes = (daysAhead * 1440) + targetMinutes - nowMinutes;
  const ms = diffMinutes * 60 * 1000 - (local.s * 1000);
  return Math.max(ms, 30000);
}

async function tick() {
  timer = null;
  nextRunAt = null;

  if (!config.cmAutoEnabled) {
    log.info('scheduler.skip', { reason: 'cm_auto_disabled' });
    schedule();
    return;
  }

  log.info('scheduler.fire', { trigger: 'scheduled' });
    try {
      const result = await runCmAuto({ trigger: 'scheduled' });
      if (result.ok) {
        log.info('scheduler.done', { runId: result.runId, deleted: result.run?.comments_deleted || 0 });
      } else {
        log.warn('scheduler.run_failed', { error: result.error, message: result.message });
      }
    } catch (err) {
      log.error('scheduler.error', { error: String(err.message || err) });
    }

    try {
      const postResult = await runAutoPostCycle();
      if (postResult.ok) {
        log.info('scheduler.autopost.done', { topic: postResult.topic, postId: postResult.postId });
      } else {
        log.warn('scheduler.autopost.failed', { error: postResult.error });
      }
    } catch (postErr) {
      log.error('scheduler.autopost.error', { error: String(postErr.message || postErr) });
    }

    schedule();
}

function schedule() {
  if (timer) { clearTimeout(timer); timer = null; }
  const ms = msUntilNext();
  if (!ms) { nextRunAt = null; return; }
  nextRunAt = new Date(Date.now() + ms).toISOString();
  timer = setTimeout(tick, ms);
  timer.unref();
  log.info('scheduler.armed', { nextRunAt, msUntil: ms, scheduleUtc: config.cmAutoSchedule });
}

export function startScheduler() {
  if (!config.cmAutoEnabled) {
    log.info('scheduler.disabled', { reason: 'CM_AUTO_ENABLED is off' });
    return;
  }
  schedule();
}

export function getSchedulerState() {
  return {
    enabled: config.cmAutoEnabled,
    schedule: config.cmAutoSchedule,
    timezone: config.primaryAccountTz || 'Europe/Kiev',
    nextRunAt,
    armed: !!timer,
  };
}

export function reschedule() {
  schedule();
}
