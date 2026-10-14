const ISSUE_TYPES = [
  'installation',
  'installation_reschedule',
  'installation_followup',
  'reinstallation',
  'damaged',
  'delivery_damage',
  'defective',
  'missing_parts',
  'wrong_part',
  'quality_issue',
  'replacement',
  'return',
  'general',
  'escalation',
];

const ISSUE_ALIASES = {
  install: 'installation',
  installation_request: 'installation',
  reschedule: 'installation_reschedule',
  rescheduling: 'installation_reschedule',
  installation_follow_up: 'installation_followup',
  follow_up: 'installation_followup',
  re_installation: 'reinstallation',
  reinstall: 'reinstallation',
  quality: 'quality_issue',
  product_quality: 'quality_issue',
  damage: 'damaged',
  broken: 'damaged',
  transit_damage: 'delivery_damage',
  damaged_in_delivery: 'delivery_damage',
  defect: 'defective',
  missing: 'missing_parts',
  missing_part: 'missing_parts',
  part_missing: 'missing_parts',
  wrong_component: 'wrong_part',
  replace: 'replacement',
  refund: 'return',
  general_query: 'general',
  query: 'general',
  human: 'escalation',
};

function normalizePhone(input) {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits[1])) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits[2])) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

function lastTenDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function normalizeIssueType(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const resolved = ISSUE_ALIASES[key] || key;
  return ISSUE_TYPES.includes(resolved) ? resolved : null;
}

// Words that say nothing about who someone is: titles, and the "Demo Customer - " prefix on the org's sample accounts.
const NAME_FILLER = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'smt', 'sri', 'ji', 'demo', 'customer', 'test']);

function nameWords(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length >= 2 && !NAME_FILLER.has(w));
}

// Equal, or one letter added, dropped or changed in a word of four letters or more ("Arav" for "Aarav").
function sameWord(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else {
      edits += 1;
      if (edits > 1) return false;
      if (a.length > b.length) i += 1;
      else if (b.length > a.length) j += 1;
      else {
        i += 1;
        j += 1;
      }
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// A caller's spoken name counts as a match only with a first and a last name, each found on the record.
function namesMatch(spoken, recorded) {
  const said = nameWords(spoken);
  const known = nameWords(recorded);
  return said.length >= 2 && said.every((w) => known.some((k) => sameWord(w, k)));
}

module.exports = { ISSUE_TYPES, normalizePhone, lastTenDigits, normalizeIssueType, nameWords, namesMatch };
