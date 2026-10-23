const express = require('express');

// Data for the staff console (web/): read-only views, and order edits. It sits behind the internal key: the console's
// own server calls it with the key, so no browser ever holds it. The console names the signed-in person in
// X-Console-User, which goes into the order's history.
module.exports = function adminRouter({ consoleData }) {
  const router = express.Router();

  const pick = (req, keys) => Object.fromEntries(
    keys.map((k) => [k, typeof req.query[k] === 'string' ? req.query[k].slice(0, 100) : undefined]),
  );
  const send = (load) => async (req, res, next) => {
    try {
      const result = await load(req);
      res.set('Cache-Control', 'no-store');
      if (result === null) return res.status(404).json({ error: 'not_found' });
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  };

  router.get('/summary', send(() => consoleData.summary()));
  router.get('/products', send((req) => consoleData.listProducts(pick(req, ['q', 'category']))));
  router.get('/products/:id', send((req) => consoleData.getProduct(req.params.id)));
  router.get('/orders', send((req) => consoleData.listOrders(pick(req, ['q', 'status', 'delivery', 'source', 'page', 'pageSize']))));
  router.get('/orders/:id', send((req) => consoleData.getOrder(req.params.id)));
  router.get('/orders/:id/edit', send((req) => consoleData.getOrderForEdit(req.params.id)));
  router.patch('/orders/:id', async (req, res, next) => {
    try {
      const editedBy = String(req.get('x-console-user') || '').replace(/[^\w@.+ -]/g, '').slice(0, 120) || 'The service console';
      const result = await consoleData.updateOrder(req.params.id, req.body, { editedBy });
      res.set('Cache-Control', 'no-store');
      if (result === null) return res.status(404).json({ error: 'not_found' });
      if (result.error === 'invalid') return res.status(400).json(result);
      if (result.error === 'rejected') return res.status(422).json(result);
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });
  router.get('/customers', send((req) => consoleData.listCustomers(pick(req, ['q', 'page', 'pageSize']))));
  router.get('/customers/:id', send((req) => consoleData.getCustomer(req.params.id)));
  router.get('/cases', send((req) => consoleData.listCases(pick(req, ['q', 'state', 'status', 'type', 'origin', 'page', 'pageSize']))));
  router.get('/cases/:id', send((req) => consoleData.getCase(req.params.id)));
  router.get('/field-service', send(() => consoleData.listFieldService()));
  router.get('/activities', send((req) => consoleData.listActivities(pick(req, ['kind', 'page', 'pageSize']))));
  router.get('/requests', send(() => consoleData.listRequests()));
  router.get('/service', send(() => consoleData.serviceSetup()));
  router.get('/caller', send((req) => consoleData.callerName(pick(req, ['phone']).phone)));

  return router;
};
