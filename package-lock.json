import assert from 'node:assert/strict';
import { test } from 'node:test';

import { advance, initialState } from './stages.ts';
import type { Outcome, RunState } from './stages.ts';

const walk = (outcomes: Outcome[], start: RunState = initialState()): RunState =>
  outcomes.reduce((state, outcome) => advance(state, outcome), start);

test('happy path visits every stage and stops at both human gates', () => {
  let state = initialState();
  const seen: string[] = [state.stage];
  const waited: string[] = [];
  while (state.status !== 'done') {
    state = advance(state, 'ok');
    if (state.status === 'waiting_human') waited.push(state.stage);
    if (seen.at(-1) !== state.stage) seen.push(state.stage);
  }
  assert.deepEqual(seen, [
    'clarify',
    'plan',
    'approve',
    'implement',
    'checks',
    'review',
    'accept',
    'finish',
  ]);
  assert.deepEqual(waited, ['approve', 'accept']);
  assert.equal(state.reworks, 0);
});

test('red checks send the task back to implement', () => {
  const state = walk(['ok', 'ok', 'ok', 'ok', 'failed']);
  assert.equal(state.stage, 'implement');
  assert.equal(state.reworks, 1);
});

test('reviewer and human comments both send the task back to implement', () => {
  const afterReview = walk(['ok', 'ok', 'ok', 'ok', 'ok', 'changes_requested']);
  assert.equal(afterReview.stage, 'implement');

  const afterAccept = walk(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'changes_requested']);
  assert.equal(afterAccept.stage, 'implement');
  assert.equal(afterAccept.reworks, 1);
});

test('changes requested at plan approval go back to plan, not to implement', () => {
  const state = walk(['ok', 'ok', 'changes_requested']);
  assert.equal(state.stage, 'plan');
  assert.equal(state.reworks, 0);
});

test('the rework limit halts the run instead of looping forever', () => {
  let state = walk(['ok', 'ok', 'ok']);
  for (let i = 0; i < 3; i += 1) state = walk(['ok', 'failed'], state);
  assert.equal(state.reworks, 3);
  state = walk(['ok', 'failed'], state);
  assert.equal(state.status, 'halted');
  assert.match(state.haltReason ?? '', /rework limit/);
});

test('a human rejection halts the run', () => {
  assert.equal(walk(['ok', 'ok', 'rejected']).status, 'halted');
  assert.equal(walk(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'rejected']).status, 'halted');
});

test('an outcome that makes no sense at a stage is an error, not a silent skip', () => {
  assert.throws(() => advance(initialState(), 'changes_requested'), /not valid at stage "clarify"/);
  assert.throws(() => walk(['ok', 'ok', 'ok', 'rejected']), /not valid at stage "implement"/);
});

test('a finished or halted run cannot advance', () => {
  const done = walk(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(done.status, 'done');
  assert.throws(() => advance(done, 'ok'), /cannot advance/);
});
