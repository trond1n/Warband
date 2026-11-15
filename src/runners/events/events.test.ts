import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { toAgentEvents } from '../../core/events.ts';
import type { AgentEvent, RawMapper } from '../../core/events.ts';
import { parseLine } from '../../core/runner.ts';
import type { RunnerEvent } from '../../core/runner.ts';
import { mapAntigravityEvent } from './antigravity.ts';
import { mapClaudeEvent } from './claude.ts';

/*
 * Fixtures are real spike logs passed through scripts/spike/fixture.ts:
 * ids, paths and per-account data replaced, structure left as the CLI wrote it.
 */
const fixture = (name: string): RunnerEvent[] =>
  readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const event = parseLine(line);
      return event ? [event] : [];
    });

const map = (name: string, mapper: RawMapper, exitCode = 0): AgentEvent[] =>
  [...fixture(name), { type: 'done', exitCode, timedOut: false } as const].flatMap((event) =>
    toAgentEvents(event, mapper),
  );

test('claude: a plain answer becomes assistant text and a successful result', () => {
  assert.deepEqual(map('claude.pong', mapClaudeEvent), [
    { kind: 'assistant_text', text: 'pong' },
    { kind: 'result', ok: true, text: 'pong', deniedTools: [] },
  ]);
});

test('claude: a write denied headless shows the tool call and the denial in the result', () => {
  const events = map('claude.write', mapClaudeEvent);
  assert.deepEqual(events[0], {
    kind: 'tool_call',
    id: '<id-4>',
    name: 'Write',
    input: { file_path: '<workdir>\\warband-probe.txt', content: 'ok' },
  });
  assert.equal(events[1]?.kind, 'assistant_text');
  const result = events.at(-1);
  assert.equal(result?.kind, 'result');
  // The CLI counts the turn as a success even though the write was refused,
  // so the denial list is what tells the engine the task was not done.
  assert.equal(result?.kind === 'result' && result.ok, true);
  assert.deepEqual(result?.kind === 'result' && result.deniedTools, ['Write']);
  assert.equal(events.length, 3);
});

test('claude: reading a file needs no approval in read access', () => {
  const events = map('claude.read', mapClaudeEvent);
  assert.equal(events[0]?.kind === 'tool_call' && events[0].name, 'Read');
  assert.deepEqual(events.at(-1), { kind: 'result', ok: true, text: 'heron-4471', deniedTools: [] });
});

test('claude: edit access writes the file but still denies the shell', () => {
  const events = map('claude.edit', mapClaudeEvent);
  assert.deepEqual(
    events.filter((e) => e.kind === 'tool_call').map((e) => e.kind === 'tool_call' && e.name),
    ['Write', 'PowerShell'],
  );
  const result = events.at(-1);
  assert.deepEqual(result?.kind === 'result' && result.deniedTools, ['PowerShell']);
});

test('claude: with a JSON Schema the answer arrives as an object', () => {
  const result = map('claude.verdict', mapClaudeEvent).at(-1);
  assert.equal(result?.kind, 'result');
  assert.deepEqual(result?.kind === 'result' && result.structured, {
    verdict: 'approve',
    comments: ["Looks good to me. I didn't see any problems, so it's ready to merge."],
  });
});

test('claude: empty thinking blocks, system, user and rate-limit lines produce nothing', () => {
  const ignored = fixture('claude.write').filter(
    (event) => event.type === 'raw' && event.data['type'] !== 'assistant' && event.data['type'] !== 'result',
  );
  assert.ok(ignored.length > 0);
  for (const event of ignored) assert.deepEqual(toAgentEvents(event, mapClaudeEvent), [], JSON.stringify(event));
  assert.deepEqual(
    mapClaudeEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }),
    [],
  );
});

test('antigravity: a failed run becomes an error and a failed result', () => {
  assert.deepEqual(map('antigravity.pong', mapAntigravityEvent, 3), [
    {
      kind: 'error',
      message: 'failed to construct executor: plan model not specified; you must specify a valid model',
    },
    { kind: 'result', ok: false, text: '', deniedTools: [] },
    { kind: 'error', message: 'exited with code 3' },
  ]);
});

test('antigravity: unseen result statuses are not guessed at', () => {
  assert.deepEqual(mapAntigravityEvent({ event: 'result', result: { status: 'SOMETHING_NEW' } }), []);
  assert.deepEqual(mapAntigravityEvent({ type: 'result' }), []);
});

test('process outcomes map the same way for every CLI', () => {
  assert.deepEqual(toAgentEvents({ type: 'done', exitCode: 0, timedOut: false }, undefined), []);
  assert.deepEqual(toAgentEvents({ type: 'done', exitCode: null, timedOut: true }, undefined), [
    { kind: 'error', message: 'timed out' },
  ]);
  assert.deepEqual(toAgentEvents({ type: 'error', message: 'spawn ENOENT' }, undefined), [
    { kind: 'error', message: 'spawn ENOENT' },
  ]);
  assert.deepEqual(toAgentEvents({ type: 'raw', data: { type: 'result' } }, undefined), []);
  assert.deepEqual(toAgentEvents({ type: 'stderr', text: 'AGY_ERROR: {}' }, mapAntigravityEvent), []);
});
