import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapCodexEvent } from './codex.ts';
import { RUNNER_SPECS, antigravityLaunch } from '../registry.ts';

test('Codex maps assistant answers and turn failures', () => {
  const events = mapCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'pong' } });
  assert.deepEqual(events, [
    { kind: 'assistant_text', text: 'pong' },
    { kind: 'result', ok: true, text: 'pong', deniedTools: [] },
  ]);
  assert.deepEqual(mapCodexEvent({ type: 'turn.failed', error: { message: 'failed' } }), [
    { kind: 'error', message: 'failed' },
  ]);
  assert.deepEqual(mapCodexEvent({ type: 'turn.started' }), []);
});

test('Codex arguments pin access and pass response schemas and prompts separately', () => {
  const request = { cwd: '.', prompt: 'long prompt', timeoutMs: 1 };
  const read = RUNNER_SPECS.codex.buildArgs(request, 'response.json');
  assert.equal(read[read.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(read[read.indexOf('--output-schema') + 1], 'response.json');
  assert.deepEqual(read.slice(0, 2), ['-a', 'never']);
  assert.equal(read.at(-1), '-');
  assert.ok(!read.includes(request.prompt));
  const edit = RUNNER_SPECS.codex.buildArgs({ ...request, access: 'edit' });
  assert.equal(edit[edit.indexOf('--sandbox') + 1], 'workspace-write');
});

test('withproxy receives executable and prompt as separate arguments', () => {
  const prompt = 'Text with "$()" and spaces';
  const launch = antigravityLaunch('C:/Program Files/agy.exe', ['-p', prompt]);
  assert.ok(launch.args.includes('source ~/.bashrc >/dev/null && export MSYS2_ARG_CONV_EXCL="*" && withproxy "$@"'));
  assert.deepEqual(launch.args.slice(-3), ['C:/Program Files/agy.exe', '-p', prompt]);
});
