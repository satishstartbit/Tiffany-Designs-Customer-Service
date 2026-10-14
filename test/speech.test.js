const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDate, formatDateTime, formatClock, clockTime, describeWeek, spokenCaseNumber, shortName } = require('../src/speech');

test('dates are spoken as weekday, day and month', () => {
  assert.equal(formatDate('2026-10-16'), 'Friday, 16 October');
  assert.equal(formatDate('2026-10-18'), 'Sunday, 18 October');
  assert.equal(formatDate(null), null);
  assert.equal(formatDate('not a date'), null);
});

test('date-times are spoken in IST', () => {
  // 05:30 UTC is 11:00 IST; 18:45 UTC is 00:15 IST the next day
  assert.equal(formatDateTime('2026-10-16T05:30:00.000Z'), 'Friday, 16 October at 11:00 am');
  assert.equal(formatDateTime('2026-10-16T18:45:00.000Z'), 'Saturday, 17 October at 12:15 am');
  assert.equal(formatDateTime(undefined), null);
});

test('case numbers lose their leading zeros', () => {
  assert.equal(spokenCaseNumber('00001064'), '1064');
  assert.equal(spokenCaseNumber('1064'), '1064');
  assert.equal(spokenCaseNumber('00000000'), '0');
});

test('record names are shortened to what a customer would say', () => {
  assert.equal(shortName('Demo Tech - Vikram (Internal)'), 'Vikram');
  assert.equal(shortName('Demo Bookcase - Side Panel'), 'Side Panel');
  assert.equal(shortName('BlueDart'), 'BlueDart');
  assert.equal(shortName(null), null);
});

test('clock times are said the short way, in India time', () => {
  assert.equal(clockTime(9 * 60), '9 am');
  assert.equal(clockTime(18 * 60), '6 pm');
  assert.equal(clockTime(9 * 60 + 30), '9:30 am');
  assert.equal(clockTime(12 * 60), '12 pm');
  assert.equal(clockTime(0), '12 am');
  assert.equal(formatClock('2026-10-15T03:30:00.000Z'), '9 am');
  assert.equal(formatClock('garbage'), null);
});

test('a week reads as runs of days with the same hours, then the closed days', () => {
  const nineToSix = { start: 9 * 60, end: 18 * 60 };
  const tenToFour = { start: 10 * 60, end: 16 * 60 };
  const tiffany = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day) => ({ day, window: nineToSix }));
  assert.equal(describeWeek([...tiffany, { day: 'Sunday', window: null }]), 'Monday to Saturday, 9 am to 6 pm; closed on Sunday');
  assert.equal(describeWeek([
    { day: 'Monday', window: nineToSix }, { day: 'Tuesday', window: nineToSix }, { day: 'Wednesday', window: null },
    { day: 'Thursday', window: tenToFour }, { day: 'Friday', window: tenToFour }, { day: 'Saturday', window: null },
    { day: 'Sunday', window: { start: 0, end: 24 * 60 } },
  ]), 'Monday and Tuesday, 9 am to 6 pm; Thursday and Friday, 10 am to 4 pm; Sunday, all day; closed on Wednesday and Saturday');
  assert.equal(describeWeek([]), '');
});
