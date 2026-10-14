const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDate, formatDateTime, spokenCaseNumber, shortName } = require('../src/speech');

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
