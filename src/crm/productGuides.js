const { escapeSoql, escapeSoqlLike } = require('./crm');
const { todayInIst } = require('../dates');

// Product guides (Product_Guide__c, one per product): specifications, parts, hardware, assembly steps and rules for
// the voice agent. The console shows and edits them; the agent reads the published ones to go through a damaged or
// missing part one part at a time. Part numbers live on Product_Component__c, which service requests point to.

// The fields the console shows and edits, with the label each change is recorded under.
const GUIDE_FIELDS = {
  name: ['Name', 'Guide name'],
  status: ['Status__c', 'Status'],
  brand: ['Brand__c', 'Brand'],
  productType: ['ProductType__c', 'Product type'],
  modelCode: ['ModelCode__c', 'Model code'],
  version: ['Version__c', 'Version'],
  setContents: ['SetContents__c', 'Set contents'],
  totalParts: ['TotalParts__c', 'Total parts'],
  partsHaveNumberStickers: ['PartsHaveNumberStickers__c', 'Parts have number stickers'],
  dimensions: ['Dimensions__c', 'Dimensions'],
  colourFinish: ['ColourFinish__c', 'Colour and finish'],
  material: ['Material__c', 'Material'],
  weightCapacity: ['WeightCapacity__c', 'Weight capacity'],
  recommendedAge: ['RecommendedAge__c', 'Recommended age'],
  toolsNeeded: ['ToolsNeeded__c', 'Tools needed'],
  overview: ['Overview__c', 'Overview'],
  partsList: ['PartsList__c', 'Parts list'],
  hardwareList: ['HardwareList__c', 'Hardware list'],
  assemblySteps: ['AssemblySteps__c', 'Assembly steps'],
  hardwarePerStep: ['HardwarePerStep__c', 'Hardware per step'],
  assemblyTips: ['AssemblyTips__c', 'Tips, safety and care'],
  deliveryCheckScript: ['DeliveryCheckScript__c', 'Delivery check'],
  agentRules: ['AgentRulesForThisProduct__c', 'Rules for the voice agent'],
  warranty: ['WarrantyInformation__c', 'Warranty'],
  brandWebsite: ['BrandWebsite__c', 'Brand website'],
  brandSupportEmail: ['BrandSupportEmail__c', 'Brand support email'],
  brandSupportWhatsApp: ['BrandSupportWhatsApp__c', 'Brand support WhatsApp'],
  brandSupportHours: ['BrandSupportHours__c', 'Brand support hours'],
  assemblyVideoUrl: ['AssemblyVideoURL__c', 'Assembly video'],
  manualPdfUrl: ['ManualPDFURL__c', 'Manual (PDF)'],
  source: ['Source__c', 'Source'],
  lastReviewedOn: ['LastReviewedOn__c', 'Last reviewed on'],
};
const FIELD_NAMES = Object.values(GUIDE_FIELDS).map(([name]) => name);
const PUBLISHED = 'Published';
const ARCHIVED = 'Archived';
const SCHEMA_TTL_MS = 60 * 60 * 1000;

const isId = (value) => /^[a-zA-Z0-9]{15,18}$/.test(String(value || ''));
const quoted = (value) => `'${escapeSoql(value)}'`;

// Salesforce answers a refused save with "Salesforce request failed (400): [{message, errorCode, fields}]".
function salesforceRefusal(err) {
  const match = /^Salesforce request failed \((4\d\d)\): (.*)$/s.exec(err?.message || '');
  if (!match) return null;
  let errors = [];
  try { errors = [].concat(JSON.parse(match[2]) || []); } catch { /* not JSON */ }
  const named = errors.flatMap((e) => e.fields || []);
  const field = Object.keys(GUIDE_FIELDS).find((key) => named.includes(GUIDE_FIELDS[key][0])) || null;
  return { message: errors.map((e) => e.message).filter(Boolean).join(' ') || `Salesforce refused the change (${match[1]}).`, field };
}

// "1. Worktop x 1" lines as the agent hears them: one list, separated by semicolons.
const asList = (text) => String(text || '').split('\n')
  .map((l) => l.replace(/^\s*[-*•]\s*/, '').replace(/[.;:\s]+$/, '').trim())
  .filter(Boolean)
  .join('; ');

function createProductGuides({ salesforce, now = () => Date.now(), logger = console }) {
  let schemaCache = null;

  // The org's own rules for each guide field: type, length, digits, whether it may be empty, allowed values.
  async function schema() {
    if (schemaCache && now() - schemaCache.loadedAt < SCHEMA_TTL_MS) return schemaCache;
    const described = await salesforce.describe('Product_Guide__c');
    const fields = Object.fromEntries(FIELD_NAMES.map((name) => {
      const f = described.fields.find((x) => x.name === name) || {};
      return [name, {
        type: f.type,
        length: f.length || 0,
        precision: f.precision || 0,
        scale: f.scale || 0,
        nillable: f.nillable !== false,
        values: (f.picklistValues || []).filter((p) => p.active).map((p) => p.value),
      }];
    }));
    schemaCache = { loadedAt: now(), fields };
    return schemaCache;
  }

  async function productOf(id) {
    const [row] = await salesforce.query(`SELECT Id, Name, ProductCode FROM Product2 WHERE Id = ${quoted(id)} LIMIT 1`);
    return row ? { id: row.Id, name: row.Name, code: row.ProductCode } : null;
  }

  // The product's guide: the newest one that is not archived, else the newest archived one.
  async function guideRow(productId) {
    const rows = await salesforce.query(
      `SELECT Id, Product_Code__c, LastModifiedDate, LastModifiedBy.Name, ${FIELD_NAMES.join(', ')} FROM Product_Guide__c `
      + `WHERE Product__c = ${quoted(productId)} ORDER BY LastModifiedDate DESC LIMIT 10`,
    );
    return rows.find((r) => r.Status__c !== ARCHIVED) || rows[0] || null;
  }

  const valuesOf = (row) => Object.fromEntries(Object.entries(GUIDE_FIELDS).map(([key, [name]]) => [key, row?.[name] ?? null]));

  // The product, its guide (null when it has none) and what the edit form needs: choices, limits, required fields.
  async function getGuide(productId) {
    if (!isId(productId)) return null;
    const product = await productOf(productId);
    if (!product) return null;
    const [row, { fields }] = await Promise.all([guideRow(productId), schema()]);
    const meta = (key) => fields[GUIDE_FIELDS[key][0]];
    return {
      product,
      guide: row ? { id: row.Id, values: valuesOf(row), lastModified: row.LastModifiedDate, lastModifiedBy: row.LastModifiedBy?.Name || null } : null,
      form: {
        labels: Object.fromEntries(Object.entries(GUIDE_FIELDS).map(([key, [, label]]) => [key, label])),
        types: Object.fromEntries(Object.keys(GUIDE_FIELDS).map((key) => [key, meta(key).type])),
        options: { status: meta('status').values, productType: meta('productType').values },
        maxLengths: Object.fromEntries(Object.keys(GUIDE_FIELDS).filter((key) => meta(key).length).map((key) => [key, meta(key).length])),
        required: Object.keys(GUIDE_FIELDS).filter((key) => !meta(key).nillable && meta(key).type !== 'boolean'),
      },
    };
  }

  function checkValue(key, raw, meta) {
    const [, label] = GUIDE_FIELDS[key];
    if (meta.type === 'boolean') {
      if (typeof raw === 'boolean') return { value: raw };
      if (raw === null || ['', 'false', 'off'].includes(raw)) return { value: false };
      if (['true', 'on'].includes(raw)) return { value: true };
      return { error: `${label} must be yes or no.` };
    }
    if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number') return { error: `${label} must be text.` };
    const value = raw === null ? null : String(raw).replace(/\r\n?/g, '\n').trim() || null;
    if (value === null) return meta.nillable ? { value } : { error: `${label} cannot be empty.` };
    if (meta.type === 'double') {
      const n = Number(value);
      const whole = meta.precision - meta.scale;
      if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(n)) return { error: `${label} must be a number.` };
      if (whole > 0 && Math.trunc(n).toString().length > whole) return { error: `${label} is too large.` };
      return { value: n };
    }
    if (meta.type === 'date') {
      const day = new Date(`${value}T00:00:00Z`);
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
      return valid ? { value } : { error: `${label} must be a date.` };
    }
    if (meta.type === 'picklist') return meta.values.includes(value) ? { value } : { error: `${label} must be one of: ${meta.values.join(', ')}.` };
    if (meta.length && value.length > meta.length) return { error: `${label} can be at most ${meta.length} characters.` };
    if (meta.type === 'url' && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(value)) return { error: `${label} must be a web address starting with https://.` };
    if (meta.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { error: `${label} must be an email address.` };
    if (meta.type === 'phone' && !/^\+?[\d\s()-]{8,20}$/.test(value)) return { error: `${label} must be a phone number.` };
    return { value };
  }

  // Creates the product's guide or saves what staff changed on it. Only the fields in GUIDE_FIELDS are accepted, each
  // value is checked against the org's own rules first, only real changes are sent, and a completed task on the guide
  // records who changed what (every console save reaches Salesforce as the integration user).
  async function saveGuide(productId, changes, { editedBy = 'The service console' } = {}) {
    if (!isId(productId)) return null;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return { error: 'invalid', message: 'Send the guide as a JSON object.' };
    }
    const unknown = Object.keys(changes).filter((k) => !Object.hasOwn(GUIDE_FIELDS, k));
    if (unknown.length) return { error: 'invalid', field: unknown[0], message: `These cannot be changed here: ${unknown.join(', ')}.` };

    const product = await productOf(productId);
    if (!product) return null;
    const [row, { fields: metas }] = await Promise.all([guideRow(productId), schema()]);

    const fields = {};
    const changed = [];
    for (const [key, raw] of Object.entries(changes)) {
      if (raw === undefined) continue;
      const [name, label] = GUIDE_FIELDS[key];
      const checked = checkValue(key, raw, metas[name]);
      if (checked.error) return { error: 'invalid', field: key, message: checked.error };
      const before = row ? row[name] ?? null : null;
      if (checked.value === before || (!row && checked.value === null)) continue;
      fields[name] = checked.value;
      changed.push({ field: key, label, from: before, to: checked.value });
    }

    if (!row) {
      const missing = Object.keys(GUIDE_FIELDS).find((key) => {
        const meta = metas[GUIDE_FIELDS[key][0]];
        return !meta.nillable && meta.type !== 'boolean' && (fields[GUIDE_FIELDS[key][0]] ?? null) === null;
      });
      if (missing) return { error: 'invalid', field: missing, message: `${GUIDE_FIELDS[missing][1]} cannot be empty.` };
    } else if (!changed.length) {
      return { updated: false, created: false, changes: [], guide: (await getGuide(productId)).guide };
    }

    let guideId = row?.Id;
    try {
      if (row) {
        await salesforce.update('Product_Guide__c', guideId, fields);
      } else {
        const created = await salesforce.create('Product_Guide__c', {
          Name: `${product.name} guide`.slice(0, 80),
          ...fields,
          Product__c: product.id,
          Product_Code__c: product.code,
        });
        guideId = created.id;
      }
    } catch (err) {
      const refusal = salesforceRefusal(err);
      if (refusal) return { error: 'rejected', ...refusal };
      throw err;
    }

    const shown = (value) => {
      if (value === null) return '(empty)';
      const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
      return text.length > 200 ? `${text.slice(0, 200)}…` : text;
    };
    await salesforce.create('Task', {
      WhatId: guideId,
      Subject: row ? 'Product guide edited in the service console' : 'Product guide added in the service console',
      Description: [`${editedBy} ${row ? 'changed' : 'added'}:`, ...changed.map((c) => `- ${c.label}: ${row ? `${shown(c.from)} → ` : ''}${shown(c.to)}`)].join('\n'),
      Status: 'Completed',
      Priority: 'Normal',
      ActivityDate: todayInIst(now()).toISOString().slice(0, 10),
    }).catch((err) => logger.error(`Product guide ${guideId} was saved, but its history note failed: ${err.message}`));

    return { updated: Boolean(row), created: !row, changes: changed, guide: (await getGuide(productId)).guide };
  }

  // Active catalogue products whose name contains what the customer said ("kitchen island").
  async function findProductIds(productName) {
    const words = String(productName || '').trim();
    if (!words) return [];
    const rows = await salesforce.query(
      `SELECT Id FROM Product2 WHERE IsActive = true AND Name LIKE '%${escapeSoqlLike(words)}%' ORDER BY Name LIMIT 5`,
    );
    return rows.map((r) => r.Id);
  }

  // The published guides of these products, each with the product's parts on record, for the voice agent.
  async function publishedFor(productIds) {
    const ids = [...new Set(productIds.filter(isId))];
    if (!ids.length) return [];
    const list = ids.map(quoted).join(', ');
    const [guides, parts] = await Promise.all([
      salesforce.query(
        `SELECT Id, Product__c, Product__r.Name, ${FIELD_NAMES.join(', ')} FROM Product_Guide__c `
        + `WHERE Product__c IN (${list}) AND Status__c = '${PUBLISHED}' ORDER BY LastModifiedDate DESC`,
      ),
      salesforce.query(`SELECT Product__c, Name, Part_Number__c FROM Product_Component__c WHERE Product__c IN (${list}) ORDER BY Part_Number__c`),
    ]);
    const seen = new Set();
    return guides.filter((g) => !seen.has(g.Product__c) && seen.add(g.Product__c)).map((g) => ({
      productName: g.Product__r?.Name || null,
      ...valuesOf(g),
      parts: parts.filter((p) => p.Product__c === g.Product__c).map((p) => ({ name: String(p.Name || '').split(' - ').pop(), partNumber: p.Part_Number__c })),
    }));
  }

  return { getGuide, saveGuide, findProductIds, publishedFor };
}

// What the agent hears about a guide: the parts with their sticker numbers and part numbers, the hardware, and the
// rules for this product. Assembly steps are left out; they are for the service team and the customer's manual.
function guideMessage(guide) {
  const brand = guide.brand ? ` by ${guide.brand}` : '';
  const lines = [`Product guide for the ${guide.productName}${brand}.`];
  if (guide.partsHaveNumberStickers) lines.push('Every part carries a number sticker.');
  if (guide.partsList) lines.push(`Parts: ${asList(guide.partsList)}.`);
  const listed = `${guide.partsList || ''}\n${guide.hardwareList || ''}`;
  const unlisted = guide.parts.filter((p) => p.partNumber && !listed.includes(p.partNumber));
  if (unlisted.length) lines.push(`Part numbers on record: ${unlisted.map((p) => `${p.name}, ${p.partNumber}`).join('; ')}.`);
  if (guide.hardwareList) lines.push(`Hardware: ${asList(guide.hardwareList)}.`);
  if (guide.agentRules) lines.push(`Rules for this product: ${asList(guide.agentRules)}.`);
  return lines.join(' ');
}

module.exports = { createProductGuides, guideMessage, GUIDE_FIELDS };
