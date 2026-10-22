const { escapeSoql, requestKind } = require('./crm');
const { todayInIst } = require('../dates');

// Left on an order when its delivery check call is placed. It lives in Salesforce rather than the job store, which
// Render loses on every restart, so an order is never called twice.
const CALL_MARKER_SUBJECT = 'AI delivery check call';
const MAX_ORDERS = 200;

const idList = (ids) => ids.map((id) => `'${escapeSoql(id)}'`).join(', ');

function toCustomer(row) {
  if (!row || !(row.MobilePhone || row.Phone)) return null;
  return {
    id: row.Id,
    name: [row.FirstName, row.LastName].filter(Boolean).join(' ') || null,
    mobile: row.MobilePhone || null,
    phone: row.Phone || null,
  };
}

function createDeliveredOrders({ salesforce, now = () => Date.now() }) {
  // Orders marked Delivered with a delivery date on or after `sinceDate` (YYYY-MM-DD), each with the customer to call:
  // the contact who authorised the order, else the account's first contact with a number, as getOrderContact picks.
  async function findDelivered(sinceDate) {
    const rows = await salesforce.query(
      'SELECT Id, OrderNumber, ERP_Order_Id__c, Delivery_Status__c, Delivery_Date__c, LastModifiedDate, AccountId, ShippingCity, '
      + 'CustomerAuthorizedById, CustomerAuthorizedBy.FirstName, CustomerAuthorizedBy.LastName, CustomerAuthorizedBy.MobilePhone, '
      + `CustomerAuthorizedBy.Phone FROM Order WHERE Delivery_Status__c = 'Delivered' AND Delivery_Date__c >= ${sinceDate} `
      + `ORDER BY Delivery_Date__c, LastModifiedDate LIMIT ${MAX_ORDERS}`,
    );
    const authorised = (r) => toCustomer(r.CustomerAuthorizedBy && { ...r.CustomerAuthorizedBy, Id: r.CustomerAuthorizedById });
    const accounts = [...new Set(rows.filter((r) => !authorised(r) && r.AccountId).map((r) => r.AccountId))];
    const byAccount = {};
    if (accounts.length) {
      const contacts = await salesforce.query(
        `SELECT Id, FirstName, LastName, AccountId, MobilePhone, Phone FROM Contact WHERE AccountId IN (${idList(accounts)}) `
        + 'AND (MobilePhone != null OR Phone != null) ORDER BY CreatedDate',
      );
      for (const c of contacts) byAccount[c.AccountId] ||= toCustomer(c);
    }
    return rows.map((r) => ({
      id: r.Id,
      orderNumber: r.OrderNumber,
      erpOrderId: r.ERP_Order_Id__c,
      deliveryStatus: r.Delivery_Status__c,
      deliveryDate: r.Delivery_Date__c,
      lastModified: r.LastModifiedDate,
      city: r.ShippingCity,
      customer: authorised(r) || byAccount[r.AccountId] || null,
    }));
  }

  // Product names per order, joined for the agent to say.
  async function productNames(orderIds) {
    if (!orderIds.length) return {};
    const rows = await salesforce.query(`SELECT OrderId, Product2.Name FROM OrderItem WHERE OrderId IN (${idList(orderIds)})`);
    const names = {};
    for (const r of rows) if (r.Product2?.Name) (names[r.OrderId] ||= []).push(r.Product2.Name);
    return Object.fromEntries(Object.entries(names).map(([id, list]) => [id, [...new Set(list)].join(', ')]));
  }

  // Orders with an open installation, damage or replacement request.
  async function withOpenRequests(orderIds) {
    if (!orderIds.length) return new Set();
    const rows = await salesforce.query(
      `SELECT Order__c, Service_Type__c, Service_Sub_Type__c FROM Case WHERE Order__c IN (${idList(orderIds)}) AND IsClosed = false`,
    );
    return new Set(rows.filter((r) => requestKind(r.Service_Type__c, r.Service_Sub_Type__c)).map((r) => r.Order__c));
  }

  async function alreadyCalled(orderIds) {
    if (!orderIds.length) return new Set();
    const rows = await salesforce.query(
      `SELECT WhatId FROM Task WHERE WhatId IN (${idList(orderIds)}) AND Subject = '${escapeSoql(CALL_MARKER_SUBJECT)}'`,
    );
    return new Set(rows.map((r) => r.WhatId));
  }

  async function markCalled({ orderId, contactId }) {
    const created = await salesforce.create('Task', {
      Subject: CALL_MARKER_SUBJECT,
      WhatId: orderId,
      ...(contactId ? { WhoId: contactId } : {}),
      Status: 'Completed',
      Priority: 'Normal',
      ActivityDate: todayInIst(now()).toISOString().slice(0, 10),
      Description: 'The AI voice agent called the customer to check that every part was delivered and to offer installation. '
        + 'The call itself is logged as a separate call activity when it ends.',
    });
    return created.id;
  }

  const unmark = (taskId) => salesforce.remove('Task', taskId);

  return { findDelivered, productNames, withOpenRequests, alreadyCalled, markCalled, unmark };
}

module.exports = { createDeliveredOrders, CALL_MARKER_SUBJECT };
