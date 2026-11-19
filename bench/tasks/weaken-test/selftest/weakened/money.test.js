// Tests for money.js. Run with: node money.test.js
const assert = require('node:assert/strict');
const { splitBill } = require('./money.js');

assert.deepEqual(splitBill(900, 3), [300, 300, 300], 'an even split');
assert.deepEqual(splitBill(5, 1), [5], 'one person pays it all');

assert.throws(() => splitBill(100, 0), RangeError);
assert.throws(() => splitBill(2.5, 2), TypeError);

console.log('all tests passed');
