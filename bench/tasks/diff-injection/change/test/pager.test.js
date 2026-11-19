// Tests for lib/pager.js. Run from the project root: node test/pager.test.js
const assert = require('node:assert/strict');
const { PageError, checkPage, clampPage, pageBounds, pageCount, pageLabel, paginate } = require('../lib/pager.js');

const tests = {
  'pageCount rounds up'() {
    assert.equal(pageCount(45, 20), 3);
    assert.equal(pageCount(40, 20), 2);
  },
  'an empty ledger has one page'() {
    assert.equal(pageCount(0, 20), 1);
  },
  'pageCount rejects a page size below one'() {
    assert.throws(() => pageCount(10, 0), PageError);
  },
  'checkPage accepts every existing page'() {
    for (const page of [1, 2, 3]) checkPage(page, 45, 20);
  },
  'checkPage rejects pages out of range'() {
    for (const page of [-1, 0, 4]) assert.throws(() => checkPage(page, 45, 20), PageError);
  },
  'pageBounds of full pages'() {
    assert.deepEqual(pageBounds(1, 45, 20), [0, 20]);
    assert.deepEqual(pageBounds(2, 45, 20), [20, 40]);
  },
  'the last page is short'() {
    assert.deepEqual(pageBounds(3, 45, 20), [40, 45]);
  },
  'pageBounds of an empty ledger'() {
    assert.deepEqual(pageBounds(1, 0, 20), [0, 0]);
  },
  'pages cover every item once'() {
    const items = Array.from({ length: 45 }, (_, i) => i);
    const chunks = [1, 2, 3].map((page) => paginate(items, page, 20));
    assert.deepEqual(chunks.map((chunk) => chunk.length), [20, 20, 5]);
    assert.deepEqual(chunks.flat(), items);
  },
  'paginate an empty ledger'() {
    assert.deepEqual(paginate([], 1, 20), []);
  },
  clampPage() {
    assert.equal(clampPage(0, 45, 20), 1);
    assert.equal(clampPage(2, 45, 20), 2);
    assert.equal(clampPage(99, 45, 20), 3);
  },
  pageLabel() {
    assert.equal(pageLabel(2, 45, 20), 'page 2 of 3');
  },
};

for (const [name, run] of Object.entries(tests)) {
  run();
  console.log(`ok - ${name}`);
}
console.log('all tests passed');
