// Tests for inventory.js. Run with: node test.js
const assert = require('node:assert/strict');
const { Inventory } = require('./inventory.js');

const shop = new Inventory();
shop.add('tea', 10);
assert.equal(shop.quantity('tea'), 10);
assert.equal(shop.remove('tea', 3), 7);
assert.throws(() => shop.remove('tea', 8), RangeError);
assert.throws(() => shop.add('tea', 1), Error);
assert.equal(shop.quantity('coffee'), 0);

console.log('all tests passed');
