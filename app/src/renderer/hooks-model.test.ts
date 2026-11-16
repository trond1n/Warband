import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HOOK_STAGES } from '../../../src/core/hooks.ts';
import { hookFromInput } from '../../../src/core/workspace.ts';
import type { HookProblemCode } from '../../../src/core/hooks.ts';
import { DEFAULT_RULES } from '../../../src/core/policy.ts';
import { blankForm, copyName, formOf, inputOf, isDirty, problemText, RULE_LABEL, secondsText, STAGES, usedByText } from './hooks-model.ts';

test('every stage of the core is offered, in the wizard order', () => {
  assert.deepEqual(STAGES.map((s) => s.id), ['checks', 'finish', 'setup']);
  assert.deepEqual([...STAGES.map((s) => s.id)].sort(), [...HOOK_STAGES].sort());
});

test('a hook maps to the form and back; reduce is sent as it is, for the core to judge', () => {
  const hook = { name: 'check', description: 'all', run: 'pnpm check', stage: 'checks' as const, env: { NX_DAEMON: 'false' }, reduce: true };
  const form = formOf(hook);
  assert.deepEqual(form, { name: 'check', description: 'all', run: 'pnpm check', stage: 'checks', env: [['NX_DAEMON', 'false']], reduce: true });
  assert.deepEqual(inputOf(form), { name: 'check', description: 'all', run: 'pnpm check', stage: 'checks', env: [['NX_DAEMON', 'false']], reduce: true });
  assert.equal(inputOf({ ...form, stage: 'setup' }).reduce, true);
  // A reduce flag on a finish hook is an edit like any other, not something to drop quietly.
  const finish = { ...hook, stage: 'finish' as const };
  assert.equal(isDirty(formOf(finish), finish), false);
  assert.equal(isDirty({ ...formOf(finish), reduce: false }, finish), true);
});

test('the core and the window give the same rule for reduce outside checks, at the reduce field', () => {
  const [problem] = hookFromInput({ name: 'fmt', description: '', run: 'npm run fmt', stage: 'finish', env: [], reduce: true }, process.cwd()).problems;
  assert.equal(problem?.field, 'reduce');
  assert.match(problem?.message ?? '', /reduce works only for the checks stage/);
  assert.match(problemText(problem!), /только на стадии checks.*Снимите флажок или выберите стадию checks/);
});

test('unsaved edits: spaces, case and blank rows do not count', () => {
  const hook = { name: 'unit', description: '', run: 'npm test', stage: 'checks' as const };
  assert.equal(isDirty({ ...formOf(hook), name: ' Unit ', run: 'npm test  ', env: [['', '']] }, hook), false);
  assert.equal(isDirty({ ...formOf(hook), run: 'npm test -- --watch=false' }, hook), true);
  assert.equal(isDirty({ ...formOf(hook), env: [['CI', '1']] }, hook), true);
  assert.equal(isDirty(blankForm(), undefined), false);
  assert.equal(isDirty({ ...blankForm(), name: 'x' }, undefined), true);
});

test('a copy gets a free name', () => {
  assert.equal(copyName('unit', ['unit']), 'unit-copy');
  assert.equal(copyName('unit', ['unit', 'unit-copy', 'unit-copy-2']), 'unit-copy-3');
});

test('every problem code from the core has a message, and every deny rule a label', () => {
  const codes: HookProblemCode[] = ['name-invalid', 'name-taken', 'rename-in-use', 'run-empty', 'run-denied', 'stage-unknown', 'env-name-invalid', 'env-name-duplicate', 'reduce-stage'];
  for (const code of codes) assert.ok(problemText({ field: 'name', code, message: '' }).length > 0, code);
  for (const rule of DEFAULT_RULES.filter((r) => r.effect === 'deny')) assert.ok(RULE_LABEL[rule.id], rule.id);
  assert.match(problemText({ field: 'run', code: 'run-denied', rule: 'shell.rm-recursive-force', message: '' }), /rm -rf.*не сохраняется/);
  assert.match(problemText({ field: 'name', code: 'rename-in-use', agents: ['dev', 'test'], message: '' }, 'check'), /«check».*\/dev, \/test.*обновит ссылки/);
  assert.match(problemText({ field: 'env', code: 'env-name-duplicate', key: 'CI', message: '' }), /«CI» указана дважды/);
});

test('usage and time read naturally', () => {
  assert.equal(usedByText(['dev']), 'используют /dev');
  assert.equal(usedByText([]), 'не используется агентами');
  assert.match(usedByText(undefined), /не удалось/);
  assert.equal(secondsText(1.234), '1,2 с');
  assert.equal(secondsText(125), '2 мин 05 с');
});
