const TIME_ZONE = 'Asia/Kolkata';
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const count = new Intl.NumberFormat('en-IN');
const day = new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric' });
const dayTime = new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const clock = new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });

const DASH = '—';

// Salesforce writes "2026-10-01T05:00:00.000+0000"; a plain date ("2026-10-01") is a day in India.
function toDate(value) {
  if (!value) return null;
  const text = String(value);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00+05:30`)
    : new Date(text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const money = (value) => (value === null || value === undefined || value === '' ? DASH : inr.format(Number(value)));
export const number = (value) => (value === null || value === undefined ? DASH : count.format(Number(value)));
export const date = (value) => (toDate(value) ? day.format(toDate(value)) : DASH);
export const dateTime = (value) => (toDate(value) ? dayTime.format(toDate(value)) : DASH);
export const time = (value) => (toDate(value) ? clock.format(toDate(value)) : DASH);

export function duration(seconds) {
  if (seconds === null || seconds === undefined) return DASH;
  const total = Math.round(Number(seconds));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes} min ${total % 60} s` : `${total} s`;
}

// Minutes after midnight (business hours) as "9 am" or "6:30 pm".
export function minutesOfDay(value) {
  if (value === null || value === undefined) return DASH;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  const suffix = hours >= 12 && hours < 24 ? 'pm' : 'am';
  const hour12 = hours % 12 || 12;
  return minutes ? `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}` : `${hour12} ${suffix}`;
}

export function initials(name) {
  return String(name || '?').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || '?';
}

export const or = (value, fallback = DASH) => (value === null || value === undefined || value === '' ? fallback : value);
