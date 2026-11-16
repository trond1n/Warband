import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { saveAgent, saveHooks, warbandDir } from '../../../src/core/workspace.ts';
import type { HookInput } from '../../../src/core/workspace.ts';
import type { TrialResult } from '../shared/api.ts';
import { fakeReslop, pathWith } from '../../../src/core/testing/fake-reslop.ts';
import { HookService } from './hooks.ts';

/* The "Хуки" screen's service against temporary project folders. */

const roots: string[] = [];
const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'warband-app-hooks-'));
  roots.push(root);
  return root;
};
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const input = (fields: Partial<HookInput> = {}): HookInput => ({ name: 'unit', description: '', run: 'npm test', stage: 'checks', env: [], reduce: false, ...fields });

const service = (reslop?: string): HookService => new HookService({ reslop: () => reslop });

/** What the window does: ask for the exact command, show it, run with what was confirmed. */
async function confirmAndRun(svc: HookService, root: string, hook: HookInput): Promise<TrialResult> {
  const request = svc.request(root, hook);
  if ('problems' in request) return { status: 'invalid', problems: request.problems };
  return svc.trial(root, hook, request.command);
}

const node = (script: string): string => `node -e "${script}"`;

test('the view lists hooks with the agents that use them', async () => {
  const root = await project();
  await saveHooks(root, [
    { name: 'unit', description: 'tests', run: 'npm test', stage: 'checks' },
    { name: 'spare', description: '', run: 'echo hi', stage: 'finish' },
  ]);
  const roles = { implementer: { runner: 'claude' as const }, reviewer: { runner: 'claude' as const, model: 'opus' } };
  await saveAgent(root, { name: 'dev', description: '', skills: [], hooks: ['unit'], roles });
  const svc = service('C:/tools/reslop.exe');
  const view = await svc.view(root);
  assert.deepEqual(view.hooks.map((h) => [h.hook.name, h.usedBy]), [
    ['unit', ['dev']],
    ['spare', []],
  ]);
  assert.equal(view.reslop, 'C:/tools/reslop.exe');
  assert.equal(view.warbandDir, warbandDir(root));
  assert.notEqual(view.version, 'none');
});

test('a broken agent file leaves "used by" unknown but still lists the hooks', async () => {
  const root = await project();
  await saveHooks(root, [{ name: 'unit', description: '', run: 'npm test', stage: 'checks' }]);
  await saveAgent(root, { name: 'dev', description: '', skills: [], hooks: [], roles: { implementer: { runner: 'claude' }, reviewer: { runner: 'claude' } } });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(warbandDir(root), 'agents', 'dev.json'), '{ nope');
  const view = await service().view(root);
  assert.equal(view.hooks[0]?.usedBy, undefined);
  assert.match(view.agentsError ?? '', /dev\.json/);
});

test('save and delete report problems, changes on disk and agents that use the hook', async () => {
  const root = await project();
  const svc = service();
  const bad = await svc.save(root, input({ run: 'rm -rf .' }), undefined, 'none');
  assert.ok(!bad.ok && 'problems' in bad);
  assert.equal(bad.problems[0]?.code, 'run-denied');

  const saved = await svc.save(root, input(), undefined, 'none');
  assert.ok(saved.ok);
  assert.deepEqual(await svc.save(root, input({ name: 'other' }), undefined, 'none'), { ok: false, changed: true });

  await saveAgent(root, { name: 'dev', description: '', skills: [], hooks: ['unit'], roles: { implementer: { runner: 'claude' }, reviewer: { runner: 'claude', model: 'opus' } } });
  assert.deepEqual(await svc.remove(root, 'unit', saved.version), { ok: false, usedBy: ['dev'] });
  assert.match(await readFile(join(warbandDir(root), 'hooks.json'), 'utf8'), /"unit"/);
});

test('a trial run is offered with the exact command, folder and variables; a changed command does not run', async () => {
  const root = await project();
  const svc = service('C:/tools/reslop.exe');
  const write = node("require('fs').writeFileSync('ran.txt','x')");
  const hook = input({ run: `${write} {warband}`, env: [['NX_DAEMON', 'false']], reduce: true });
  assert.deepEqual(svc.request(root, hook), {
    command: `reslop t -- ${write} ${warbandDir(root).replaceAll('\\', '/')}`,
    cwd: root,
    env: { NX_DAEMON: 'false' },
    reduced: true,
  });
  // The person confirmed one command, the form now holds another.
  const confirmed = (svc.request(root, input({ run: 'echo safe' })) as { command: string }).command;
  assert.deepEqual(await svc.trial(root, hook, confirmed), { status: 'refused', error: 'Команда изменилась после подтверждения. Запустите ещё раз.' });
  assert.equal(existsSync(join(root, 'ran.txt')), false);
});

test('a hook with problems is not run and not even offered', async () => {
  const root = await project();
  const svc = service();
  assert.ok('problems' in svc.request(root, input({ run: 'git push --force' })));
  const result = await svc.trial(root, input({ run: 'git push --force' }), 'git push --force');
  assert.equal(result.status, 'invalid');
});

test('a trial run in the checkout reports exit code, time and the tail of the output', async () => {
  const root = await project();
  const svc = service();
  const ok = await confirmAndRun(svc, root, input({ run: node("console.log(process.cwd()); console.log(process.env.HOOK_MARK)"), env: [['HOOK_MARK', 'kestrel']] }));
  assert.equal(ok.status, 'finished');
  assert.ok(ok.status === 'finished');
  assert.equal(ok.ok, true);
  assert.equal(ok.exitCode, 0);
  assert.deepEqual(ok.output, [root, 'kestrel']);
  assert.ok(ok.seconds >= 0);

  const failed = await confirmAndRun(svc, root, input({ run: node("console.error('boom'); process.exit(3)") }));
  assert.ok(failed.status === 'finished');
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 3);
  assert.deepEqual(failed.output, ['boom']);
});

test('one trial at a time, and a running one can be stopped', async () => {
  const root = await project();
  const svc = service();
  const running = confirmAndRun(svc, root, input({ run: node('setTimeout(() => {}, 60000)') }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(svc.running, true);
  assert.deepEqual(await confirmAndRun(svc, root, input()), { status: 'refused', error: 'Уже идёт пробный запуск.' });
  svc.cancelTrial();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.ok(result.status === 'cancelled' && !result.ok);
  assert.equal(svc.running, false);
});

test('renaming a used hook goes through once the agents are confirmed', async () => {
  const root = await project();
  const svc = service();
  const saved = await svc.save(root, input(), undefined, 'none');
  assert.ok(saved.ok);
  await saveAgent(root, { name: 'dev', description: '', skills: [], hooks: ['unit'], roles: { implementer: { runner: 'claude' }, reviewer: { runner: 'claude', model: 'opus' } } });
  const asked = await svc.save(root, input({ name: 'tests' }), 'unit', saved.version);
  assert.ok(!asked.ok && 'problems' in asked);
  assert.deepEqual(asked.problems.map((p) => [p.code, p.agents]), [['rename-in-use', ['dev']]]);
  const renamed = await svc.save(root, input({ name: 'tests' }), 'unit', saved.version, ['dev']);
  assert.ok(renamed.ok);
  assert.deepEqual((await svc.view(root)).hooks.map((h) => [h.hook.name, h.usedBy]), [['tests', ['dev']]]);
});

test('a trial run with reduce leaves .log/ of the checkout as it was', async () => {
  const root = await project();
  const bin = await fakeReslop();
  roots.push(bin);
  const { mkdir, readdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(root, '.log'));
  await writeFile(join(root, '.log', 'mine.txt'), 'the person keeps this');
  await writeFile(join(root, '.log', '2026-01-01-old-01.json'), 'an old record');
  const path = process.env['PATH'];
  process.env['PATH'] = pathWith(bin);
  try {
    const result = await confirmAndRun(service(join(bin, 'reslop')), root, input({ run: node('process.exit(2)'), reduce: true }));
    assert.ok(result.status === 'finished');
    assert.equal(result.reduced, true);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.output, ['reduced report']);
    assert.equal(result.logs?.removed.length, 4);
    assert.deepEqual(result.logs?.restored, ['2026-01-01-old-01.json']);
  } finally {
    process.env['PATH'] = path;
  }
  assert.deepEqual((await readdir(join(root, '.log'))).sort(), ['2026-01-01-old-01.json', 'mine.txt']);
  assert.equal(existsSync(join(root, '.warband')), false);
});
