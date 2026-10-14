// The org's default business hours ("Tiffany Support Hours") evaluated in Node.
// Salesforce stores each day's times as "09:00:00.000Z", meaning 09:00 in the record's own time zone.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_FROM_MONDAY = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKAHEAD_DAYS = 14;

const FIELDS = ['TimeZoneSidKey', ...DAYS.flatMap((d) => [`${d}StartTime`, `${d}EndTime`])].join(', ');

function minutesOf(time) {
  if (!time) return null;
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    day: WEEKDAY_INDEX[parts.weekday],
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    month: Number(parts.month),
    dayOfMonth: Number(parts.day),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function holidayApplies(holiday, local) {
  const sameDay = holiday.IsRecurrence && holiday.RecurrenceType === 'RecursYearly'
    ? MONTHS[local.month - 1] === holiday.RecurrenceMonthOfYear && local.dayOfMonth === holiday.RecurrenceDayOfMonth
    : holiday.ActivityDate === local.isoDate;
  if (!sameDay) return false;
  if (holiday.IsAllDay) return true;
  return local.minutes >= holiday.StartTimeInMinutes && local.minutes < holiday.EndTimeInMinutes;
}

// A day's opening window in minutes after local midnight, or null when closed all day.
function windowOf(hours, day) {
  const start = minutesOf(hours[`${DAYS[day]}StartTime`]);
  const end = minutesOf(hours[`${DAYS[day]}EndTime`]);
  if (start === null || end === null) return null;
  if (start === end) return { start: 0, end: 24 * 60 };
  return { start, end: end === 0 ? 24 * 60 : end };
}

function isWithin(hours, holidays, date) {
  const local = localParts(date, hours.TimeZoneSidKey || 'Asia/Kolkata');
  if (holidays.some((h) => holidayApplies(h, local))) return false;
  const window = windowOf(hours, local.day);
  return Boolean(window) && local.minutes >= window.start && local.minutes < window.end;
}

// The instant at which a local date and time in the given zone occurs.
function zonedTime(isoDate, minutes, timeZone) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const local = localParts(new Date(guess), timeZone);
  const [ly, lm, ld] = local.isoDate.split('-').map(Number);
  return new Date(guess - (Date.UTC(ly, lm - 1, ld, 0, local.minutes) - guess));
}

function status(hours, holidays, date) {
  const timeZone = hours.TimeZoneSidKey || 'Asia/Kolkata';
  const local = localParts(date, timeZone);
  const result = {
    configured: true,
    open: isWithin(hours, holidays, date),
    closesAt: null,
    opensAt: null,
    holidayName: holidays.find((h) => holidayApplies(h, local))?.Name || null,
    weekly: WEEK_FROM_MONDAY.map((day) => ({ day: DAYS[day], window: windowOf(hours, day) })),
  };
  if (result.open) {
    result.closesAt = zonedTime(local.isoDate, windowOf(hours, local.day).end, timeZone);
    return result;
  }
  for (let ahead = 0; ahead <= LOOKAHEAD_DAYS && !result.opensAt; ahead += 1) {
    const day = localParts(new Date(date.getTime() + ahead * DAY_MS), timeZone);
    const window = windowOf(hours, day.day);
    const opening = window && zonedTime(day.isoDate, window.start, timeZone);
    if (opening && opening > date && isWithin(hours, holidays, opening)) result.opensAt = opening;
  }
  return result;
}

function createBusinessHours({ salesforce, now = () => Date.now(), ttlMs = 10 * 60 * 1000 }) {
  let cache = null;

  async function load() {
    if (cache && now() - cache.loadedAt < ttlMs) return cache;
    const [hours] = await salesforce.query(`SELECT ${FIELDS} FROM BusinessHours WHERE IsDefault = true AND IsActive = true LIMIT 1`);
    const holidays = await salesforce.query(
      'SELECT Name, ActivityDate, IsAllDay, StartTimeInMinutes, EndTimeInMinutes, IsRecurrence, RecurrenceType, RecurrenceMonthOfYear, RecurrenceDayOfMonth FROM Holiday',
    );
    cache = { loadedAt: now(), hours: hours || null, holidays };
    return cache;
  }

  // With no default business hours every moment counts as open, as in Apex.
  async function isOpen(date = new Date(now())) {
    const { hours, holidays } = await load();
    return hours ? isWithin(hours, holidays, date) : true;
  }

  // Open or closed now, when that changes next, and the weekly hours to read out.
  async function getStatus(date = new Date(now())) {
    const { hours, holidays } = await load();
    if (!hours) return { configured: false, open: true, closesAt: null, opensAt: null, holidayName: null, weekly: [] };
    return status(hours, holidays, date);
  }

  return { isOpen, getStatus };
}

module.exports = { createBusinessHours, isWithin, status };
