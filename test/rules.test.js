const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, lastTenDigits, normalizeIssueType, namesMatch } = require('../src/rules');

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
