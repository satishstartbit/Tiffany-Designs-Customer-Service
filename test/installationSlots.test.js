// Installation visits are asked for Monday to Saturday, 10 am to 6 pm India time, and never in the past
// (src/installationSlots.js); resolve_date and book_installation both apply the rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkInstallationDay, checkInstallationSlot, parseTime } = require('../src/installationSlots');
const { startTestServer } = require('./helpers');

// Wednesday 14 October 2026, 12:00 IST; Sunday is 18 October.
const NOW = Date.parse('2026-10-14T06:30:00Z');
const at = (istTime, day = '2026-10-14') => Date.parse(`${day}T${istTime}:00+05:30`);
const slot = (text, day = '2026-10-15', now = NOW) => checkInstallationSlot(day, text, now);

test('times are understood the ways customers say them', () => {
  const cases = {
    '11 am': '11 am', '11am': '11 am', '11 a.m.': '11 am', 'around 11': '11 am', '3': '3 pm', '3 pm': '3 pm', '15:00': '3 pm',
    '4.30 pm': '4:30 pm', noon: '12 pm', '6 pm': '6 pm', morning: 'morning, 10 am to 12 pm', 'in the afternoon': 'afternoon, 12 pm to 4 pm',
    shaam: 'evening, 4 pm to 6 pm', 'any time': '10 am to 6 pm', '2 to 4 pm': '2 pm to 4 pm', '2-4 pm': '2 pm to 4 pm',
    '10 to 1 pm': '10 am to 1 pm', 'between 2 and 4': '2 pm to 4 pm', 'after 3 pm': '3 pm to 6 pm', '3 pm ke baad': '3 pm to 6 pm',
    'before 1 pm': '10 am to 1 pm', '4 baje tak': '10 am to 4 pm', '2 se 4 tak': '2 pm to 4 pm', 'after 9 am': '10 am to 6 pm',
    '11 in the morning': '11 am', "11 o'clock in the morning": '11 am', 'subah 11': '11 am', '10 baje subah': '10 am',
    '3 in the afternoon': '3 pm', '5 shaam ko': '5 pm', '2 to 4 in the afternoon': '2 pm to 4 pm',
  };
  for (const [said, stored] of Object.entries(cases)) {
    const result = slot(said);
    assert.equal(result.ok, true, said);
    assert.equal(result.text, stored, said);
  }
  assert.equal(slot('morning').spoken, 'in the morning, between 10 am and 12 pm');
  assert.equal(slot('11 am').spoken, 'at 11 am');
  assert.equal(parseTime('whenever'), null);
});

test('only 10 am to 6 pm is accepted', () => {
  for (const said of ['9 am', '7 pm', '9 to 11', '5 to 7 pm', 'after 6 pm', 'before 10 am', '12 am']) {
    const result = slot(said);
    assert.equal(result.ok, false, said);
    assert.equal(result.reason, 'outside_hours', said);
  }
  assert.equal(slot('7 pm').message, '7 pm is outside installation hours. Ask for a time between 10 am and 6 pm, for example 11 am, 3 pm or the morning.');
  assert.equal(slot('').reason, 'time_missing');
  assert.equal(slot(undefined).reason, 'time_missing');
  assert.equal(slot('soon').reason, 'time_not_understood');
});

test('Sunday is refused, with the Saturday before and the Monday after offered', () => {
  const sunday = checkInstallationDay('2026-10-18', NOW);
  assert.equal(sunday.ok, false);
  assert.equal(sunday.reason, 'closed_day');
  assert.equal(sunday.message, 'Sunday, 18 October cannot be used, as installation visits are Monday to Saturday, 10 am to 6 pm. '
    + 'Ask for another day, for example Saturday, 17 October or Monday, 19 October.');
  assert.equal(slot('11 am', '2026-10-18').reason, 'closed_day', 'a time on a Sunday is refused for the day');
  // On Saturday the 17th itself, only Monday is offered.
  assert.match(checkInstallationDay('2026-10-18', at('19:00', '2026-10-17')).message, /for example Monday, 19 October\.$/);
  assert.equal(checkInstallationDay('2026-10-17', NOW).ok, true, 'Saturday is a working day');
});

test('today, only a time still ahead is accepted, and nothing after 6 pm', () => {
  const today = (said, now = NOW) => checkInstallationSlot('2026-10-14', said, now);
  assert.equal(today('1 pm').ok, true);
  assert.equal(today('12:15 pm').ok, true);
  const passed = today('11 am');
  assert.equal(passed.reason, 'passed');
  assert.equal(passed.message, '11 am today has already passed; it is now 12 pm. Ask for a time from 12:30 pm today, or another day.');
  assert.equal(today('morning').reason, 'passed', 'less than an hour of the morning is left');
  assert.equal(today('afternoon').text, '12:30 pm to 4 pm', 'a span that has begun is kept from the next half hour');
  assert.equal(today('any time').text, '12:30 pm to 6 pm');
  assert.equal(today('evening').text, 'evening, 4 pm to 6 pm');

  assert.equal(checkInstallationDay('2026-10-14', NOW).note, 'A visit today can be from 12:30 pm to 6 pm.');
  assert.equal(checkInstallationDay('2026-10-14', at('08:00')).note, 'A visit today can be from 10 am to 6 pm.');
  const late = checkInstallationDay('2026-10-14', at('18:10'));
  assert.equal(late.reason, 'no_time_today');
  assert.equal(late.message, 'No installation time is left today, as visits are Monday to Saturday, 10 am to 6 pm. Ask for another day, for example Thursday, 15 October.');
  assert.match(checkInstallationDay('2026-10-17', at('18:10', '2026-10-17')).message, /for example Monday, 19 October\.$/, 'Sunday is skipped');
});

test('resolve_date refuses a Sunday and checks a time when one is given', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const resolve = (body) => s.call('POST', '/api/agent/resolve-date', { headers: s.agent, body }).then((r) => r.body);

  const sunday = await resolve({ date_text: 'Sunday' });
  assert.equal(sunday.valid, false);
  assert.equal(sunday.date, null);
  assert.match(sunday.message, /^Sunday, 18 October cannot be used/);

  const today = await resolve({ date_text: 'today' });
  assert.equal(today.valid, true);
  assert.equal(today.message, 'That is today, Wednesday, 14 October. A visit today can be from 12:30 pm to 6 pm. Use 2026-10-14 as the preferred date.');

  assert.deepEqual(await resolve({ date_text: '2026-10-15', time_text: '3 pm' }), {
    valid: true,
    date: '2026-10-15',
    spoken_date: 'Thursday, 15 October',
    time: '3 pm',
    message: 'That is Thursday, 15 October, at 3 pm. Use 2026-10-15 as the preferred date and 3 pm as the preferred time.',
  });
  const evening = await resolve({ date_text: 'tomorrow', time_text: '8 pm' });
  assert.equal(evening.valid, false);
  assert.match(evening.message, /^8 pm is outside installation hours/);
  const passed = await resolve({ date_text: 'today', time_text: '10 am' });
  assert.equal(passed.valid, false);
  assert.match(passed.message, /already passed/);
});

test('book_installation registers nothing outside Monday to Saturday, 10 am to 6 pm, or in the past', async (t) => {
  const s = await startTestServer();
  t.after(s.close);
  const book = (body) => s.call('POST', '/api/agent/installation', { headers: s.agent, body: { phone: '9876543210', ...body } });

  for (const [body, pattern] of [
    [{ preferred_date: '2026-10-18', preferred_time: '11 am' }, /^Sunday, 18 October cannot be used/],
    [{ preferred_date: '2026-10-15', preferred_time: '8 am' }, /^8 am is outside installation hours/],
    [{ preferred_date: '2026-10-15', preferred_time: '7:30 pm' }, /^7:30 pm is outside installation hours/],
    [{ preferred_date: '2026-10-15' }, /^A preferred time is needed/],
    [{ preferred_date: 'today', preferred_time: '11 am' }, /^11 am today has already passed/],
    [{ preferred_date: '2026-10-01', preferred_time: '11 am' }, /already passed/],
  ]) {
    const res = await book(body);
    assert.equal(res.status, 200);
    assert.equal(res.body.created, false, JSON.stringify(body));
    assert.equal(res.body.case_number, null);
    assert.match(res.body.message, pattern);
  }
  assert.equal(s.crm.created.length, 0);

  const later = await book({ preferred_date: 'today', preferred_time: '4 pm' });
  assert.equal(later.body.created, true, 'later today is fine');
  assert.equal(s.crm.created[0].input.preferredTime, '4 pm');
  assert.equal(later.body.preferred_date, '2026-10-14', 'the slot comes back for the installation_date variable');
  assert.equal(later.body.preferred_time, '4 pm');
  assert.match(later.body.message, /preferred slot of Wednesday, 14 October, at 4 pm\./);
});
