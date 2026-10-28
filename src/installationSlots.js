// When a customer may ask for an installation visit: Monday to Saturday, 10 am to 6 pm India time, and never at a
// day or time that has already passed. The service team still confirms the appointment.
const { clockTime, formatDate, TIMEZONE } = require('./speech');
const { todayInIst } = require('./dates');

const OPENS = 10 * 60;
const CLOSES = 18 * 60;
const SUNDAY = 0;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOURS = `Monday to Saturday, ${clockTime(OPENS)} to ${clockTime(CLOSES)}`;

// Parts of the day as customers say them, in English and Hindi.
const PERIODS = [
  { words: /^(?:early |late )?morning$|^subah$/, label: 'morning', start: OPENS, end: 12 * 60 },
  { words: /^(?:early |late )?afternoon$|^dopahar$|^lunch ?time$/, label: 'afternoon', start: 12 * 60, end: 16 * 60 },
  { words: /^(?:early |late )?evening$|^shaa?m$/, label: 'evening', start: 16 * 60, end: CLOSES },
  { words: /^first half$/, label: 'first half', start: OPENS, end: 14 * 60 },
  { words: /^second half$/, label: 'second half', start: 14 * 60, end: CLOSES },
  { words: /^(?:any ?time|whole day|full day|koi bhi (?:time|samay)|flexible)$/, label: 'any time', start: OPENS, end: CLOSES },
];

const RANGE_WORD = / (?:to|and|till|until|se) /;
const PART_OF_DAY = 'morning|afternoon|evening|subah|dopahar|shaa?m';
const MERIDIEM = { morning: 'am', subah: 'am' };

// "11 in the morning", "subah 11" and "5 shaam ko" become "11 am" and "5 pm": a part of the day said with a number
// only says which half of the day the number is in.
function withMeridiem(t) {
  const after = new RegExp(`^(.*\\d.*?) (?:in the )?(${PART_OF_DAY})(?: ko| mein)?$`).exec(t);
  if (after) return `${after[1]} ${MERIDIEM[after[2]] || 'pm'}`;
  const before = new RegExp(`^(${PART_OF_DAY})(?: ko| mein)? (?:at )?(.*\\d.*)$`).exec(t);
  if (before) return `${before[2]} ${MERIDIEM[before[1]] || 'pm'}`;
  return t;
}

function normalise(text) {
  const t = String(text ?? '').toLowerCase()
    .replace(/(\d)\s*([ap])\.?\s*m\b\.?/g, '$1 $2m')
    .replace(/\s*[-–]\s*/g, ' to ')
    .replace(/\b(?:o'?clock|baje|bje|hrs|hours)\b/g, ' ')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:in the|at|around|about|approx(?:imately)?) )+/, '');
  return withMeridiem(t).replace(/ (am|pm) (am|pm)$/, ' $1');
}

// "11", "11 am", "3:30 pm", "15:00", "noon" -> minutes after midnight. An hour from 1 to 7 without am or pm is
// afternoon, since no visit is made at night; `borrowed` is the am or pm said only after the end of a range.
function clockMinutes(text, borrowed) {
  if (/^(?:12 )?(?:noon|midday)$/.test(text)) return 12 * 60;
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(?: (am|pm))?$/.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const suffix = m[3] || borrowed;
  if (minute > 59 || hour > 23) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (suffix === 'pm' ? 12 : 0);
  } else if (hour >= 1 && hour <= 7) {
    hour += 12;
  }
  return hour * 60 + minute;
}

// What the customer said, as { start, end, label, said }: end is null for a single time, and `said` is how to
// name it back.
function parseTime(text) {
  const t = normalise(text);
  if (!t) return null;
  const period = PERIODS.find((p) => p.words.test(t));
  if (period) return { start: period.start, end: period.end, label: period.label, said: period.label === 'any time' ? 'any time' : `the ${period.label}` };

  let m = /^(?:after|from) (.+)$/.exec(t) || /^(.+?) (?:ke baad|baad|onwards|or later)$/.exec(t);
  if (m && !RANGE_WORD.test(` ${m[1]} `)) {
    const from = clockMinutes(m[1]);
    return from === null ? null : { start: Math.max(from, OPENS), end: CLOSES, label: null, said: `after ${clockTime(from)}` };
  }
  m = /^(?:before|by|till|until|up ?to) (.+)$/.exec(t) || /^(.+?) (?:se pehle|se pahle|pehle|tak)$/.exec(t);
  if (m && !RANGE_WORD.test(` ${m[1]} `)) {
    const until = clockMinutes(m[1]);
    return until === null ? null : { start: OPENS, end: Math.min(until, CLOSES), label: null, said: `before ${clockTime(until)}` };
  }
  m = /^(?:between |from )?(.+?) (?:to|and|till|until|se) (.+?)(?: tak)?$/.exec(t);
  if (m) {
    const end = clockMinutes(m[2]);
    if (end === null) return null;
    const borrowed = /(am|pm)$/.exec(m[2])?.[1];
    let start = clockMinutes(m[1], borrowed);
    if (start !== null && start >= end && borrowed && !/(am|pm)$/.test(m[1])) start = clockMinutes(m[1]);
    return start === null ? null : { start, end, label: null, said: `${clockTime(start)} to ${clockTime(end)}` };
  }
  const at = clockMinutes(t);
  return at === null ? null : { start: at, end: null, label: null, said: clockTime(at) };
}

function nowInIst(nowMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]),
  );
  return { today: todayInIst(nowMs).toISOString().slice(0, 10), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const weekday = (isoDate) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();
const shift = (isoDate, days) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The first half hour after `minutes`: 13:10 -> 13:30, 13:30 -> 14:00.
const nextHalfHour = (minutes) => Math.floor(minutes / 30) * 30 + 30;

function nextWorkingDay(isoDate) {
  let day = shift(isoDate, 1);
  while (weekday(day) === SUNDAY) day = shift(day, 1);
  return day;
}

// Whether visits can still be asked for on a day resolve_date accepted (a calendar date, today or later).
// { ok: true, earliest, note } with the first time still open that day and, for today, a sentence saying so, or
// { ok: false, reason, message }.
function checkInstallationDay(isoDate, nowMs) {
  const { today, minutes } = nowInIst(nowMs);
  if (weekday(isoDate) === SUNDAY) {
    const saturday = shift(isoDate, -1);
    const options = [saturday > today ? saturday : null, nextWorkingDay(isoDate)].filter(Boolean).map(formatDate);
    return {
      ok: false,
      reason: 'closed_day',
      message: `${formatDate(isoDate)} cannot be used, as installation visits are ${HOURS}. Ask for another day, for example ${options.join(' or ')}.`,
    };
  }
  if (isoDate !== today) return { ok: true, earliest: OPENS, note: '' };
  const earliest = Math.max(OPENS, nextHalfHour(minutes));
  if (earliest > CLOSES) {
    return {
      ok: false,
      reason: 'no_time_today',
      message: `No installation time is left today, as visits are ${HOURS}. Ask for another day, for example ${formatDate(nextWorkingDay(today))}.`,
    };
  }
  return { ok: true, earliest, note: `A visit today can be from ${clockTime(earliest)} to ${clockTime(CLOSES)}.` };
}

function describe({ start, end, label }) {
  if (end === null) return { text: clockTime(start), spoken: `at ${clockTime(start)}` };
  const span = `${clockTime(start)} to ${clockTime(end)}`;
  const between = `between ${clockTime(start)} and ${clockTime(end)}`;
  if (label === 'any time') return { text: span, spoken: `any time ${between}` };
  if (label) return { text: `${label}, ${span}`, spoken: `in the ${label}, ${between}` };
  return { text: span, spoken: between };
}

// The preferred time on an installation day, checked against the visiting hours and, for today, the time now.
// { ok: true, text, spoken } with the time to store and the words to read back, or { ok: false, reason, message }.
function checkInstallationSlot(isoDate, timeText, nowMs) {
  const day = checkInstallationDay(isoDate, nowMs);
  if (!day.ok) return day;
  const ask = `Ask for a time between ${clockTime(OPENS)} and ${clockTime(CLOSES)}, for example 11 am, 3 pm or the morning.`;
  if (!String(timeText ?? '').trim()) return { ok: false, reason: 'time_missing', message: `A preferred time is needed. ${ask}` };
  const slot = parseTime(timeText);
  if (!slot) return { ok: false, reason: 'time_not_understood', message: `The time was not understood. ${ask}` };

  const outside = slot.end === null
    ? slot.start < OPENS || slot.start > CLOSES
    : slot.start < OPENS || slot.end > CLOSES || slot.start >= slot.end;
  if (outside) {
    return { ok: false, reason: 'outside_hours', message: `${capitalized(slot.said)} is outside installation hours. ${ask}` };
  }

  const { today, minutes } = nowInIst(nowMs);
  if (isoDate === today && slot.start <= minutes) {
    // A span of today that has begun is kept from the next half hour, when at least an hour of it is left.
    if (slot.end !== null && slot.end - day.earliest >= 60) {
      return { ok: true, ...describe({ start: day.earliest, end: slot.end, label: null }) };
    }
    return {
      ok: false,
      reason: 'passed',
      message: `${capitalized(slot.said)} today has already passed; it is now ${clockTime(minutes)}. `
        + `Ask for a time from ${clockTime(day.earliest)} today, or another day.`,
    };
  }
  return { ok: true, ...describe(slot) };
}

module.exports = { checkInstallationDay, checkInstallationSlot, parseTime, INSTALLATION_HOURS: HOURS };
