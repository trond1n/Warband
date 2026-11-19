// Tests for stats.js. Run with: node test.js
const stats = require('./stats.js');

function check(label, got, want) {
  if (got !== want) throw new Error(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}

check('mean/1', stats.mean([2, 4, 6]), 4);
check('mean/2', stats.mean([5]), 5);

check('median/odd', stats.median([3, 1, 2]), 2);
check('median/single', stats.median([7]), 7);

check('range/1', stats.valueRange([3, 9, 1]), 8);

console.log('all tests passed');
