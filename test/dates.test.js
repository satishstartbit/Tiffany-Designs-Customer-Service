const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDate } = require('../src/dates');

// Wednesday 14 October 2026, 12:00 IST
const NOW = Date.parse('2026-10-14T06:30:00Z');
const date = (text, now = NOW) => resolveDate(text, now).date;

test('relative days, in English and in Hindi', () => {
  assert.equal(date('today'), '2026-10-14');
  assert.equal(date('Tomorrow'), '2026-10-15');
  assert.equal(date('kal'), '2026-10-15');
  assert.equal(date('day after tomorrow'), '2026-10-16');
  assert.equal(date('parso'), '2026-10-16');
  assert.equal(date('in 3 days'), '2026-10-17');
  assert.equal(date('10 days from now'), '2026-10-24');
});

test('a weekday means the next one after today', () => {
  assert.equal(date('Saturday'), '2026-10-17');
  assert.equal(date('this saturday'), '2026-10-17');
  assert.equal(date('next Monday'), '2026-10-19');
  assert.equal(date('wednesday'), '2026-10-21', 'the same weekday as today means next week');
});

test('day and month in the ways customers say and type them', () => {
  for (const text of ['17 October', '17th Oct', 'October 17', 'oct 17th', '17/10', '17-10-2026', '17.10.26', '2026-10-17']) {
    assert.equal(date(text), '2026-10-17', text);
  }
  assert.equal(date('5 January'), '2027-01-05', 'a date already gone this year is next year');
});

test('the spoken form comes back with the date', () => {
  assert.deepEqual(resolveDate('tomorrow', NOW), { ok: true, date: '2026-10-15', spoken: 'Thursday, 15 October', isToday: false });
  assert.equal(resolveDate('today', NOW).isToday, true);
});

test('past, far-off and unclear dates are refused with a reason', () => {
  assert.equal(resolveDate('1 October 2026', NOW).reason, 'past');
  assert.equal(resolveDate('13/10/2026', NOW).reason, 'past');
  assert.equal(resolveDate('1 October', NOW).reason, 'too_far', 'next October is beyond the booking window');
  assert.equal(resolveDate('31/02', NOW).reason, 'not_understood');
  assert.equal(resolveDate('whenever', NOW).reason, 'not_understood');
  assert.equal(resolveDate('', NOW).reason, 'not_understood');
  assert.equal(resolveDate(undefined, NOW).reason, 'not_understood');
});

test('today is the IST date, even when UTC is still on the previous day', () => {
  // 19:00 UTC on 14 October is 00:30 IST on 15 October
  const justAfterMidnightIst = Date.parse('2026-10-14T19:00:00Z');
  assert.equal(date('today', justAfterMidnightIst), '2026-10-15');
  assert.equal(date('tomorrow', justAfterMidnightIst), '2026-10-16');
});
