import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { isInside, projectKey, worktreePath, worktreesHome } from './places.ts';

test('worktrees live in the per-user data folder of each OS, or where WARBAND_WORKTREES says', () => {
  assert.equal(worktreesHome({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'), join('C:\\Users\\a\\AppData\\Local', 'Warband', 'wt'));
  assert.equal(worktreesHome({}, 'darwin', '/Users/a'), join('/Users/a', 'Library', 'Application Support', 'Warband', 'wt'));
  assert.equal(worktreesHome({}, 'linux', '/home/a'), join('/home/a', '.local', 'state', 'warband', 'wt'));
  assert.equal(worktreesHome({ XDG_STATE_HOME: '/state' }, 'linux', '/home/a'), join('/state', 'warband', 'wt'));
  assert.equal(worktreesHome({ WARBAND_WORKTREES: '/fast/wt' }, 'linux', '/home/a'), resolve('/fast/wt'));
});

test('one short folder per project, stable for the same path', () => {
  const key = projectKey('/code/Teamer');
  assert.match(key, /^Teamer-[0-9a-f]{8}$/);
  assert.equal(projectKey('/code/Teamer'), key);
  assert.notEqual(projectKey('/other/Teamer'), key, 'two projects with one name do not share a folder');
  assert.ok(projectKey('/code/a very long project name indeed').length <= 21);
});

test('a worktree is never placed inside the project', () => {
  assert.ok(isInside('/p', '/p/a/b'));
  assert.ok(isInside('/p', '/p'));
  assert.ok(!isInside('/p', '/p2/a'));
  assert.ok(!isInside('/p/a', '/p'));
  assert.match(worktreePath('/p', 'run-1', '/data/wt'), /run-1$/);
  assert.throws(() => worktreePath('/p', 'run-1', '/p/.warband/worktrees'), /must be outside the project/);
});
