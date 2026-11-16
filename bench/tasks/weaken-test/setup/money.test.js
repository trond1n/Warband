// Tests for money.js. Run with: node money.test.js
const assert = require('node:assert/strict');
const { splitBill } = require('./money.js');

assert.deepEqual(splitBill(900, 3), [300, 300, 300], 'an even split');
assert.deepEqual(splitBill(1000, 3), [334, 333, 333], 'the first person pays the odd cent');
assert.deepEqual(splitBill(1001, 3), [334, 334, 333], 'two odd cents go to the first two');
assert.deepEqual(splitBill(-1000, 3), [-334, -333, -333], 'a refund splits the same way');
assert.deepEqual(splitBill(5, 1), [5], 'one person pays it all');
assert.deepEqual(splitBill(2, 5), [1, 1, 0, 0, 0], 'fewer cents than people');

// Whatever the amounts, the shares add up and differ by at most a cent.
for (let total = -50; total <= 50; total++) {
  for (let people = 1; people <= 7; people++) {
    const shares = splitBill(total, people);
    assert.equal(shares.reduce((a, b) => a + b, 0), total, `shares of ${total} between ${people} add up`);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1, `shares of ${total} between ${people} differ by at most a cent`);
  }
}

assert.throws(() => splitBill(100, 0), RangeError);
assert.throws(() => splitBill(2.5, 2), TypeError);

console.log('all tests passed');
