import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Hook } from '../core/hooks.ts';
import { agentWizard } from './agent-wizard.ts';
import type { Prompter, WizardEnv } from './agent-wizard.ts';

/** Replays answers in order and fails loudly if the wizard asks more than expected. */
const scripted = (answers: string[]): Prompter & { said: string[]; left: () => number } => {
  const queue = [...answers];
  const said: string[] = [];
  return {
    said,
    left: () => queue.length,
    async ask(question) {
      const next = queue.shift();
      if (next === undefined) throw new Error(`no scripted answer for: ${question}\n${said.slice(-5).join('\n')}`);
      return next;
    },
    say: (text) => said.push(text),
  };
};

const lint: Hook = { name: 'lint', description: '', run: 'npm run lint', stage: 'checks' };

const env = (over: Partial<WizardEnv> = {}): WizardEnv => ({
  root: '/work/project',
  runners: [
    { id: 'claude', displayName: 'Claude Code' },
    { id: 'antigravity', displayName: 'Antigravity' },
  ],
  models: async (runner) => (runner === 'claude' ? ['opus', 'sonnet', 'fable'] : ['gemini-4-argon-medium']),
  existingAgents: [],
  skills: [],
  hooks: [lint],
  ...over,
});

const NAME_AND_DESCRIPTION = ['/Test', 'Write e2e and unit tests for the given feature.', 'Cover edge cases.', ''];
const NO_SKILLS = [''];
const NO_HOOKS = [''];

test('a full run: new skill, existing and new hook, cheap writer and strong reviewer', async () => {
  const io = scripted([
    ...NAME_AND_DESCRIPTION,
    'n', 'dev-canon', 'How we write code', '', // skills: create one, then done
    '1', 'n', 'unit', 'npm test', '2', '', // hooks: pick lint, add unit (finish stage), done
    '1', '2', // implementer: Claude Code, sonnet
    '1', '1', // reviewer: Claude Code, opus
    '', // save: default yes
  ]);
  const result = await agentWizard(io, env());

  assert.deepEqual(result?.agent, {
    name: 'test',
    description: 'Write e2e and unit tests for the given feature.\nCover edge cases.',
    skills: ['dev-canon'],
    hooks: ['lint', 'unit'],
    roles: {
      implementer: { runner: 'claude', model: 'sonnet' },
      reviewer: { runner: 'claude', model: 'opus' },
    },
  });
  assert.deepEqual(result?.newSkills, [{ name: 'dev-canon', description: 'How we write code' }]);
  assert.deepEqual(result?.newHooks, [{ name: 'unit', description: '', run: 'npm test', stage: 'finish' }]);
  assert.equal(io.left(), 0);
});

test('the same CLI and model for both roles is refused and both roles are asked again', async () => {
  const io = scripted([
    ...NAME_AND_DESCRIPTION, ...NO_SKILLS, ...NO_HOOKS,
    '1', '2', // implementer: claude / sonnet
    '1', '2', // reviewer: claude / sonnet -> refused
    '1', '2', // implementer again: claude / sonnet
    '2', '1', // reviewer again: antigravity / gemini
    'y',
  ]);
  const result = await agentWizard(io, env());
  assert.deepEqual(result?.agent.roles.reviewer, { runner: 'antigravity', model: 'gemini-4-argon-medium' });
  assert.ok(io.said.some((line) => /must not be the same CLI and model/.test(line)));
});

test('the CLI default model on both sides of one CLI is refused, because the difference cannot be shown', async () => {
  const io = scripted([
    ...NAME_AND_DESCRIPTION, ...NO_SKILLS, ...NO_HOOKS,
    '1', '5', // implementer: claude / default (3 models, other, default)
    '1', '5', // reviewer: claude / default -> refused
    '1', '5', // implementer again: still the default
    '1', '4', 'claude-opus-5-5', // reviewer: typed id -> still refused, implementer has no model
    '1', '2', // implementer: claude / sonnet
    '1', '4', 'claude-opus-5-5', // reviewer: claude / typed id
    'y',
  ]);
  const result = await agentWizard(io, env());
  assert.deepEqual(result?.agent.roles, {
    implementer: { runner: 'claude', model: 'sonnet' },
    reviewer: { runner: 'claude', model: 'claude-opus-5-5' },
  });
});

test('bad answers are asked again instead of being accepted', async () => {
  const io = scripted([
    'Te st', '/test', // invalid name, then valid
    '', 'Write tests.', '', // empty description is not accepted
    '7', '', // no such skill number, then done
    'n', 'nuke', 'rm -rf /', '1', 'npm test', '1', '', // hook denied by policy, then a safe command
    'x', '1', '1', // not a number, then claude / opus
    '1', '2',
    'maybe', 'y',
  ]);
  const result = await agentWizard(io, env());
  assert.equal(result?.agent.name, 'test');
  assert.deepEqual(result?.newHooks.map((h) => h.run), ['npm test']);
  assert.ok(io.said.some((line) => /denied by policy/.test(line)));
  assert.equal(io.left(), 0);
});

test('an existing agent is replaced only after confirmation, and declining to save saves nothing', async () => {
  const io = scripted([
    'test', 'n', 'test2', // exists, do not replace, pick another name
    'Write tests.', '', ...NO_SKILLS, ...NO_HOOKS,
    '1', '1', '1', '2',
    'n', // do not save
  ]);
  assert.equal(await agentWizard(io, env({ existingAgents: ['test'] })), null);
  assert.equal(io.left(), 0);
});

test('without any installed CLI the wizard stops before asking anything', async () => {
  const io = scripted([]);
  assert.equal(await agentWizard(io, env({ runners: [] })), null);
});

test('the window and the wizard make the same agent file from the same answers', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveAgent, saveAgentInput, saveHooks, createSkill } = await import('../core/workspace.ts');
  const unit: Hook = { name: 'unit', description: '', run: 'npm test', stage: 'checks' };
  const io = scripted([
    '/Test', '  Write e2e and unit tests.   ', 'Cover edge cases.', '',
    '2', '1', '', // skills: canon, then style, in that order
    '2', '1', '', // hooks: unit, then lint
    '1', '2', // implementer: claude / sonnet
    '1', '4', 'claude-opus-5-5', // reviewer: claude / a typed id
    'y',
  ]);
  const skills = [
    { name: 'style', description: 'Style', path: 'style.md' },
    { name: 'canon', description: 'Canon', path: 'canon.md' },
  ];
  const result = await agentWizard(io, env({ skills, hooks: [lint, unit] }));
  assert.ok(result);
  const wizardRoot = await mkdtemp(join(tmpdir(), 'warband-wiz-'));
  const windowRoot = await mkdtemp(join(tmpdir(), 'warband-win-'));
  try {
    const wizardPath = await saveAgent(wizardRoot, result.agent);
    for (const root of [windowRoot]) {
      await saveHooks(root, [lint, unit]);
      await createSkill(root, 'style', 'Style');
      await createSkill(root, 'canon', 'Canon');
    }
    // The same answers as typed into the window's form, blank lines and spaces included.
    const saved = await saveAgentInput(windowRoot, {
      name: ' /Test ',
      description: '\n  Write e2e and unit tests.   \nCover edge cases.\n\n',
      skills: ['canon', 'style'],
      hooks: ['unit', 'lint'],
      implementer: { runner: 'claude', model: 'sonnet' },
      reviewer: { runner: 'claude', model: ' claude-opus-5-5 ' },
    });
    assert.equal(await readFile(saved.path, 'utf8'), await readFile(wizardPath, 'utf8'));
  } finally {
    await rm(wizardRoot, { recursive: true, force: true });
    await rm(windowRoot, { recursive: true, force: true });
  }
});
