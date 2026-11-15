import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cliRunner, parseLine } from './runner.ts';
import type { CliRunnerSpec, RunnerEvent } from './runner.ts';

/** A stand-in agent CLI: this Node binary running an inline script. */
const fakeCli = (script: string, binary: string = process.execPath): CliRunnerSpec => ({
  id: 'claude',
  displayName: 'Fake',
  binary,
  versionArgs: ['-e', 'console.log("fake 1.2.3")'],
  buildArgs: (request) => ['-e', script, request.prompt],
  capabilities: {
    transport: 'print',
    structuredOutput: true,
    sandbox: 'none',
    headlessApprovals: 'unknown',
    verified: false,
  },
});

const collect = async (spec: CliRunnerSpec, timeoutMs = 10_000): Promise<RunnerEvent[]> => {
  const events: RunnerEvent[] = [];
  for await (const event of cliRunner(spec).run({ prompt: 'hello', cwd: process.cwd(), timeoutMs })) {
    events.push(event);
  }
  return events;
};

test('parseLine separates JSON objects from plain text', () => {
  assert.deepEqual(parseLine('{"type":"result"}'), { type: 'raw', data: { type: 'result' } });
  assert.deepEqual(parseLine('plain words'), { type: 'text', text: 'plain words' });
  assert.deepEqual(parseLine('{not json'), { type: 'text', text: '{not json' });
  assert.deepEqual(parseLine('[1,2]'), { type: 'text', text: '[1,2]' });
  assert.equal(parseLine('   '), null);
});

test('run streams stdout, stderr and a final done event in order', async () => {
  const events = await collect(
    fakeCli(`
      console.log(JSON.stringify({ type: 'assistant', text: process.argv[1] }));
      console.error('working');
      console.log('pong');
      process.exitCode = 3;
    `),
  );
  assert.deepEqual(events.at(-1), { type: 'done', exitCode: 3, timedOut: false });
  assert.deepEqual(
    events.filter((event) => event.type === 'raw' || event.type === 'text'),
    [
      { type: 'raw', data: { type: 'assistant', text: 'hello' } },
      { type: 'text', text: 'pong' },
    ],
  );
  assert.ok(events.some((event) => event.type === 'stderr' && event.text === 'working'));
});

test('a CLI that hangs is killed at the timeout and reported as timed out', async () => {
  const events = await collect(fakeCli('setInterval(() => {}, 1000)'), 300);
  const last = events.at(-1);
  assert.equal(last?.type, 'done');
  assert.equal(last?.type === 'done' && last.timedOut, true);
});

test('a CLI that waits on stdin does not hang, because stdin is closed', async () => {
  const events = await collect(
    fakeCli(`
      process.stdin.resume();
      process.stdin.on('end', () => console.log('stdin closed'));
    `),
    5_000,
  );
  assert.deepEqual(events, [
    { type: 'text', text: 'stdin closed' },
    { type: 'done', exitCode: 0, timedOut: false },
  ]);
});

/*
 * On POSIX the orphan inherits the stdout pipe, so 'close' never comes and
 * the exit grace period is what ends the run. On Windows the pipe is not
 * held by the orphan and this passes without reaching that path; the
 * Windows hang (a shell's child surviving a kill) is covered in hooks.test.ts.
 */
test('a CLI that exits but leaves a process holding stdout does not hang the run', async () => {
  const started = Date.now();
  const events = await collect(
    fakeCli(`
      const { spawn } = require('node:child_process');
      const orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
      orphan.unref();
      console.log(String(orphan.pid));
    `),
    20_000,
  );
  const orphanPid = events.find((event) => event.type === 'raw' || event.type === 'text');
  try {
    assert.deepEqual(events.at(-1), { type: 'done', exitCode: 0, timedOut: false });
    assert.ok(Date.now() - started < 10_000, 'finished soon after the child exited');
  } finally {
    // The orphan outlives the run by design of this test; clean it up.
    const pid = orphanPid?.type === 'raw' ? NaN : Number(orphanPid?.text);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
  }
});

test('a missing binary becomes an error event and a failed detection', async () => {
  const spec = fakeCli('', 'warband-no-such-binary');
  const events = await collect(spec);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');

  const detection = await cliRunner(spec).detect();
  assert.equal(detection.found, false);
});

test('detect reports the version line', async () => {
  const detection = await cliRunner(fakeCli('')).detect();
  assert.deepEqual(detection, { found: true, version: 'fake 1.2.3' });
});
