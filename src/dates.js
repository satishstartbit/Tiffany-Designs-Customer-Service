// Turns a date as a customer says it ("tomorrow", "Saturday", "17 October", "17/10") into a calendar date in IST.
const { formatDate, TIMEZONE } = require('./speech');

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MAX_DAYS_AHEAD = 180;

function todayInIst(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function validDate(year, monthIndex, day) {
  const d = new Date(Date.UTC(year, monthIndex, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === monthIndex && d.getUTCDate() === day ? d : null;
}

function monthIndex(word) {
  const w = word.toLowerCase();
  return MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
}

// Day and month without a year mean the next time that date comes round.
function nextOccurrence(today, monthIdx, day, year) {
  if (year) return validDate(year, monthIdx, day);
  const thisYear = validDate(today.getUTCFullYear(), monthIdx, day);
  if (thisYear && thisYear >= today) return thisYear;
  return validDate(today.getUTCFullYear() + 1, monthIdx, day);
}

function parse(text, today) {
  const t = String(text || '').toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  if (/^(today|aaj)$/.test(t)) return today;
  if (/^(day after tomorrow|parso|parson)$/.test(t)) return addDays(today, 2);
  if (/^(tomorrow|kal)$/.test(t)) return addDays(today, 1);

  const inDays = /^(?:in|after) (\d{1,3}) days?$/.exec(t) || /^(\d{1,3}) days? (?:later|from now)$/.exec(t);
  if (inDays) return addDays(today, Number(inDays[1]));

  const weekday = /^(?:(this|next|coming) )?([a-z]+)$/.exec(t);
  if (weekday && WEEKDAYS.includes(weekday[2])) {
    const target = WEEKDAYS.indexOf(weekday[2]);
    let diff = (target - today.getUTCDay() + 7) % 7;
    if (diff === 0) diff = 7;
    return addDays(today, diff);
  }

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(t);
  if (m) {
    const year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : null;
    return nextOccurrence(today, Number(m[2]) - 1, Number(m[1]), year);
  }

  m = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(t) || null;
  if (m && monthIndex(m[2]) >= 0) return nextOccurrence(today, monthIndex(m[2]), Number(m[1]), m[3] ? Number(m[3]) : null);

  m = /^([a-z]+) (\d{1,2})(?: (\d{4}))?$/.exec(t);
  if (m && monthIndex(m[1]) >= 0) return nextOccurrence(today, monthIndex(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null);

  return null;
}

function resolveDate(text, now = Date.now()) {
  const today = todayInIst(now);
  const date = parse(text, today);
  if (!date) return { ok: false, reason: 'not_understood' };
  if (date < today) return { ok: false, reason: 'past', date: iso(date), spoken: formatDate(iso(date)) };
  if (date > addDays(today, MAX_DAYS_AHEAD)) return { ok: false, reason: 'too_far', date: iso(date), spoken: formatDate(iso(date)) };
  return { ok: true, date: iso(date), spoken: formatDate(iso(date)), isToday: date.getTime() === today.getTime() };
}

module.exports = { resolveDate, todayInIst, MAX_DAYS_AHEAD };
