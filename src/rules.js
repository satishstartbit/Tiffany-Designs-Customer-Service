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

// Where the digits 0 to 9 start in the Indian scripts a caller's speech can be written in: Devanagari, Bengali,
// Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada and Malayalam.
const SCRIPT_ZEROS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66];
// Keyed in NFC, as digitsSaid reads the text, so "ज़ीरो" matches however its nukta was typed.
const wordMap = (words) => new Map(Object.entries(words).map(([word, value]) => [word.normalize('NFC'), value]));
const DIGIT_WORDS = wordMap({
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  शून्य: 0, ज़ीरो: 0, जीरो: 0, एक: 1, दो: 2, तीन: 3, चार: 4, पाँच: 5, पांच: 5, छह: 6, छः: 6, छे: 6, सात: 7, आठ: 8, नौ: 9,
});
const REPEAT_WORDS = wordMap({ double: 2, triple: 3, डबल: 2, ट्रिपल: 3 });

// The digits of a number as a caller says it and the speech recogniser or the agent writes it: in groups ("30 20 20"
// is 302020), in an Indian script ("३०२०२०"), as words ("three zero", "तीन शून्य") or with double and triple
// ("double two" is 22). Anything else, such as "PIN code" or a dash, is left out.
function digitsSaid(value) {
  const text = String(value ?? '').normalize('NFC').replace(/\p{Nd}/gu, (ch) => {
    const code = ch.codePointAt(0);
    const zero = SCRIPT_ZEROS.find((z) => code >= z && code <= z + 9);
    return zero ? String(code - zero) : ch;
  });
  let digits = '';
  let repeat = 1;
  for (const token of text.toLowerCase().match(/[0-9]+|[\p{L}\p{M}]+/gu) || []) {
    if (REPEAT_WORDS.has(token)) {
      repeat = REPEAT_WORDS.get(token);
    } else if (/^[0-9]+$/.test(token)) {
      // "double 2" is 22; a group after it, as in "double 20", is repeated by its first digit only.
      digits += token[0].repeat(repeat) + token.slice(1);
      repeat = 1;
    } else if (DIGIT_WORDS.has(token)) {
      digits += String(DIGIT_WORDS.get(token)).repeat(repeat);
      repeat = 1;
    }
  }
  return digits;
}

// The six digits of an Indian PIN code as said ("30 20 20"), or null when what was said is not one.
function pinCodeSaid(value) {
  const digits = digitsSaid(value);
  return /^[1-9]\d{5}$/.test(digits) ? digits : null;
}

function normalizePhone(input) {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim();
  const digits = digitsSaid(raw);
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits[1])) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits[2])) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

function lastTenDigits(phone) {
  const digits = digitsSaid(phone);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// The last four digits of a number, as the voice agent says a number back for the caller to confirm.
function phoneEnding(phone) {
  const digits = digitsSaid(phone);
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

// The words a name is searched and compared by: in English letters when it has a first and a last name in them, else
// as written in its own script ("प्रदीप चौधरी"), which English letters alone would drop.
function searchNameWords(name) {
  const latin = nameWords(name);
  return latin.length >= 2 ? latin : personNameWords(name).map((w) => w.toLowerCase());
}

// A caller's spoken name counts as a match only with a first and a last name, each found on the record. A name in
// English letters is compared with the record's English letters, and one in Hindi script with its Hindi words.
function namesMatch(spoken, recorded) {
  const latin = nameWords(spoken);
  const said = latin.length >= 2 ? latin : personNameWords(spoken).map((w) => w.toLowerCase());
  const known = latin.length >= 2 ? nameWords(recorded) : personNameWords(recorded).map((w) => w.toLowerCase());
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
  ISSUE_TYPES, digitsSaid, pinCodeSaid, normalizePhone, lastTenDigits, phoneEnding, numberToConfirm, normalizeIssueType, nameWords, personNameWords,
  searchNameWords, fullName, hasName, namesMatch, joinDigits, trailingNumber, sameReference,
};
