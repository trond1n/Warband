import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { keepLogsClean } from './reslop-logs.ts';

const roots: string[] = [];
const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'warband-logs-'));
  roots.push(root);
  return root;
};
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** What `reslop t` leaves behind for one run: a record, its report and raw output, and a rotated record. */
async function reslopLike(root: string): Promise<void> {
  const log = join(root, '.log');
  await mkdir(join(log, '.runs'), { recursive: true });
  for (const ext of ['json', 'log', 'raw']) await writeFile(join(log, `2026-11-16-node-01.${ext}`), ext);
  await writeFile(join(log, '.runs', 'run-1.json'), '{}');
}

test('a run in a checkout without .log leaves no .log behind', async () => {
  const root = await project();
  const hold = join(root, '.warband', '.trial-hold');
  const { result, cleanup } = await keepLogsClean(root, hold, async () => {
    await reslopLike(root);
    return 7;
  });
  assert.equal(result, 7);
  assert.deepEqual(cleanup.removed, [join('.runs', 'run-1.json'), '2026-11-16-node-01.json', '2026-11-16-node-01.log', '2026-11-16-node-01.raw']);
  assert.equal(existsSync(join(root, '.log')), false);
  // No hold folder was needed, so .warband was not made either.
  assert.equal(existsSync(join(root, '.warband')), false);
});

test('files that were in .log before stay, even ones the run rotated away', async () => {
  const root = await project();
  const log = join(root, '.log');
  await mkdir(log);
  await writeFile(join(log, 'mine.txt'), 'the person keeps this');
  await writeFile(join(log, '2026-11-01-npm-01.json'), 'an old record');
  await mkdir(join(root, '.warband'));
  const hold = join(root, '.warband', '.trial-hold');
  const { cleanup } = await keepLogsClean(root, hold, async () => {
    await reslopLike(root);
    // reslop drops its oldest record once it has more than it keeps.
    await rm(join(log, '2026-11-01-npm-01.json'));
  });
  assert.deepEqual((await readdir(log)).sort(), ['2026-11-01-npm-01.json', 'mine.txt']);
  assert.equal(await readFile(join(log, '2026-11-01-npm-01.json'), 'utf8'), 'an old record');
  assert.equal(await readFile(join(log, 'mine.txt'), 'utf8'), 'the person keeps this');
  assert.deepEqual(cleanup.restored, ['2026-11-01-npm-01.json']);
  assert.equal(cleanup.removed.length, 4);
  // The hold folder is gone; .warband, which was there, stays.
  assert.deepEqual(await readdir(join(root, '.warband')), []);
});

test('the run failing still cleans up and lets the error through', async () => {
  const root = await project();
  await mkdir(join(root, '.log'));
  await writeFile(join(root, '.log', 'mine.txt'), 'x');
  const hold = join(root, '.warband', '.trial-hold');
  await assert.rejects(
    keepLogsClean(root, hold, async () => {
      await reslopLike(root);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(await readdir(join(root, '.log')), ['mine.txt']);
  assert.equal(existsSync(hold), false);
});

test('a project without .warband gets none from the hold folder', async () => {
  const root = await project();
  await mkdir(join(root, '.log'));
  await writeFile(join(root, '.log', 'mine.txt'), 'x');
  await keepLogsClean(root, join(root, '.warband', '.trial-hold'), () => reslopLike(root));
  assert.equal(existsSync(join(root, '.warband')), false);
  assert.deepEqual(await readdir(join(root, '.log')), ['mine.txt']);
});
