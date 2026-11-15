import assert from 'node:assert/strict';
import { test } from 'node:test';

import { globToRegExp, matchGlob } from './glob.ts';

const yes = (pattern: string, ...paths: string[]): void => {
  for (const path of paths) assert.ok(globToRegExp(pattern).test(path), `${pattern} should match ${path}`);
};
const no = (pattern: string, ...paths: string[]): void => {
  for (const path of paths) assert.ok(!globToRegExp(pattern).test(path), `${pattern} should not match ${path}`);
};

test('globs: stars, double stars, alternatives and anchoring', () => {
  yes('package.json', 'package.json', 'apps/web/package.json');
  no('package.json', 'package.json.bak', 'apps/web/package.jsonx');
  yes('/package.json', 'package.json');
  no('/package.json', 'apps/web/package.json');
  yes('eslint.config.*', 'eslint.config.mjs', 'libs/ui/eslint.config.js');
  yes('.github/**', '.github/workflows/ci.yml', '.github/CODEOWNERS');
  no('.github/**', 'docs/.github/x');
  yes('**/*.{test,spec}.*', 'a.test.ts', 'src/lib/a.spec.tsx');
  no('**/*.{test,spec}.*', 'src/latest.ts', 'src/spec/readme.md');
  yes('**/__tests__/**', '__tests__/a.ts', 'src/__tests__/deep/b.ts');
  yes('tsconfig*.json', 'tsconfig.json', 'libs/a/tsconfig.spec.json');
  yes('.warband/', '.warband/hooks.json');
  yes('?.ts', 'a.ts');
  no('?.ts', 'ab.ts', 'a/bc.ts');
  no('/?.ts', 'a/b.ts');
  yes('a.b', 'a.b');
  no('a.b', 'axb', 'a+b');
});

test('the first matching pattern is reported, and Windows separators are accepted', () => {
  assert.equal(matchGlob('apps\\web\\package.json', ['*.md', 'package.json']), 'package.json');
  assert.equal(matchGlob('./README.md', ['*.md']), '*.md');
  assert.equal(matchGlob('src/a.ts', ['*.md']), undefined);
});
