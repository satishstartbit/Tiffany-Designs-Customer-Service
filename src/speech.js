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

module.exports = { formatDate, formatDateTime, spokenCaseNumber, shortName, TIMEZONE };
