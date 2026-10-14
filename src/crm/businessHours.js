// The org's default business hours ("Tiffany Support Hours") evaluated in Node.
// Salesforce stores each day's times as "09:00:00.000Z", meaning 09:00 in the record's own time zone.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

function isWithin(hours, holidays, date) {
  const local = localParts(date, hours.TimeZoneSidKey || 'Asia/Kolkata');
  if (holidays.some((h) => holidayApplies(h, local))) return false;
  const start = minutesOf(hours[`${DAYS[local.day]}StartTime`]);
  let end = minutesOf(hours[`${DAYS[local.day]}EndTime`]);
  if (start === null || end === null) return false;
  if (start === end) return true;
  if (end === 0) end = 24 * 60;
  return local.minutes >= start && local.minutes < end;
}

function createBusinessHours({ salesforce, now = () => Date.now(), ttlMs = 10 * 60 * 1000 }) {
  let cache = null;

  async function load() {
    if (cache && now() - cache.loadedAt < ttlMs) return cache;
    const [hours] = await salesforce.query(`SELECT ${FIELDS} FROM BusinessHours WHERE IsDefault = true AND IsActive = true LIMIT 1`);
    const holidays = await salesforce.query(
      'SELECT ActivityDate, IsAllDay, StartTimeInMinutes, EndTimeInMinutes, IsRecurrence, RecurrenceType, RecurrenceMonthOfYear, RecurrenceDayOfMonth FROM Holiday',
    );
    cache = { loadedAt: now(), hours: hours || null, holidays };
    return cache;
  }

  // With no default business hours every moment counts as open, as in Apex.
  async function isOpen(date = new Date(now())) {
    const { hours, holidays } = await load();
    return hours ? isWithin(hours, holidays, date) : true;
  }

  return { isOpen };
}

module.exports = { createBusinessHours, isWithin };
