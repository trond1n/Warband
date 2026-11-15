import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expandRun, runHook, validateHook } from './hooks.ts';
import type { Hook } from './hooks.ts';

const node = (script: string): string => `"${process.execPath}" -e "${script}"`;
const hook = (run: string, over: Partial<Hook> = {}): Hook => ({ name: 'h', description: '', run, stage: 'checks', ...over });

test('a hook passes on exit code 0', async () => {
  const result = await runHook(hook(node("console.log('fine')")), process.cwd());
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
});

test('a failing hook reports its exit code and output', async () => {
  const result = await runHook(hook(node("console.error('2 tests failed'); process.exit(3)")), process.cwd());
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.output, ['2 tests failed']);
});

test('a hook that hangs fails at the timeout', async () => {
  const result = await runHook(hook(node('setInterval(() => {}, 1000)')), process.cwd(), { timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('{warband} in a hook command becomes the .warband path, with forward slashes', async () => {
  assert.equal(expandRun('node "{warband}/hooks/a.mjs"', 'C:\\p\\.warband'), 'node "C:/p/.warband/hooks/a.mjs"');
  assert.equal(expandRun('echo {warband}', undefined), 'echo {warband}');
  const result = await runHook(hook(node("console.log('{warband}')")), process.cwd(), { warbandDir: '/x/.warband' });
  assert.deepEqual(result.output, ['/x/.warband']);
});

test('colour codes are taken out of hook output', async () => {
  const result = await runHook(hook(node("console.log(String.fromCharCode(27) + '[33mwarn' + String.fromCharCode(27) + '[39m done')")), process.cwd());
  assert.deepEqual(result.output, ['warn done']);
});

test('a hook gets its env on top of the inherited environment', async () => {
  const result = await runHook(hook(node("console.log(process.env.WB_A + ' ' + typeof process.env.PATH)"), { env: { WB_A: 'set' } }), process.cwd());
  assert.deepEqual(result.output, ['set string']);
});

test('hook validation: names, empty commands, stages and policy', () => {
  assert.deepEqual(validateHook(hook('npm test', { name: 'unit' }), '/work'), []);
  assert.match(validateHook(hook('npm test', { name: 'Unit Tests' }), '/work')[0] ?? '', /lowercase/);
  assert.match(validateHook(hook('  '), '/work')[0] ?? '', /no command/);
  assert.match(validateHook(hook('rm -rf /'), '/work')[0] ?? '', /denied by policy/);
  assert.match(validateHook(hook('x', { stage: 'review' as Hook['stage'] }), '/work')[0] ?? '', /unknown stage/);
});
