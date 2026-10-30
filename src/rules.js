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

// The last four digits of a number, as the voice agent says a number back for the caller to confirm.
function phoneEnding(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// Nothing is saved on a mobile number until the caller has agreed to it: the agent says the number's last four digits
// back and passes the ones the caller confirmed. Null when they are this number's; otherwise what to say back: the
// ending, and whether it is the number of this call, a number the caller gave, or the one on file.
function numberToConfirm(mobile, { confirmedEnding, given, caller }) {
  const ending = phoneEnding(mobile);
  const confirmed = phoneEnding(confirmedEnding);
  if (ending && confirmed === ending) return null;
  const source = caller && lastTenDigits(caller) === lastTenDigits(mobile) ? 'call' : given ? 'given' : 'file';
  return { ending, source, confirmed };
}

function normalizeIssueType(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const resolved = ISSUE_ALIASES[key] || key;
  return ISSUE_TYPES.includes(resolved) ? resolved : null;
}

// Words that say nothing about who someone is: titles, the "Demo Customer - " prefix on the org's sample accounts, and
// the "Unknown Customer" the voice agent once saved for callers who gave no name, also as it says them in Hindi.
const NAME_FILLER = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'smt', 'sri', 'ji', 'demo', 'customer', 'test', 'unknown',
  'श्री', 'श्रीमती', 'जी', 'अज्ञात', 'अननोन', 'ग्राहक', 'कस्टमर',
]);

function nameWords(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length >= 2 && !NAME_FILLER.has(w));
}

// The words of a person's name in any script ("Ravi Kumar", "रवि चौधरी"), as written, without titles or fillers.
function personNameWords(name) {
  return String(name || '').normalize('NFC').split(/[^\p{L}\p{M}]+/u).filter((w) => w.length >= 2 && !NAME_FILLER.has(w.toLowerCase()));
}

// The name to save for a person: a first and a last name, as said, without titles; null when that is not what was given.
function fullName(name) {
  const words = personNameWords(name);
  return words.length >= 2 ? words.join(' ') : null;
}

// Whether a record's name says who the person is; "Unknown Customer" does not.
const hasName = (name) => personNameWords(name).length > 0;

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

// Order ids and invoice numbers as callers say them: "1 0 0 9" read digit by digit is 1009.
function joinDigits(value) {
  return String(value ?? '').trim().replace(/(\d)\s+(?=\d)/g, '$1');
}

// The number at the end of an id, without leading zeros: TD-ORD-1009 is 1009, INV-009 is 9, "1 0 0 9" is 1009.
function trailingNumber(value) {
  const match = /(\d+)\D*$/.exec(joinDigits(value));
  return match ? Number(match[1]) : null;
}

// Words a caller puts around an id that are not part of it: "my order number is 1009", "invoice 009".
const REFERENCE_FILLER = /\b(MY|IS|THE|ORDER|ORDERS|NUMBER|NUM|NO|ID|INVOICE|BILL)\b/g;
const referenceLetters = (value) => joinDigits(value).toUpperCase().replace(REFERENCE_FILLER, ' ').replace(/[^A-Z]/g, '');
const plainReference = (value) => joinDigits(value).toUpperCase().replace(/[^A-Z0-9]/g, '');

// Whether what a caller said names a stored order id or invoice number. Either it is the same id ("td ord 1009"),
// or it ends in the same number and any letters said are part of the id: "1009", "ORD 1009" and "TD 1009" all name
// TD-ORD-1009, and "9" or "009" names INV-009. "INV 1009" does not name TD-ORD-1009.
function sameReference(said, stored) {
  const plainSaid = plainReference(said);
  if (!plainSaid || !stored) return false;
  if (plainSaid === plainReference(stored)) return true;
  const number = trailingNumber(said);
  if (!number || number !== trailingNumber(stored)) return false;
  const letters = referenceLetters(said);
  return !letters || referenceLetters(stored).includes(letters);
}

module.exports = {
  ISSUE_TYPES, normalizePhone, lastTenDigits, phoneEnding, numberToConfirm, normalizeIssueType, nameWords, personNameWords, fullName,
  hasName, namesMatch, joinDigits, trailingNumber, sameReference,
};
