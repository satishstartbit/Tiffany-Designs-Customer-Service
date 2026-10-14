const test = require('node:test');
const assert = require('node:assert/strict');
const { createBusinessHours, isWithin } = require('../src/crm/businessHours');

// "Tiffany Support Hours" as Salesforce returns it: Monday to Saturday 09:00 to 18:00 IST, Sunday closed.
const TIFFANY = {
  TimeZoneSidKey: 'Asia/Kolkata',
  SundayStartTime: null, SundayEndTime: null,
  ...Object.fromEntries(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].flatMap((d) => [[`${d}StartTime`, '09:00:00.000Z'], [`${d}EndTime`, '18:00:00.000Z']])),
};
const at = (utc) => new Date(utc);

test('open Monday to Saturday from 9 am to 6 pm India time', () => {
  assert.equal(isWithin(TIFFANY, [], at('2026-10-14T06:30:00Z')), true, 'Wednesday 12:00 IST');
  assert.equal(isWithin(TIFFANY, [], at('2026-10-14T03:30:00Z')), true, 'Wednesday 09:00 IST, the opening minute');
  assert.equal(isWithin(TIFFANY, [], at('2026-10-14T03:29:00Z')), false, 'Wednesday 08:59 IST');
  assert.equal(isWithin(TIFFANY, [], at('2026-10-14T12:30:00Z')), false, 'Wednesday 18:00 IST, closing time');
  assert.equal(isWithin(TIFFANY, [], at('2026-10-17T06:30:00Z')), true, 'Saturday noon');
  assert.equal(isWithin(TIFFANY, [], at('2026-10-18T06:30:00Z')), false, 'Sunday noon');
});

test('the day is taken in India time, not UTC', () => {
  // 03:45 UTC on Sunday is 09:15 IST on Sunday: closed. 18:45 UTC on Sunday is 00:15 IST Monday: closed until 9.
  assert.equal(isWithin(TIFFANY, [], at('2026-10-18T03:45:00Z')), false);
  assert.equal(isWithin(TIFFANY, [], at('2026-10-18T18:45:00Z')), false);
});

test('holidays close the day, all day or for their hours', () => {
  const allDay = [{ ActivityDate: '2026-10-14', IsAllDay: true }];
  assert.equal(isWithin(TIFFANY, allDay, at('2026-10-14T06:30:00Z')), false);
  assert.equal(isWithin(TIFFANY, allDay, at('2026-10-15T06:30:00Z')), true, 'the next day is open');

  const afternoon = [{ ActivityDate: '2026-10-14', IsAllDay: false, StartTimeInMinutes: 13 * 60, EndTimeInMinutes: 18 * 60 }];
  assert.equal(isWithin(TIFFANY, afternoon, at('2026-10-14T06:30:00Z')), true, '12:00 is before the holiday hours');
  assert.equal(isWithin(TIFFANY, afternoon, at('2026-10-14T09:30:00Z')), false, '15:00 is inside them');

  const independenceDay = [{ IsAllDay: true, IsRecurrence: true, RecurrenceType: 'RecursYearly', RecurrenceMonthOfYear: 'August', RecurrenceDayOfMonth: 15 }];
  assert.equal(isWithin(TIFFANY, independenceDay, at('2026-08-15T06:30:00Z')), false, 'a Saturday, closed every year');
  assert.equal(isWithin(TIFFANY, independenceDay, at('2027-08-14T06:30:00Z')), true);
});

test('a day set to 24 hours is always open', () => {
  const allHours = { ...TIFFANY, SundayStartTime: '00:00:00.000Z', SundayEndTime: '00:00:00.000Z' };
  assert.equal(isWithin(allHours, [], at('2026-10-18T17:00:00Z')), true, 'Sunday 22:30 IST');
  assert.equal(isWithin(allHours, [], at('2026-10-17T18:45:00Z')), true, 'Sunday 00:15 IST');
});

test('business hours are read once and cached', async () => {
  const clock = { now: Date.parse('2026-10-14T06:30:00Z') };
  let queries = 0;
  const salesforce = {
    async query(soql) {
      queries += 1;
      return soql.includes('FROM BusinessHours') ? [TIFFANY] : [];
    },
  };
  const hours = createBusinessHours({ salesforce, now: () => clock.now, ttlMs: 60000 });
  assert.equal(await hours.isOpen(), true);
  assert.equal(await hours.isOpen(at('2026-10-18T06:30:00Z')), false);
  assert.equal(queries, 2, 'one query for the hours and one for holidays');

  clock.now += 61000;
  await hours.isOpen();
  assert.equal(queries, 4, 'reloaded after the cache expires');
});

test('without default business hours every moment counts as open', async () => {
  const hours = createBusinessHours({ salesforce: { query: async () => [] } });
  assert.equal(await hours.isOpen(at('2026-10-18T20:00:00Z')), true);
});
