import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

import { runHook } from './hooks.ts';
import type { Hook } from './hooks.ts';
import { fakeReslop, pathWith } from './testing/fake-reslop.ts';
import { saveAgent, saveHooks } from './workspace.ts';

/* reslop's .log/ in the person's checkout: taken back by `warband check` and the window alike, kept in a worktree. */

const roots: string[] = [];
const folder = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'warband-checkout-'));
  roots.push(root);
  return root;
};
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const reduced: Hook = { name: 'unit', description: '', run: 'node -e "process.exit(2)"', stage: 'checks', reduce: true };

async function withOld(root: string): Promise<void> {
  await mkdir(join(root, '.log'));
  await writeFile(join(root, '.log', 'mine.txt'), 'kept');
  await writeFile(join(root, '.log', '2026-01-01-old-01.json'), 'an old record');
}

test('in the checkout, runHook takes back what reslop left in .log/; in a worktree it does not', async () => {
  const bin = await fakeReslop();
  roots.push(bin);
  const path = process.env['PATH'];
  process.env['PATH'] = pathWith(bin);
  try {
    const checkout = await folder();
    await withOld(checkout);
    const here = await runHook(reduced, checkout, { reslop: join(bin, 'reslop'), warbandDir: join(checkout, '.warband'), inCheckout: true });
    assert.equal(here.exitCode, 2);
    assert.equal(here.reduced, true);
    assert.equal(here.logs?.removed.length, 4);
    assert.deepEqual(here.logs?.restored, ['2026-01-01-old-01.json']);
    assert.deepEqual((await readdir(join(checkout, '.log'))).sort(), ['2026-01-01-old-01.json', 'mine.txt']);
    assert.equal(existsSync(join(checkout, '.warband')), false);

    const worktree = await folder();
    const there = await runHook(reduced, worktree, { reslop: join(bin, 'reslop') });
    assert.equal(there.logs, undefined);
    assert.ok((await readdir(join(worktree, '.log'))).includes('2026-11-16-node-01.raw'), 'a worktree keeps .log/ for the run archive');
  } finally {
    process.env['PATH'] = path;
  }
});

test('`warband check` in the terminal leaves .log/ of the checkout as it was', async () => {
  const bin = await fakeReslop();
  roots.push(bin);
  const root = await folder();
  const run = promisify(execFile);
  await run('git', ['init', '--quiet'], { cwd: root });
  await saveHooks(root, [reduced]);
  await saveAgent(root, { name: 'dev', description: 'd', skills: [], hooks: ['unit'], roles: { implementer: { runner: 'claude' }, reviewer: { runner: 'claude', model: 'opus' } } });
  await withOld(root);
  const cli = join(import.meta.dirname, '..', 'cli.ts');
  const { stdout, stderr } = await run(process.execPath, [cli, 'check', 'dev'], { cwd: root, env: { ...process.env, INIT_CWD: root, PATH: pathWith(bin), WARBAND_CONFIG_DIR: root } }).catch((err: { stdout: string; stderr: string }) => err);
  assert.match(stdout, /through reslop/, stderr);
  assert.match(stdout, /through reslop/);
  assert.match(stdout, /reduced report/);
  assert.match(stdout, /removed: 4 files/);
  assert.deepEqual((await readdir(join(root, '.log'))).sort(), ['2026-01-01-old-01.json', 'mine.txt']);
});
