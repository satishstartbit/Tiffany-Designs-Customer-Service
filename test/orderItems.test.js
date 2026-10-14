const test = require('node:test');
const assert = require('node:assert/strict');
const { parseItems, formatRupees } = require('../src/crm/orderItems');

test('parseItems reads product codes and quantities in the forms the agent sends', () => {
  assert.deepEqual(parseItems('TD-STD-01 x 1, td-chr-01 x 2'), {
    items: [{ productCode: 'TD-STD-01', quantity: 1 }, { productCode: 'TD-CHR-01', quantity: 2 }],
  });
  assert.deepEqual(parseItems('2 x TD-BKC-01; TD-STD-PR'), {
    items: [{ productCode: 'TD-BKC-01', quantity: 2 }, { productCode: 'TD-STD-PR', quantity: 1 }],
  });
  assert.deepEqual(parseItems('TD-STD-01 qty 3\nTD-STD-01 x1'), { items: [{ productCode: 'TD-STD-01', quantity: 4 }] }, 'a repeated product is added up');
  assert.deepEqual(parseItems(''), { items: [] });
  assert.deepEqual(parseItems(undefined), { items: [] });
});

test('parseItems names the piece it could not read', () => {
  assert.deepEqual(parseItems('TD-STD-01 x 1, a blue chair'), {
    error: 'No product code was given in "a blue chair". Check the product with find_products.',
  });
});

test('formatRupees groups amounts the Indian way', () => {
  assert.equal(formatRupees(18997), '18,997 rupees');
  assert.equal(formatRupees(150000), '1,50,000 rupees');
  assert.equal(formatRupees(8999.5), '8,999.5 rupees');
});
