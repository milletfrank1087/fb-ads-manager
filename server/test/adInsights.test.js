// Timezone re-bucketing tests. Run: node --test server/test/adInsights.test.js
// The module imports the Graph client, which requires env at load: provide dummies first
// (dotenv does not override variables that are already set).
process.env.FB_SYSTEM_USER_ACCESS_TOKEN ||= 'test-token';
process.env.FB_TARGET_PAGE_ID ||= '123';
process.env.FB_PRIMARY_ACCOUNT_ID ||= 'act_1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { athensDateOfHour, athensWindow, sameDaysAsAthens, sumHourlyRows, offsetMinutes, insightsRequest } = await import('../lib/adInsights.js');

const LA = 'America/Los_Angeles';
const row = (date, hour, extra = {}) => ({
  date_start: date,
  hourly_stats_aggregated_by_advertiser_time_zone: `${String(hour).padStart(2, '0')}:00:00 - ${String(hour).padStart(2, '0')}:59:59`,
  campaign_id: 'c1',
  spend: 1,
  impressions: 10,
  inline_link_clicks: 1,
  ...extra,
});

test('Athens day starts at 14:00 Los Angeles in winter (10h diff)', () => {
  assert.equal(athensDateOfHour(row('2026-11-13', 13), LA), '2026-11-13');
  assert.equal(athensDateOfHour(row('2026-11-13', 14), LA), '2026-11-14');
  assert.equal(athensDateOfHour(row('2026-11-13', 0), LA), '2026-11-13');
  assert.equal(athensDateOfHour(row('2026-11-13', 23), LA), '2026-11-14');
});

test('spring DST mismatch week: 9h diff until Europe springs forward', () => {
  // US DST from 2026-03-08, EU from 2026-03-29. On Mar 28 Athens is UTC+2, LA UTC-7.
  assert.equal((offsetMinutes('Europe/Athens', Date.parse('2026-03-28T12:00:00Z')) - offsetMinutes(LA, Date.parse('2026-03-28T12:00:00Z'))) / 60, 9);
  assert.equal(athensDateOfHour(row('2026-03-28', 14), LA), '2026-03-28');
  assert.equal(athensDateOfHour(row('2026-03-28', 15), LA), '2026-03-29');
  // From Mar 29 Athens is UTC+3: back to 10h.
  assert.equal(athensDateOfHour(row('2026-03-29', 14), LA), '2026-03-30');
});

test('autumn DST mismatch week: 9h diff until the US falls back', () => {
  // EU falls back 2026-10-25, US on 2026-11-01.
  assert.equal(athensDateOfHour(row('2026-10-26', 15), LA), '2026-10-27');
  assert.equal(athensDateOfHour(row('2026-10-26', 14), LA), '2026-10-26');
  assert.equal(athensDateOfHour(row('2026-11-02', 14), LA), '2026-11-03');
});

test('sameDaysAsAthens: Kyiv matches, Los Angeles does not', () => {
  const win = { since: '2026-11-10', until: '2026-11-16' };
  assert.equal(sameDaysAsAthens('Europe/Kiev', win), true);
  assert.equal(sameDaysAsAthens('Europe/Kyiv', win), true);
  assert.equal(sameDaysAsAthens(LA, win), false);
  assert.equal(sameDaysAsAthens(null, win), false);
});

test('sumHourlyRows splits one LA day across two Athens days', () => {
  const rows = [
    row('2026-11-13', 13, { spend: 10, campaign_id: 'c1' }),
    row('2026-11-13', 14, { spend: 20, campaign_id: 'c1' }),
    row('2026-11-13', 23, { spend: 5, campaign_id: 'c1' }),
  ];
  const { totals, daily, metaDaily } = sumHourlyRows(rows, LA, { since: '2026-11-13', until: '2026-11-14' });
  assert.equal(totals.length, 1);
  assert.equal(totals[0].spend, 35);
  const byDay = Object.fromEntries(daily.map((d) => [d.date, d.spend]));
  assert.deepEqual(byDay, { '2026-11-13': 10, '2026-11-14': 25 });
  // Meta-day view keeps the whole $35 on the account's Nov 13.
  assert.equal(metaDaily.length, 1);
  assert.equal(metaDaily[0].date, '2026-11-13');
  assert.equal(metaDaily[0].spend, 35);
});

test('insightsRequest never builds an inverted settled range (today/yesterday)', () => {
  // Regression: for `today`, padded since (Athens today - 1) falls after the
  // settled cutoff (accountToday - 2), which made Meta reject the whole batch.
  for (const preset of ['today', 'yesterday', 'last_7d']) {
    const req = insightsRequest('act_1', athensWindow(preset, Date.parse('2026-11-16T08:00:00Z')));
    const range = JSON.parse(req.params.time_range);
    assert.ok(range.since <= range.until, `${preset}: inverted range ${range.since}..${range.until}`);
  }
});

test('athensWindow presets are Athens calendar windows', () => {
  const now = Date.parse('2026-11-16T08:00:00Z'); // 10:00 Athens
  assert.deepEqual(athensWindow('today', now), { since: '2026-11-16', until: '2026-11-16' });
  assert.deepEqual(athensWindow('yesterday', now), { since: '2026-11-15', until: '2026-11-15' });
  assert.deepEqual(athensWindow('last_7d', now), { since: '2026-11-10', until: '2026-11-16' });
  assert.deepEqual(athensWindow('this_month', now), { since: '2026-11-01', until: '2026-11-16' });
  assert.deepEqual(athensWindow('last_month', now), { since: '2026-10-01', until: '2026-10-31' });
});
