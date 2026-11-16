import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentProblemCode } from '../../../src/core/agents.ts';
import { unverifiedImplementerMessage } from '../../../src/core/runner.ts';
import type { Hook, ProviderChoice } from '../shared/api.ts';
import { blankForm, formOf, hooksByStage, isDirty, problemText, providerMarks, roleProblems, skillsTotal, summary, toggle } from './agents-model.ts';

const provider = (over: Partial<ProviderChoice>): ProviderChoice => ({
  id: 'claude',
  name: 'Claude Code',
  found: true,
  version: '2.1.325',
  verified: true,
  unverifiedMessage: unverifiedImplementerMessage('Claude Code'),
  drift: { kind: 'same', verifiedOn: '2.1.325' },
  models: ['sonnet', 'opus'],
  ...over,
});
const claude = provider({});
const kimi = provider({ id: 'kimi', name: 'Kimi Code', found: false, verified: false, unverifiedMessage: unverifiedImplementerMessage('Kimi Code'), drift: { kind: 'none' } });
const codex = provider({ id: 'codex', name: 'Codex', drift: { kind: 'differs', verifiedOn: '0.200.0', installed: '0.300.0', newer: true } });

const hooks: Hook[] = [
  { name: 'format', description: '', run: 'prettier', stage: 'checks' },
  { name: 'install', description: '', run: 'pnpm i', stage: 'setup' },
  { name: 'check', description: '', run: 'pnpm check', stage: 'checks' },
  { name: 'commit-msg', description: '', run: 'x', stage: 'finish' },
];

test('a new agent starts on an installed, verified provider; picks keep their order', () => {
  assert.deepEqual(blankForm([kimi, claude]).implementer, { runner: 'claude', model: '' });
  assert.deepEqual(toggle(toggle(['canon'], 'tests', true), 'canon', false), ['tests']);
  assert.deepEqual(toggle(['a', 'b'], 'a', true), ['a', 'b']);
});

test('unsaved edits are judged on the agent the core would save', () => {
  const agent = { name: 'dev', description: 'Writes', skills: ['canon'], hooks: [], roles: { implementer: { runner: 'claude' as const, model: 'sonnet' }, reviewer: { runner: 'claude' as const, model: 'opus' } } };
  const blank = blankForm([claude]);
  assert.equal(isDirty({ ...formOf(agent), name: ' /Dev', description: 'Writes  \n' }, agent, blank), false);
  assert.equal(isDirty({ ...formOf(agent), skills: [] }, agent, blank), true);
  assert.equal(isDirty(blank, undefined, blank), false);
});

test('hooks group by stage in run order; skills add up', () => {
  assert.deepEqual(hooksByStage(hooks).map((g) => [g.stage, g.hooks.map((h) => h.name)]), [
    ['setup', ['install']],
    ['checks', ['format', 'check']],
    ['finish', ['commit-msg']],
  ]);
  assert.equal(skillsTotal(['a', 'b', 'gone'], [{ name: 'a', description: '', size: 100 }, { name: 'b', description: '', size: 23 }]), 123);
});

test('the summary is one sentence: who writes, who reviews, which checks', () => {
  const form = { ...blankForm([claude]), hooks: ['check', 'install', 'format'], implementer: { runner: 'claude', model: 'sonnet' }, reviewer: { runner: 'codex', model: '' } };
  assert.equal(
    summary(form, [claude, codex], hooks),
    'Пишет Claude Code (sonnet), проверяет Codex (модель по умолчанию); проверки: до работы агентов в worktree — install; после каждой реализации — check и format.',
  );
  assert.match(summary({ ...form, hooks: [] }, [claude, codex], hooks), /проверок кодом нет/);
});

test('providers are marked apart: not installed, unverified with the engine text, another version', () => {
  assert.deepEqual(providerMarks(claude, 'implementer'), []);
  const marks = providerMarks(kimi, 'implementer');
  assert.deepEqual(marks.map((m) => m.kind), ['missing', 'unverified']);
  assert.equal(marks[1]?.text, unverifiedImplementerMessage('Kimi Code'));
  assert.deepEqual(providerMarks(kimi, 'reviewer').map((m) => m.kind), ['missing', 'unverified']);
  assert.deepEqual(providerMarks(codex, 'reviewer').map((m) => m.kind), ['drift']);
});

test('the reviewer rule shows as soon as the roles are picked', () => {
  const same = { ...blankForm([claude]), implementer: { runner: 'claude', model: 'opus' }, reviewer: { runner: 'claude', model: ' opus ' } };
  assert.deepEqual(roleProblems(same).map((p) => [p.field, p.code]), [['reviewer', 'same-cli-and-model']]);
  assert.deepEqual(roleProblems({ ...same, implementer: { runner: 'claude', model: '' } }).map((p) => p.code), ['same-cli-no-model']);
  assert.deepEqual(roleProblems({ ...same, reviewer: { runner: 'codex', model: '' } }), []);
});

test('every problem code from the core has a message', () => {
  const codes: AgentProblemCode[] = ['name-invalid', 'name-taken', 'description-empty', 'skill-unknown', 'hook-unknown', 'runner-unknown', 'same-cli-no-model', 'same-cli-and-model'];
  for (const code of codes) assert.ok(problemText({ field: 'name', code, message: '', item: 'x' }).length > 0, code);
});
