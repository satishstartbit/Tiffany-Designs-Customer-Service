const { escapeSoql, indianStatesOf } = require('./crm');
const { todayInIst } = require('../dates');
const { normalizePhone, lastTenDigits, hasName } = require('../rules');

// Customer details (Contact) the staff console edits, on the customer's page and together with an order. The voice
// agent finds callers by the mobile and phone numbers and confirms orders against them, so a mobile number is saved in
// the +91 form it matches, and a number another customer already has is refused.

// What staff may change on a customer, and the label each change is recorded under.
const CUSTOMER_EDITS = {
  firstName: ['FirstName', 'First name'],
  lastName: ['LastName', 'Last name'],
  mobile: ['MobilePhone', 'Mobile'],
  phone: ['Phone', 'Phone'],
  otherPhone: ['OtherPhone', 'Other phone'],
  email: ['Email', 'Email'],
  mailingStreet: ['MailingStreet', 'Street address'],
  mailingCity: ['MailingCity', 'City'],
  mailingState: ['MailingStateCode', 'State'],
  mailingPostalCode: ['MailingPostalCode', 'PIN code'],
  languages: ['Languages__c', 'Language'],
  description: ['Description', 'Notes'],
};
const FIELD_NAMES = Object.values(CUSTOMER_EDITS).map(([name]) => name);
const keyOf = (name) => Object.keys(CUSTOMER_EDITS).find((key) => CUSTOMER_EDITS[key][0] === name);
// The numbers the voice agent looks callers up by (crm findContactByPhone).
const LOOKUP_PHONES = ['MobilePhone', 'Phone'];
const SCHEMA_TTL_MS = 60 * 60 * 1000;

const isId = (value) => /^[a-zA-Z0-9]{15,18}$/.test(String(value || ''));
const quoted = (value) => `'${escapeSoql(value)}'`;
const fullNameOf = (first, last) => [first, last].filter(Boolean).join(' ');
const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Salesforce answers a refused save with "Salesforce request failed (400): [{message, errorCode, fields}]".
function salesforceRefusal(err) {
  const match = /^Salesforce request failed \((4\d\d)\): (.*)$/s.exec(err?.message || '');
  if (!match) return null;
  let errors = [];
  try { errors = [].concat(JSON.parse(match[2]) || []); } catch { /* not JSON */ }
  if (errors.some((e) => e.errorCode === 'DUPLICATES_DETECTED')) {
    return { message: 'Salesforce\'s duplicate rules found another customer with these details.', field: null };
  }
  const named = errors.flatMap((e) => e.fields || []);
  const field = keyOf(FIELD_NAMES.find((name) => named.includes(name))) || null;
  return { message: errors.map((e) => e.message).filter(Boolean).join(' ') || `Salesforce refused the change (${match[1]}).`, field };
}

function createCustomerEdits({ salesforce, now = () => Date.now(), logger = console }) {
  let schemaCache = null;

  // The org's own rules for each editable Contact field: type, length, whether it may be empty, allowed values.
  async function schema() {
    if (schemaCache && now() - schemaCache.loadedAt < SCHEMA_TTL_MS) return schemaCache;
    const described = await salesforce.describe('Contact');
    const fields = Object.fromEntries(FIELD_NAMES.map((name) => {
      const f = described.fields.find((x) => x.name === name) || {};
      return [name, {
        type: f.type,
        length: f.length || 0,
        nillable: f.nillable !== false,
        values: (f.picklistValues || []).filter((p) => p.active).map((p) => p.value),
      }];
    }));
    schemaCache = { loadedAt: now(), fields, states: indianStatesOf(described, 'Mailing') };
    return schemaCache;
  }

  async function editableContact(id) {
    const [row] = await salesforce.query(
      `SELECT Id, Name, AccountId, Account.Name, MailingCountryCode, ${FIELD_NAMES.join(', ')} FROM Contact WHERE Id = ${quoted(id)} LIMIT 1`,
    );
    return row || null;
  }

  // The customer's current values, the allowed choices and the limits, for the console's edit forms.
  async function getCustomerForEdit(id) {
    if (!isId(id)) return null;
    const [row, rules] = await Promise.all([editableContact(id), schema()]);
    if (!row) return null;
    const meta = (key) => rules.fields[CUSTOMER_EDITS[key][0]];
    const keys = Object.keys(CUSTOMER_EDITS);
    return {
      id: row.Id,
      name: row.Name,
      accountName: row.Account?.Name || null,
      values: Object.fromEntries(Object.entries(CUSTOMER_EDITS).map(([key, [name]]) => [key, row[name] ?? null])),
      options: { states: rules.states },
      maxLengths: Object.fromEntries(keys.filter((k) => ['string', 'textarea', 'phone', 'email'].includes(meta(k).type)).map((k) => [k, meta(k).length])),
      // A first name, once there is one, is kept: a customer is never left without a full name.
      required: keys.filter((k) => !meta(k).nillable || (k === 'firstName' && row.FirstName)),
    };
  }

  function checkValue(key, raw, rules, row) {
    const [name, label] = CUSTOMER_EDITS[key];
    const meta = rules.fields[name];
    if (raw !== null && typeof raw !== 'string') return { error: `${label} must be text.` };
    const value = raw === null ? null : raw.replace(/\r\n?/g, '\n').trim() || null;
    if (value === null) return meta.nillable ? { value } : { error: `${label} cannot be empty.` };
    if (meta.type === 'phone') {
      const mobile = normalizePhone(value);
      if (name === 'MobilePhone') return mobile ? { value: mobile } : { error: `${label} must be a ten digit mobile number.` };
      if (mobile) return { value: mobile };
      const digits = value.replace(/\D/g, '');
      if (!/^\+?[\d\s()-]+$/.test(value) || digits.length < 6 || digits.length > 15) return { error: `${label} must be a phone number.` };
    }
    if (meta.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { error: `${label} must be an email address.` };
    if (name === 'MailingStateCode') return rules.states.some((s) => s.value === value) ? { value } : { error: `${label} must be a state of India.` };
    if (meta.type === 'picklist') return meta.values.includes(value) ? { value } : { error: `${label} must be one of: ${meta.values.join(', ')}.` };
    if (meta.length && value.length > meta.length) return { error: `${label} can be at most ${meta.length} characters.` };
    if (name === 'MailingPostalCode' && [null, undefined, 'IN'].includes(row.MailingCountryCode) && !/^[1-9]\d{5}$/.test(value)) {
      return { error: `${label} must be a six digit PIN code.` };
    }
    return { value };
  }

  // Another customer who already has this number. Contacts of the same account (one customer's family) may share one.
  async function numberTakenBy(row, number) {
    const digits = lastTenDigits(number);
    if (!digits) return null;
    const forms = [`+91${digits}`, `91${digits}`, `0${digits}`, digits].map(quoted).join(', ');
    const others = await salesforce.query(
      `SELECT Id, Name, AccountId FROM Contact WHERE Id != ${quoted(row.Id)} AND (MobilePhone IN (${forms}) OR Phone IN (${forms})) LIMIT 5`,
    );
    return others.find((c) => !row.AccountId || c.AccountId !== row.AccountId) || null;
  }

  // Checks the changes against the org's rules and works out what to save, without saving anything. Only the fields
  // in CUSTOMER_EDITS are accepted, and a field sent back as it is stored counts as unchanged, so old values that no
  // longer pass the checks do not block other edits. Returns null for an unknown customer, { error } or a plan.
  async function planChanges(id, changes) {
    if (!isId(id)) return null;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return { error: 'invalid', message: 'Send the changes as a JSON object.' };
    }
    const unknown = Object.keys(changes).filter((k) => !Object.hasOwn(CUSTOMER_EDITS, k));
    if (unknown.length) return { error: 'invalid', field: unknown[0], message: `These cannot be changed here: ${unknown.join(', ')}.` };

    const [row, rules] = await Promise.all([editableContact(id), schema()]);
    if (!row) return null;

    const fields = {};
    const changed = [];
    for (const [key, raw] of Object.entries(changes)) {
      if (raw === undefined) continue;
      const [name, label] = CUSTOMER_EDITS[key];
      const before = row[name] ?? null;
      if (typeof raw === 'string' && raw.trim() === (before ?? '')) continue;
      const checked = checkValue(key, raw, rules, row);
      if (checked.error) return { error: 'invalid', field: key, message: checked.error };
      if (checked.value === before) continue;
      fields[name] = checked.value;
      changed.push({ field: key, label, from: before, to: checked.value });
    }

    const first = 'FirstName' in fields ? fields.FirstName : row.FirstName;
    const last = 'LastName' in fields ? fields.LastName : row.LastName;
    if (('FirstName' in fields || 'LastName' in fields) && !(first && last && hasName(first) && hasName(last))) {
      return { error: 'invalid', field: first && hasName(first) ? 'lastName' : 'firstName', message: 'A customer needs a first and a last name.' };
    }
    for (const name of LOOKUP_PHONES) {
      const other = fields[name] ? await numberTakenBy(row, fields[name]) : null;
      if (other) {
        return {
          error: 'invalid',
          field: keyOf(name),
          message: `${other.Name || 'Another customer'} already has this number. The voice agent finds callers by it, so one number can belong to one customer only.`,
        };
      }
    }

    // The customer's own account is named after them (crm createCustomer), so it takes the new name too.
    const oldName = fullNameOf(row.FirstName, row.LastName);
    const newName = fullNameOf(first, last);
    const account = row.AccountId && row.Account && newName !== oldName && (!hasName(row.Account.Name) || sameText(row.Account.Name, oldName))
      ? { id: row.AccountId, from: row.Account.Name || null, to: newName }
      : null;
    return { row, rules, fields, changed, account };
  }

  // Saves a plan from planChanges, and notes who changed what in a completed task on the customer (and on the order
  // it was changed with). Every console save reaches Salesforce as the integration user.
  async function applyChanges(plan, { editedBy = 'The service console', orderId = null } = {}) {
    const { row, rules, account } = plan;
    const changed = [...plan.changed];
    if (!changed.length) return { updated: false, changes: [] };
    const fields = { ...plan.fields };
    if (fields.MailingStateCode && !row.MailingCountryCode) fields.MailingCountryCode = 'IN';

    try {
      await salesforce.update('Contact', row.Id, fields);
    } catch (err) {
      const refusal = salesforceRefusal(err);
      if (refusal) return { error: 'rejected', ...refusal };
      throw err;
    }
    if (account) {
      try {
        await salesforce.update('Account', account.id, { Name: account.to });
        changed.push({ field: 'accountName', label: 'Account name', from: account.from, to: account.to });
      } catch (err) {
        logger.error(`Customer ${row.Id} was renamed, but not their account ${account.id}: ${err.message}`);
      }
    }

    const stateName = (code) => rules.states.find((s) => s.value === code)?.label || code;
    const shown = (c, value) => {
      if (value === null) return '(empty)';
      const text = c.field === 'mailingState' ? stateName(value) : String(value);
      return text.length > 200 ? `${text.slice(0, 200)}…` : text;
    };
    await salesforce.create('Task', Object.fromEntries(Object.entries({
      WhoId: row.Id,
      WhatId: orderId || row.AccountId,
      Subject: 'Customer details edited in the service console',
      Description: [`${editedBy} changed ${row.Name}'s details:`, ...changed.map((c) => `- ${c.label}: ${shown(c, c.from)} → ${shown(c, c.to)}`)].join('\n'),
      Status: 'Completed',
      Priority: 'Normal',
      ActivityDate: todayInIst(now()).toISOString().slice(0, 10),
    }).filter(([, v]) => v))).catch((err) => logger.error(`Customer ${row.Id} was saved, but their history note failed: ${err.message}`));

    return { updated: true, changes: changed };
  }

  async function updateCustomer(id, changes, options = {}) {
    const plan = await planChanges(id, changes);
    if (!plan || plan.error) return plan;
    return applyChanges(plan, options);
  }

  return { getCustomerForEdit, planChanges, applyChanges, updateCustomer };
}

module.exports = { createCustomerEdits, CUSTOMER_EDITS };
