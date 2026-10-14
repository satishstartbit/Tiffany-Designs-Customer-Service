// Values the agent reads aloud, formatted for listening rather than reading.
const TIMEZONE = 'Asia/Kolkata';

function formatDate(value) {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-IN', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

function formatDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(date)
    .replace(/\s?([ap])\.?m\.?/i, (_, p) => ` ${p.toLowerCase()}m`);
  return `${formatDate(value)} at ${time}`;
}

// 540 -> "9 am", 1110 -> "6:30 pm", 720 -> "12 pm".
function clockTime(minutesAfterMidnight) {
  const hour = Math.floor(minutesAfterMidnight / 60) % 24;
  const minute = minutesAfterMidnight % 60;
  return `${hour % 12 === 0 ? 12 : hour % 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour < 12 ? 'am' : 'pm'}`;
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).map((p) => [p.type, p.value]),
  );
  return clockTime(Number(parts.hour) * 60 + Number(parts.minute));
}

// [{ day: 'Monday', window: { start: 540, end: 1080 } }, ..., { day: 'Sunday', window: null }]
// -> "Monday to Saturday, 9 am to 6 pm; closed on Sunday"
function describeWeek(weekly) {
  const groups = [];
  for (const { day, window } of weekly || []) {
    const last = groups[groups.length - 1];
    const same = last && (last.window === window || (last.window && window && last.window.start === window.start && last.window.end === window.end));
    if (same) last.days.push(day);
    else groups.push({ days: [day], window });
  }
  const span = (days) => (days.length > 2 ? `${days[0]} to ${days[days.length - 1]}` : days.join(' and '));
  const open = groups.filter((g) => g.window).map((g) => `${span(g.days)}, ${
    g.window.start === 0 && g.window.end === 24 * 60 ? 'all day' : `${clockTime(g.window.start)} to ${clockTime(g.window.end)}`}`);
  const closed = groups.filter((g) => !g.window).flatMap((g) => g.days);
  return [...open, closed.length ? `closed on ${closed.join(' and ')}` : null].filter(Boolean).join('; ');
}

// Case 00001064 is said as 1064; the status lookup pads it back.
function spokenCaseNumber(caseNumber) {
  const digits = String(caseNumber || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  return digits || String(caseNumber || '');
}

// "Demo Tech - Vikram (Internal)" -> "Vikram"; "Demo Bookcase - Hardware Kit" -> "Hardware Kit".
function shortName(name) {
  if (!name) return null;
  return String(name).replace(/\s*\([^)]*\)\s*/g, ' ').split(' - ').pop().trim() || null;
}

module.exports = { formatDate, formatDateTime, formatClock, clockTime, describeWeek, spokenCaseNumber, shortName, TIMEZONE };
