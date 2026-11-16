import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseNameStatus } from '../engine/git.ts';
import { DEFAULT_PROTECTED, describeProtected, protectedChanges } from './protected.ts';
import { loadProtected } from './workspace.ts';

test('defaults flag configs, manifests, CI and Warband files; ordinary code is not flagged', () => {
  const found = protectedChanges([
    { status: 'M', path: 'apps/web/package.json' },
    { status: 'M', path: 'pnpm-lock.yaml' },
    { status: 'M', path: 'libs/ui/eslint.config.mjs' },
    { status: 'A', path: '.github/workflows/ci.yml' },
    { status: 'M', path: 'libs/timer-core/tsconfig.spec.json' },
    { status: 'M', path: 'libs/timer-core/vitest.config.mts' },
    { status: 'M', path: '.warband/hooks.json' },
    { status: 'M', path: 'libs/timer-core/src/lib/timer-core.ts' },
    { status: 'M', path: 'libs/timer-core/src/lib/timer-core.spec.ts' },
    { status: 'A', path: 'docs/notes.md' },
  ]);
  assert.deepEqual(
    found.map((f) => [f.path, f.reason]),
    [
      ['apps/web/package.json', 'protected'],
      ['pnpm-lock.yaml', 'protected'],
      ['libs/ui/eslint.config.mjs', 'protected'],
      ['.github/workflows/ci.yml', 'protected'],
      ['libs/timer-core/tsconfig.spec.json', 'protected'],
      ['libs/timer-core/vitest.config.mts', 'protected'],
      ['.warband/hooks.json', 'protected'],
    ],
  );
});

test('deleted and renamed tests are flagged; edited and added tests are not', () => {
  const found = protectedChanges([
    { status: 'D', path: 'src/sum.test.ts' },
    { status: 'R', path: 'src/sum.old.ts', from: 'src/sum.spec.ts' },
    { status: 'D', path: 'apps/web-e2e/src/brew.ts' },
    { status: 'M', path: 'src/sum.test.ts' },
    { status: 'A', path: 'src/new.test.ts' },
    { status: 'D', path: 'src/unused.ts' },
  ]);
  assert.deepEqual(
    found.map((f) => [f.path, f.reason]),
    [
      ['src/sum.test.ts', 'test_deleted'],
      ['src/sum.old.ts', 'test_renamed'],
      ['apps/web-e2e/src/brew.ts', 'test_deleted'],
    ],
  );
  assert.equal(describeProtected(found[1]!), 'src/sum.spec.ts -> src/sum.old.ts: test file renamed');
  const moved = protectedChanges([{ status: 'R', path: 'config/pkg.json', from: 'package.json' }]);
  assert.equal(moved[0]?.reason, 'protected', 'moving a protected file away is flagged by its old name');
});

test('git name-status lines with renames', () => {
  assert.deepEqual(parseNameStatus(['M\tpackage.json', 'D\ta.test.ts', 'R087\told.spec.ts\tnew.ts', 'A\tb.ts', '']), [
    { status: 'M', path: 'package.json' },
    { status: 'D', path: 'a.test.ts' },
    { status: 'R', path: 'new.ts', from: 'old.spec.ts' },
    { status: 'A', path: 'b.ts' },
  ]);
});

test('.warband/protected.json adds to the defaults, or replaces them with "defaults": false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'warband-protected-'));
  try {
    assert.deepEqual((await loadProtected(root)).paths, DEFAULT_PROTECTED, 'no file: defaults');
    await mkdir(join(root, '.warband'));
    await writeFile(join(root, '.warband', 'protected.json'), JSON.stringify({ paths: ['infra/**'], tests: ['checks/**'] }));
    const added = await loadProtected(root);
    assert.ok(added.paths.includes('package.json') && added.paths.includes('infra/**'));
    assert.ok(added.tests.includes('checks/**') && added.tests.includes('*.test.*'));
    await writeFile(join(root, '.warband', 'protected.json'), JSON.stringify({ defaults: false, paths: ['only/**'] }));
    assert.deepEqual(await loadProtected(root), { paths: ['only/**'], tests: [] });
    await writeFile(join(root, '.warband', 'protected.json'), JSON.stringify({ paths: [1] }));
    await assert.rejects(loadProtected(root), /"paths" must be a list of glob patterns/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
