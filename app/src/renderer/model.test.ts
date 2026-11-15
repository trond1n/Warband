import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TimedEvent } from '../shared/api.ts';
import { findingTarget, openGate, timeline } from './model.ts';

const at = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const ev = (s: number, e: Record<string, unknown>): TimedEvent => ({ ...e, time: at(s) }) as unknown as TimedEvent;

const run: TimedEvent[] = [
  ev(0, { type: 'run_started', runId: 'r', agent: 'a', task: 't', worktree: 'w', branch: 'b', base: 'x' }),
  ev(1, { type: 'hook_started', stage: 'setup', name: 'install', run: 'pnpm i' }),
  ev(5, { type: 'hook', stage: 'setup', result: { name: 'install', ok: true, exitCode: 0, timedOut: false, reduced: false, output: [] } }),
  ev(5, { type: 'stage', stage: 'clarify', reworks: 0 }),
  ev(9, { type: 'stage', stage: 'plan', reworks: 0 }),
  ev(20, { type: 'stage', stage: 'approve', reworks: 0 }),
  ev(20, { type: 'gate_open', stage: 'approve', plan: '1. Do it' }),
];

test('the open gate is the last one opened and not yet answered', () => {
  assert.deepEqual(openGate(run), { stage: 'approve', plan: '1. Do it' });
  assert.equal(openGate([...run, ev(30, { type: 'gate', stage: 'approve', outcome: 'ok' })]), undefined);
  const questions = [ev(0, { type: 'stage', stage: 'clarify', reworks: 0 }), ev(1, { type: 'gate_open', stage: 'clarify', questions: ['Q?'] })];
  assert.deepEqual(openGate(questions), { stage: 'clarify', questions: ['Q?'] });
  assert.equal(openGate([...questions, ev(2, { type: 'stage', stage: 'plan', reworks: 0 })]), undefined, 'answered questions move on to plan');
});

test('the timeline has setup, then a bar per stage; a live run runs to now, an ended one to its last event', () => {
  const now = Date.parse(at(60));
  const live = timeline(run, now);
  assert.deepEqual(
    live.map((s) => [s.stage, (s.end - s.start) / 1000, s.open]),
    [
      ['setup', 5, false],
      ['clarify', 4, false],
      ['plan', 11, false],
      ['approve', 40, true],
    ],
  );
  const ended = timeline(run, now, false);
  assert.deepEqual(ended.at(-1) && [(ended.at(-1)!.end - ended.at(-1)!.start) / 1000, ended.at(-1)!.open], [0, false]);
  assert.equal(live[0]?.detail[0], 'install: прошёл');
});

test('finding locations', () => {
  assert.deepEqual(findingTarget('`src/a.ts:12`'), { path: 'src/a.ts', line: 12 });
  assert.deepEqual(findingTarget('src/a.ts:12-20'), { path: 'src/a.ts', line: 12 });
  assert.deepEqual(findingTarget('src/a.ts#sum'), { path: 'src/a.ts' });
  assert.equal(findingTarget(undefined), undefined);
});
