const test = require('node:test');
const assert = require('node:assert/strict');
const {
  digitsSaid, pinCodeSaid, normalizePhone, lastTenDigits, phoneEnding, numberToConfirm, fullName, normalizeIssueType, namesMatch,
} = require('../src/rules');

test('a number is read as it was said: in groups, in an Indian script, as words, with double and triple', () => {
  assert.equal(digitsSaid('30 20 20।'), '302020');
  assert.equal(digitsSaid('PIN code 3 0 2 0 2 0'), '302020');
  assert.equal(digitsSaid('३०२०२०'), '302020');
  assert.equal(digitsSaid('੩੦੨੦੨੦'), '302020', 'Gurmukhi');
  assert.equal(digitsSaid('૩૦૨૦૨૦'), '302020', 'Gujarati');
  assert.equal(digitsSaid('three zero two oh two zero'), '302020');
  assert.equal(digitsSaid('तीन शून्य दो ज़ीरो दो जीरो'), '302020');
  assert.equal(digitsSaid('पाँच पांच छह छः सात आठ नौ एक चार'), '556678914');
  assert.equal(digitsSaid('double nine 8 triple two'), '998222');
  assert.equal(digitsSaid('डबल 9 ट्रिपल शून्य'), '99000');
  assert.equal(digitsSaid('double 20'), '220');
  assert.equal(digitsSaid('+91 98765-43210'), '919876543210');
  assert.equal(digitsSaid('not known'), '');
  assert.equal(digitsSaid(null), '');
  assert.equal(digitsSaid(302020), '302020');

  assert.equal(pinCodeSaid('30 20 20'), '302020');
  assert.equal(pinCodeSaid('३०२ ०२०'), '302020');
  assert.equal(pinCodeSaid('30 20 2'), null);
  assert.equal(pinCodeSaid('012345'), null, 'no PIN code starts with 0');
  assert.equal(pinCodeSaid(''), null);

  assert.equal(normalizePhone('98 29 01 23 45'), '+919829012345');
  assert.equal(normalizePhone('९८२९०१२३४५'), '+919829012345');
  assert.equal(normalizePhone('nine eight two nine zero one two three four five'), '+919829012345');
  assert.equal(normalizePhone('double nine 82 90 12 34'), '+919982901234');
  assert.equal(phoneEnding('९ ५ ४ ३'), '9543');
  assert.equal(lastTenDigits('०९८२९०१२३४५'), '9829012345');
});

test('a number is confirmed by its last four digits, and otherwise said back with where it comes from', () => {
  assert.equal(phoneEnding('+91 78784 54578'), '4578');
  assert.equal(phoneEnding('45'), null);
  const caller = '+917357558134';
  assert.equal(numberToConfirm(caller, { confirmedEnding: '8 1 3 4', given: caller, caller }), null);
  assert.equal(numberToConfirm(caller, { confirmedEnding: '7357558134', given: caller, caller }), null, 'the whole number has the same ending');
  assert.deepEqual(numberToConfirm(caller, { confirmedEnding: '2345', given: caller, caller }), { ending: '8134', source: 'call', confirmed: '2345' });
  assert.deepEqual(numberToConfirm('+919829012345', { given: '+919829012345', caller }), { ending: '2345', source: 'given', confirmed: null });
  assert.deepEqual(numberToConfirm('+919829012345', { caller }), { ending: '2345', source: 'file', confirmed: null });
  assert.deepEqual(numberToConfirm(null, { confirmedEnding: '' }), { ending: null, source: 'file', confirmed: null }, 'no number is never confirmed');
});

test('a placeholder is not a full name, in English or in Hindi', () => {
  for (const name of ['Unknown Customer', 'अज्ञात ग्राहक', 'अननोन कस्टमर', 'रमेश जी', 'श्री रमेश']) assert.equal(fullName(name), null, name);
  assert.equal(fullName('रमेश कुमार'), 'रमेश कुमार');
  assert.equal(fullName('श्री रमेश कुमार जी'), 'रमेश कुमार');
});

test('normalizePhone accepts Indian mobile formats and returns E.164', () => {
  assert.equal(normalizePhone('9876543210'), '+919876543210');
  assert.equal(normalizePhone('09876543210'), '+919876543210');
  assert.equal(normalizePhone('919876543210'), '+919876543210');
  assert.equal(normalizePhone('+91 98765-43210'), '+919876543210');
  assert.equal(normalizePhone('+1 415 555 0100'), '+14155550100');
});

test('normalizePhone rejects invalid numbers', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('1234567890'), null, 'Indian mobiles start with 6-9');
  assert.equal(normalizePhone('abc'), null);
});

test('lastTenDigits matches the org convention for stored mobiles', () => {
  assert.equal(lastTenDigits('(987) 654-3210'), '9876543210');
  assert.equal(lastTenDigits('+91 98765 43210'), '9876543210');
  assert.equal(lastTenDigits('12345'), null);
});

test('normalizeIssueType maps spoken aliases onto the supported issue types', () => {
  assert.equal(normalizeIssueType('missing parts'), 'missing_parts');
  assert.equal(normalizeIssueType('Part-Missing'), 'missing_parts');
  assert.equal(normalizeIssueType('broken'), 'damaged');
  assert.equal(normalizeIssueType('transit damage'), 'delivery_damage');
  assert.equal(normalizeIssueType('wrong component'), 'wrong_part');
  assert.equal(normalizeIssueType('install'), 'installation');
  assert.equal(normalizeIssueType('reschedule'), 'installation_reschedule');
  assert.equal(normalizeIssueType('refund'), 'return');
  assert.equal(normalizeIssueType('REPLACEMENT'), 'replacement');
  assert.equal(normalizeIssueType('weather'), null);
  assert.equal(normalizeIssueType(undefined), null);
});

test('a spoken name matches only with a first and a last name, allowing one wrong letter in longer words', () => {
  assert.equal(namesMatch('Aarav Sharma', 'Demo Customer - Aarav Sharma'), true);
  assert.equal(namesMatch('arav sharma', 'Aarav Sharma'), true, 'one letter dropped');
  assert.equal(namesMatch('Mr. Aarav Sarma', 'Aarav Sharma'), true, 'titles are ignored');
  assert.equal(namesMatch('Om Sai', 'Om Sai'), true);
  assert.equal(namesMatch('Om Sia', 'Om Sai'), false, 'short words must match exactly');
  assert.equal(namesMatch('Aarav', 'Aarav Sharma'), false, 'a first name alone is not enough');
  assert.equal(namesMatch('Demo Customer', 'Demo Customer - Aarav Sharma'), false, 'the sample account prefix is not a name');
  assert.equal(namesMatch('Aarav Verma', 'Aarav Sharma'), false);
  assert.equal(namesMatch('', 'Aarav Sharma'), false);
  assert.equal(namesMatch('Aarav Sharma', null), false);
});

test('names in Hindi script match names in Hindi script, and English letters match English letters', () => {
  assert.equal(namesMatch('प्रदीप चौधरी', 'प्रदीप चौधरी'), true);
  assert.equal(namesMatch('श्री प्रदीप चौधरी जी', 'प्रदीप कुमार चौधरी'), true, 'titles are ignored and a middle name on the record is fine');
  assert.equal(namesMatch('प्रदीप', 'प्रदीप चौधरी'), false, 'a first name alone is not enough');
  assert.equal(namesMatch('मीरा अय्यर', 'Meera Iyer'), false, 'scripts are not mixed; the agent sends both forms');
  assert.equal(namesMatch('Arav Sharma', 'Demo Customer - Aarav Sharma'), true);
});
