// Read-only review of the Salesforce org: objects, fields, picklists, relationships and record counts.
// Usage: node scripts/review-salesforce.js [output.json]
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { getAccessToken, sfRequest } = require('../src/salesforce');

const KEY_STANDARD_OBJECTS = [
  'Account', 'Contact', 'Lead', 'Case', 'CaseComment', 'Order', 'OrderItem', 'Product2',
  'Pricebook2', 'PricebookEntry', 'Asset', 'WorkOrder', 'WorkOrderLineItem', 'ServiceAppointment',
  'ServiceResource', 'ServiceTerritory', 'ReturnOrder', 'ReturnOrderLineItem', 'Shipment',
  'Task', 'Event', 'Entitlement', 'BusinessHours', 'Holiday', 'Queue', 'Group', 'User', 'VoiceCall',
];

async function countRecords(name) {
  try {
    const result = await sfRequest(`/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${name}`)}`);
    return result.totalSize;
  } catch (err) {
    return `error: ${err.message.slice(0, 120)}`;
  }
}

function summarizeField(field) {
  const summary = {
    name: field.name,
    label: field.label,
    type: field.type,
    custom: field.custom,
    required: !field.nillable && field.createable && !field.defaultedOnCreate,
    createable: field.createable,
    updateable: field.updateable,
  };
  if (field.length) summary.length = field.length;
  if (field.referenceTo && field.referenceTo.length) summary.referenceTo = field.referenceTo;
  if (field.relationshipName) summary.relationshipName = field.relationshipName;
  if (field.picklistValues && field.picklistValues.length) {
    summary.picklistValues = field.picklistValues.filter((p) => p.active).map((p) => p.value);
  }
  if (field.externalId) summary.externalId = true;
  if (field.unique) summary.unique = true;
  return summary;
}

async function main() {
  const outFile = process.argv[2] || 'salesforce-review.json';
  const { instanceUrl } = await getAccessToken();
  console.log(`Connected to ${instanceUrl}`);

  const global = await sfRequest('/sobjects');
  const all = global.sobjects;
  const custom = all.filter((o) => o.custom && o.queryable).map((o) => o.name);
  const standard = KEY_STANDARD_OBJECTS.filter((name) => all.some((o) => o.name === name && o.queryable));
  const missingStandard = KEY_STANDARD_OBJECTS.filter((name) => !standard.includes(name));
  const targets = [...standard, ...custom];

  console.log(`Pass 1: describing ${targets.length} objects (${custom.length} custom)`);
  const objects = {};
  for (const name of targets) {
    const describe = await sfRequest(`/sobjects/${name}/describe`);
    objects[name] = {
      label: describe.label,
      custom: describe.custom,
      createable: describe.createable,
      recordTypes: describe.recordTypeInfos.filter((r) => r.active && !r.master).map((r) => r.name),
      fields: describe.fields.map(summarizeField),
      childRelationships: describe.childRelationships
        .filter((c) => c.relationshipName)
        .map((c) => `${c.childSObject}.${c.field}`),
    };
  }

  console.log('Pass 2: counting records and checking relationships');
  for (const name of targets) {
    objects[name].recordCount = await countRecords(name);
    objects[name].brokenReferences = objects[name].fields
      .flatMap((f) => f.referenceTo || [])
      .filter((ref) => !all.some((o) => o.name === ref));
  }

  const report = {
    reviewedAt: new Date().toISOString(),
    instanceUrl,
    totalObjectsInOrg: all.length,
    customObjects: custom,
    standardObjectsReviewed: standard,
    standardObjectsNotAvailable: missingStandard,
    objects,
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`\nWrote ${outFile}`);
  for (const name of targets) {
    const o = objects[name];
    console.log(`${name.padEnd(32)} ${String(o.recordCount).padStart(8)} records  ${o.fields.length} fields${o.custom ? '  (custom)' : ''}`);
  }
  if (missingStandard.length) console.log(`\nNot available in this org: ${missingStandard.join(', ')}`);
}

main().catch((err) => {
  console.error(`Review failed: ${err.message}`);
  process.exit(1);
});
