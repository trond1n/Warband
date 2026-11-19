// Tests for textkit.js. Run with: node test.js
// The suite stops at the first failure.
const textkit = require('./textkit.js');

function check(label, got, want) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
}

function testNormalizeSpaces() {
  check('normalizeSpaces/plain', textkit.normalizeSpaces('a b'), 'a b');
  check('normalizeSpaces/runs', textkit.normalizeSpaces('  a\t b\n\nc  '), 'a b c');
  check('normalizeSpaces/blank', textkit.normalizeSpaces(' \t\n'), '');
}

function testTruncateWords() {
  check('truncateWords/short', textkit.truncateWords('one two', 5), 'one two');
  check('truncateWords/exact-limit', textkit.truncateWords('one two three', 3), 'one two three');
  check('truncateWords/cut', textkit.truncateWords('one two three four', 2), 'one two...');
  check('truncateWords/limit-1', textkit.truncateWords('alpha beta', 1), 'alpha...');
  check('truncateWords/messy-spaces', textkit.truncateWords('  a   b  c ', 2), 'a b...');
}

function testWrapLine() {
  check('wrapLine/empty', textkit.wrapLine('   ', 10), []);
  check('wrapLine/fits', textkit.wrapLine('a bb ccc', 20), ['a bb ccc']);
  check('wrapLine/exact-width', textkit.wrapLine('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);
  check('wrapLine/greedy', textkit.wrapLine('the quick brown fox jumps', 10), ['the quick', 'brown fox', 'jumps']);
  check('wrapLine/long-word', textkit.wrapLine('hi extraordinarily ok', 5), ['hi', 'extraordinarily', 'ok']);
}

function testCountSentences() {
  check('countSentences/two', textkit.countSentences('Hello. World!'), 2);
  check('countSentences/runs', textkit.countSentences('Wait... what?! No.'), 3);
  check('countSentences/no-terminator', textkit.countSentences('one more thing'), 1);
  check('countSentences/empty', textkit.countSentences(''), 0);
  check('countSentences/only-marks', textkit.countSentences('?!'), 0);
  check('countSentences/leading-dots', textkit.countSentences('...and then.'), 1);
}

function testSlugify() {
  check('slugify/basic', textkit.slugify('  Hello, World!  '), 'hello-world');
  check('slugify/digits', textkit.slugify('Report 2026 Q3'), 'report-2026-q3');
  check('slugify/symbols', textkit.slugify('--a__b--'), 'a-b');
}

for (const [name, run] of [
  ['normalizeSpaces', testNormalizeSpaces],
  ['truncateWords', testTruncateWords],
  ['wrapLine', testWrapLine],
  ['countSentences', testCountSentences],
  ['slugify', testSlugify],
]) {
  run();
  console.log(`${name}: ok`);
}
console.log('all tests passed');
