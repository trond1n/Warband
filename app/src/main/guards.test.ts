import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { openablePath, openableRoots, runId, senderAllowed, terminalCommand } from './guards.ts';

const temp = (t: { after: (fn: () => void) => void }): string => {
  // A space and shell characters in the folder itself, as in "Application Support" or a user name with a space.
  const dir = mkdtempSync(join(tmpdir(), 'warband guards $(x) & %USERNAME% '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A link to a folder: a junction on Windows, which needs no admin rights. */
const linkDir = (target: string, path: string): void => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

test('run ids are the ones the engine makes, nothing that walks a path', () => {
  assert.equal(runId('scribe-20261116-092554'), 'scribe-20261116-092554');
  assert.equal(runId('test-writer-20261115-162004-2'), 'test-writer-20261115-162004-2');
  for (const bad of ['', '..', '../dev-20261115-165759', 'dev-20261115-165759/../x', 'dev-20261115-165759\\..', 'C:\\x', '/etc', 'Dev-20261115-165759', 'dev', 'dev-2026-1', `${'a'.repeat(200)}-20261115-165759`, 42, null, undefined, ['dev-20261115-165759']]) {
    assert.throws(() => runId(bad), /run id expected/, String(bad));
  }
});

test('the window may open only run worktrees and run logs of known projects', async (t) => {
  const dir = temp(t);
  const wt = join(dir, 'wt');
  const project = join(dir, 'project');
  const other = join(dir, 'other');
  mkdirSync(join(wt, 'teamer-1234abcd', 'dev-20261115-165759'), { recursive: true });
  mkdirSync(join(project, '.warband', 'runs', 'dev-20261115-165759'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(dir, 'wt-evil'), { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'secret.txt'), 'x');
  const roots = openableRoots(wt, [project]);
  const real = (p: string): string => realpathSync(p);

  const worktree = join(wt, 'teamer-1234abcd', 'dev-20261115-165759');
  assert.equal(await openablePath(worktree, roots), real(worktree));
  const log = join(project, '.warband', 'runs', 'dev-20261115-165759');
  assert.equal(await openablePath(log, roots), real(log));

  // Outside, around, next to and above the roots.
  for (const path of [wt, join(worktree, '..', '..'), join(project, '.warband', 'runs'), other, join(other, 'secret.txt'), join(project, 'src'), project, join(project, '.warband'), dir, join(dir, 'wt-evil'), join(wt, '..', 'other'), join(log, '..', '..', '..', 'src')]) {
    assert.equal(await openablePath(path, roots), undefined, path);
  }
  // Missing paths, and a project that is not known.
  assert.equal(await openablePath(join(wt, 'gone'), roots), undefined);
  assert.equal(await openablePath(log, openableRoots(wt, [])), undefined);
  if (process.platform === 'win32') assert.equal(await openablePath(worktree.toUpperCase(), roots), real(worktree));
});

test('a link inside the allowed folders that leads out of them is refused; a linked root still works', async (t) => {
  const dir = temp(t);
  const wt = join(dir, 'wt');
  const outside = join(dir, 'outside');
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(outside, 'inner'), { recursive: true });
  linkDir(outside, join(wt, 'escape'));
  assert.equal(await openablePath(join(wt, 'escape'), [wt]), undefined);
  assert.equal(await openablePath(join(wt, 'escape', 'inner'), [wt]), undefined);

  // The worktrees home itself may be a link (WARBAND_WORKTREES on another drive, say).
  const real = join(dir, 'real-wt');
  mkdirSync(join(real, 'run'), { recursive: true });
  linkDir(real, join(dir, 'linked-wt'));
  assert.equal(await openablePath(join(dir, 'linked-wt', 'run'), [join(dir, 'linked-wt')]), realpathSync(join(real, 'run')));
  assert.equal(await openablePath(join(real, 'run'), [join(dir, 'linked-wt')]), realpathSync(join(real, 'run')));
});

test('the folder never becomes part of a terminal command line', () => {
  const cwd = '/Users/a b/Library/Application Support/Warband/wt/x-1/dev-20261115-165759 $(rm -rf ~) `id` "q" \'s\' & ; %PATH%';
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const command = terminalCommand(platform, cwd, 'reslop');
    const parsed = command.args.filter((a) => a !== cwd);
    assert.ok(parsed.every((a) => !a.includes('Application Support') && !a.includes('$(rm')), platform);
  }
  const win = terminalCommand('win32', 'C:\\Users\\Ivan Petrov\\AppData\\Local\\Warband\\wt', 'reslop');
  assert.deepEqual(win, { command: 'cmd.exe', args: ['/d', '/c', 'start "reslop" cmd /k reslop'], verbatim: true });

  const mac = terminalCommand('darwin', cwd, 'reslop');
  assert.equal(mac.args.at(-1), cwd);
  assert.ok(mac.args.some((a) => a.includes('quoted form of (item 1 of argv)')));

  const linux = terminalCommand('linux', cwd, 'reslop');
  assert.deepEqual(linux.args.slice(-4), ['-c', 'cd "$1" && reslop', 'sh', cwd]);

  for (const program of ['reslop; rm -rf ~', 'a b', '$(x)', '']) assert.throws(() => terminalCommand('linux', cwd, program), /program name expected/);
});

test('sh takes the folder as "$1": spaces and shell characters stay inert', (t) => {
  const sh = spawnSync('sh', ['-c', 'echo ok']);
  if (sh.status !== 0) return t.skip('no sh here');
  const dir = temp(t);
  const cwd = join(dir, 'Application Support $(touch pwned) `touch pwned2`; touch pwned3');
  mkdirSync(cwd);
  const { args } = terminalCommand('linux', cwd, 'pwd');
  const out = spawnSync('sh', args.slice(args.indexOf('-c')), { cwd: dir, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout.trim(), /Application Support \$\(touch pwned\)/);
  for (const f of ['pwned', 'pwned2', 'pwned3']) assert.equal(spawnSync('sh', ['-c', `test -e "${f}"`], { cwd: dir }).status, 1, f);
});

test('cmd.exe gets the folder as its working directory, spaces and % intact', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const dir = temp(t);
  const cwd = join(dir, 'Ivan Petrov & co %USERNAME%');
  mkdirSync(cwd);
  // The same spawn as openTerminal, minus `start`, which would open a window.
  const out = spawnSync('cmd.exe', ['/d', '/c', 'cd'], { cwd, encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(out.stdout.trim().toLowerCase(), realpathSync(cwd).toLowerCase());
});

test('calls come only from the main frame of our window showing our page', () => {
  const page = pathToFileURL(join(tmpdir(), 'Warband app', 'out', 'renderer', 'index.html')).href;
  const main = (url: string) => ({ ourWindow: true, frame: { url, isMain: true } });
  assert.equal(senderAllowed(main(page), page), true);
  assert.equal(senderAllowed(main(`${page}#run=dev-20261115-165759`), page), true);
  assert.equal(senderAllowed(main(page), `${page}#view=agents`), true);

  assert.equal(senderAllowed({ ourWindow: true, frame: null }, page), false);
  assert.equal(senderAllowed({ ourWindow: true, frame: { url: page, isMain: false } }, page), false);
  assert.equal(senderAllowed({ ourWindow: false, frame: { url: page, isMain: true } }, page), false);
  for (const url of ['', 'file:///', 'file:///C:/evil.html', `${page}.evil.html`, page.replace('index.html', 'other.html'), `${page}?x=1`, 'about:blank', 'http://localhost:5173/', 'not a url']) {
    assert.equal(senderAllowed(main(url), page), false, url);
  }

  const dev = 'http://localhost:5173';
  assert.equal(senderAllowed(main('http://localhost:5173/#view=hooks'), dev), true);
  assert.equal(senderAllowed(main('http://localhost:5174/'), dev), false);
  assert.equal(senderAllowed(main('http://localhost:5173/evil.html'), dev), false);
});
