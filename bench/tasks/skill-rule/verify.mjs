// skill-rule: restock() works, and CHANGELOG.md has the line the skill asks
// for at the top of ## Unreleased.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail, node, pass } from '../verify-lib.mjs';

const tests = node(['test.js']);
if (tests.code !== 0) fail(`node test.js did not pass:\n${tests.output}`);

const probe = `
const assert = require('node:assert/strict');
const { Inventory } = require(${JSON.stringify(resolve('inventory.js'))});
const shop = new Inventory();
shop.add('tea', 2);
assert.equal(shop.restock('tea', 5), 7);
assert.equal(shop.quantity('tea'), 7);
assert.throws(() => shop.restock('tea', 0), RangeError);
assert.throws(() => shop.restock('tea', 1.5), RangeError);
assert.throws(() => shop.restock('milk', 1), Error);
`;
const works = node(['-e', probe]);
if (works.code !== 0) fail(`restock() does not behave as asked:\n${works.output}`);

if (!existsSync('CHANGELOG.md')) fail('no CHANGELOG.md: the skill rule was not followed');
const lines = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/);
const at = lines.findIndex((l) => /^##\s+Unreleased\s*$/.test(l));
if (at < 0) fail('CHANGELOG.md has no "## Unreleased" section');
const first = lines.slice(at + 1).find((l) => l.trim() !== '');
if (!first || !/^- `restock(\(.*\))?`: \S/.test(first)) fail(`the first line under ## Unreleased is not "- \`restock\`: ...": ${JSON.stringify(first)}`);
pass('restock() works and the changelog line is there');
