import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseToml } from './toml.ts';

test('the TOML that task files use', () => {
  const doc = parseToml(`# a task
[task]
timeout_seconds = 300   # five minutes
tags = ["edit", 'verify-loop',
  "hard",]
source = "mark2 T04 \\"fix-bug-test\\" (MIT)"
weight = 1.5
scripted = false

[expect]
verify = "pass"

[variants.with-skill]
skill = true
`);
  assert.deepEqual(doc, {
    task: { timeout_seconds: 300, tags: ['edit', 'verify-loop', 'hard'], source: 'mark2 T04 "fix-bug-test" (MIT)', weight: 1.5, scripted: false },
    expect: { verify: 'pass' },
    variants: { 'with-skill': { skill: true } },
  });
  assert.deepEqual(parseToml(String.fromCharCode(0xfeff) + 'a = 1\r\nb = "x"\r\n'), { a: 1, b: 'x' });
});

test('anything outside that subset is an error with its line, not a guess', () => {
  for (const [text, message] of [
    ['a = 1\nb = nope', /line 2: unsupported value "nope"/],
    ['[[x]]', /arrays of tables/],
    ['a = 1\na = 2', /defined twice/],
    ['[t]\n[t]', /defined twice/],
    ['a = "x', /unterminated string/],
    ['a = """x"""', /multi-line/],
    ['a = 1 2', /unexpected text/],
    ['just words', /expected key = value/],
    ['a = [1 2]', /expected , or \]/],
    ['a = "\\q"', /unsupported escape/],
  ] as const) {
    assert.throws(() => parseToml(text), message, text);
  }
});
