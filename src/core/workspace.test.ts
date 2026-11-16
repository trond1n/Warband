import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { normalizeName, validateAgent } from './agents.ts';
import { validateHook } from './hooks.ts';
import type { AgentDefinition } from './agents.ts';
import {
  commitFiles,
  createSkill,
  deleteHook,
  HookInUseError,
  HookInvalidError,
  HooksChangedError,
  hookFromInput,
  hookUsers,
  listAgents,
  listSkills,
  loadAgent,
  loadHooks,
  parseFrontMatter,
  readHooks,
  saveAgent,
  saveHook,
  saveHooks,
  warbandDir,
} from './workspace.ts';
import type { HookInput, HooksSnapshot } from './workspace.ts';

const roots: string[] = [];
const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'warband-ws-'));
  roots.push(root);
  return root;
};
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const agent: AgentDefinition = {
  name: 'test',
  description: 'Write tests.',
  skills: ['dev-canon'],
  hooks: ['unit'],
  roles: { implementer: { runner: 'claude', model: 'sonnet' }, reviewer: { runner: 'claude', model: 'opus' } },
};

test('an empty project has no agents, skills or hooks', async () => {
  const root = await project();
  assert.deepEqual(await listAgents(root), []);
  assert.deepEqual(await listSkills(root), []);
  assert.deepEqual(await loadHooks(root), []);
  assert.equal(await loadAgent(root, 'test'), undefined);
});

test('agents, hooks and skills round-trip through .warband/', async () => {
  const root = await project();
  await saveAgent(root, agent);
  await saveHooks(root, [{ name: 'unit', description: '', run: 'npm test', stage: 'checks' }]);
  const skill = await createSkill(root, 'dev-canon', 'How we write code');

  assert.deepEqual(await loadAgent(root, '/Test'), agent);
  assert.deepEqual(await listAgents(root), [agent]);
  assert.deepEqual(await loadHooks(root), [{ name: 'unit', description: '', run: 'npm test', stage: 'checks' }]);
  assert.deepEqual(await listSkills(root), [{ name: 'dev-canon', description: 'How we write code', path: skill.path }]);
  assert.match(await readFile(skill.path, 'utf8'), /^---\nname: dev-canon\ndescription: How we write code\n---/);
  await assert.rejects(createSkill(root, 'dev-canon', 'again'), /EEXIST/);

  const known = { skills: await listSkills(root), hooks: await loadHooks(root) };
  assert.deepEqual(validateAgent(agent, known), []);
});

test('a hand-edited file with mistakes is reported with its path, not silently used', async () => {
  const root = await project();
  await mkdir(join(warbandDir(root), 'agents'), { recursive: true });
  await writeFile(join(warbandDir(root), 'agents', 'bad.json'), '{"name": "bad",');
  await assert.rejects(listAgents(root), /bad\.json is not valid JSON/);

  await writeFile(
    join(warbandDir(root), 'agents', 'bad.json'),
    JSON.stringify({ ...agent, name: 'bad', roles: { implementer: { runner: 'gpt' }, reviewer: { runner: 'claude' } } }),
  );
  await assert.rejects(listAgents(root), /roles\.implementer: runner must be one of/);

  await writeFile(join(warbandDir(root), 'hooks.json'), JSON.stringify({ hooks: [{ name: 'x', run: 'y', stage: 'never' }] }));
  await assert.rejects(loadHooks(root), /stage must be one of setup, checks, finish/);
});

test('agent validation names every missing part', () => {
  assert.equal(normalizeName(' /Test '), 'test');
  const problems = validateAgent(
    { ...agent, name: 'Bad Name', description: ' ', roles: { implementer: { runner: 'kimi' }, reviewer: { runner: 'kimi' } } },
    { skills: [], hooks: [] },
  );
  assert.equal(problems.length, 5);
  assert.match(problems.join('\n'), /unknown skill "dev-canon"/);
  assert.match(problems.join('\n'), /unknown hook "unit"/);
  assert.match(problems.join('\n'), /explicit model/);
});

test('front matter parsing tolerates CRLF and missing fields', () => {
  assert.deepEqual(parseFrontMatter('---\r\nname: a\r\ndescription: b c\r\n---\r\nbody'), { name: 'a', description: 'b c' });
  assert.deepEqual(parseFrontMatter('no front matter'), {});
});

/* Hooks edited one at a time, as the window does. */

const input = (fields: Partial<HookInput> = {}): HookInput => ({
  name: 'unit',
  description: '',
  run: 'npm test',
  stage: 'checks',
  env: [],
  reduce: false,
  ...fields,
});

test('a hook saved from a form is written exactly as the wizard writes it', async () => {
  const root = await project();
  const saved = await saveHook(root, input({ name: ' /Unit ', run: ' npm test ', reduce: true }), { expectedVersion: 'none' });
  // What `warband agent new` does for the same answers: saveHooks(root, [...loadHooks(root), newHook]).
  const wizardRoot = await project();
  await saveHooks(wizardRoot, [{ name: 'unit', description: '', run: 'npm test', stage: 'checks', reduce: true }]);
  assert.equal(
    await readFile(join(warbandDir(root), 'hooks.json'), 'utf8'),
    await readFile(join(warbandDir(wizardRoot), 'hooks.json'), 'utf8'),
  );
  assert.deepEqual(saved.hook, { name: 'unit', description: '', run: 'npm test', stage: 'checks', reduce: true });
  assert.notEqual(saved.version, 'none');
});

test('environment rows: blank ones are dropped, a repeated name is a problem, no rows means no env', () => {
  assert.deepEqual(hookFromInput(input({ env: [['', ''], [' NX_DAEMON ', 'false']] }), '/w').hook.env, { NX_DAEMON: 'false' });
  assert.ok(!('env' in hookFromInput(input({ env: [['', '  ']] }), '/w').hook));
  assert.deepEqual(
    hookFromInput(input({ env: [['A', '1'], ['A', '2'], ['A', '3'], ['1X', 'y']] }), '/w').problems.map((p) => [p.code, p.key]),
    [
      ['env-name-invalid', '1X'],
      ['env-name-duplicate', 'A'],
    ],
  );
  assert.deepEqual(hookFromInput(input({ env: [['', 'value']] }), '/w').problems.map((p) => p.code), ['env-name-invalid']);
});

test('a hook the policy denies, or with a bad name, is not saved; the problems name their fields', async () => {
  const root = await project();
  await assert.rejects(
    saveHook(root, input({ name: 'Bad Name', run: 'rm -rf build' })),
    (err: unknown) => {
      assert.ok(err instanceof HookInvalidError);
      assert.deepEqual(
        err.problems.map((p) => [p.field, p.code, p.rule]),
        [
          ['name', 'name-invalid', undefined],
          ['run', 'run-denied', 'shell.rm-recursive-force'],
        ],
      );
      return true;
    },
  );
  assert.deepEqual(await readHooks(root), { hooks: [], version: 'none' });
});

test('edit in place keeps the order; a taken name and a stale file are refused', async () => {
  const root = await project();
  let snap = await saveHook(root, input({ name: 'lint', run: 'npm run lint' }));
  snap = await saveHook(root, input({ name: 'unit' }), { expectedVersion: snap.version });
  snap = await saveHook(root, input({ name: 'lint', run: 'npm run lint -- --fix', stage: 'finish' }), { original: 'lint', expectedVersion: snap.version });
  assert.deepEqual(snap.hooks.map((h) => [h.name, h.run, h.stage]), [
    ['lint', 'npm run lint -- --fix', 'finish'],
    ['unit', 'npm test', 'checks'],
  ]);

  await assert.rejects(saveHook(root, input({ name: 'unit' }), { original: 'lint', expectedVersion: snap.version }), (err: unknown) => {
    assert.ok(err instanceof HookInvalidError);
    assert.equal(err.problems[0]?.code, 'name-taken');
    return true;
  });
  await assert.rejects(saveHook(root, input({ name: 'new' }), { expectedVersion: 'stale' }), HooksChangedError);
  await assert.rejects(saveHook(root, input({ name: 'gone' }), { original: 'gone', expectedVersion: snap.version }), HooksChangedError);

  // A rename of a hook no agent uses is fine.
  snap = await saveHook(root, input({ name: 'style', run: 'npm run lint' }), { original: 'lint', expectedVersion: snap.version });
  assert.deepEqual(snap.hooks.map((h) => h.name), ['style', 'unit']);
});

test('a hook that agents use is not deleted, nor renamed without confirming its agents; others are', async () => {
  const root = await project();
  let snap: HooksSnapshot = await saveHook(root, input({ name: 'unit' }));
  snap = await saveHook(root, input({ name: 'spare', run: 'echo hi' }), { expectedVersion: snap.version });
  await saveAgent(root, agent);
  await saveAgent(root, { ...agent, name: 'dev' });
  assert.deepEqual(await hookUsers(root, 'unit'), ['dev', 'test']);
  assert.deepEqual(await hookUsers(root, 'spare'), []);

  await assert.rejects(saveHook(root, input({ name: 'tests' }), { original: 'unit', expectedVersion: snap.version }), (err: unknown) => {
    assert.ok(err instanceof HookInvalidError);
    assert.deepEqual(err.problems.map((p) => [p.code, p.agents]), [['rename-in-use', ['dev', 'test']]]);
    return true;
  });
  await assert.rejects(deleteHook(root, 'unit', snap.version), (err: unknown) => {
    assert.ok(err instanceof HookInUseError);
    assert.deepEqual(err.agents, ['dev', 'test']);
    return true;
  });
  await assert.rejects(deleteHook(root, 'spare', 'stale'), HooksChangedError);
  snap = await deleteHook(root, 'spare', snap.version);
  assert.deepEqual(snap.hooks.map((h) => h.name), ['unit']);
  // A hook that is gone already is reported as a change on disk.
  await assert.rejects(deleteHook(root, 'spare', snap.version), HooksChangedError);
});

test('renaming a used hook updates every agent that lists it, in one change', async () => {
  const root = await project();
  let snap: HooksSnapshot = await saveHook(root, input({ name: 'unit' }));
  snap = await saveHook(root, input({ name: 'lint', run: 'npm run lint' }), { expectedVersion: snap.version });
  await saveAgent(root, { ...agent, hooks: ['lint', 'unit'] });
  await saveAgent(root, { ...agent, name: 'dev', hooks: ['unit'] });
  await saveAgent(root, { ...agent, name: 'docs', hooks: ['lint'] });
  // A key Warband does not know, kept by hand in an agent file, survives the rename.
  const testFile = join(warbandDir(root), 'agents', 'test.json');
  const withNote = JSON.parse(await readFile(testFile, 'utf8')) as Record<string, unknown>;
  await writeFile(testFile, `${JSON.stringify({ ...withNote, note: 'kept' }, null, 2)}\n`);
  const docsBefore = await readFile(join(warbandDir(root), 'agents', 'docs.json'), 'utf8');

  // The list confirmed in the window no longer matches: nothing is written, the problem has the agents of now.
  await assert.rejects(saveHook(root, input({ name: 'tests' }), { original: 'unit', expectedVersion: snap.version, renameAgents: ['test'] }), (err: unknown) => {
    assert.ok(err instanceof HookInvalidError);
    assert.deepEqual(err.problems.map((p) => [p.code, p.agents]), [['rename-in-use', ['dev', 'test']]]);
    return true;
  });
  assert.deepEqual((await listAgents(root)).map((a) => [a.name, a.hooks]), [
    ['dev', ['unit']],
    ['docs', ['lint']],
    ['test', ['lint', 'unit']],
  ]);

  snap = await saveHook(root, input({ name: 'tests' }), { original: 'unit', expectedVersion: snap.version, renameAgents: ['test', 'dev'] });
  assert.deepEqual(snap.hooks.map((h) => h.name), ['tests', 'lint']);
  assert.deepEqual((await listAgents(root)).map((a) => [a.name, a.hooks]), [
    ['dev', ['tests']],
    ['docs', ['lint']],
    ['test', ['lint', 'tests']],
  ]);
  assert.equal((JSON.parse(await readFile(testFile, 'utf8')) as Record<string, unknown>)['note'], 'kept');
  assert.equal(await readFile(join(warbandDir(root), 'agents', 'docs.json'), 'utf8'), docsBefore);
  // An agent made by the wizard and renamed here is byte for byte what the wizard writes for those hooks.
  const dev = await loadAgent(root, 'dev');
  assert.equal(await readFile(join(warbandDir(root), 'agents', 'dev.json'), 'utf8'), `${JSON.stringify(dev, null, 2)}\n`);
  assert.deepEqual(validateAgent(dev!, { skills: dev!.skills.map((name) => ({ name })), hooks: snap.hooks }), []);
});

test('commitFiles puts every file back when one of the writes fails', async () => {
  const root = await project();
  const a = join(root, 'a.txt');
  const gone = join(root, 'gone.txt');
  const blocked = join(root, 'blocked');
  await writeFile(a, 'old a');
  await writeFile(gone, 'old gone');
  await mkdir(blocked);
  await writeFile(join(blocked, 'inside.txt'), 'x');
  await assert.rejects(
    commitFiles([
      { path: a, text: 'new a' },
      { path: join(root, 'fresh.txt'), text: 'fresh' },
      { path: gone, text: null },
      // A folder where a file should go: this swap fails, after the others were made.
      { path: blocked, text: 'cannot' },
    ]),
  );
  assert.equal(await readFile(a, 'utf8'), 'old a');
  assert.equal(await readFile(gone, 'utf8'), 'old gone');
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(root)).sort(), ['a.txt', 'blocked', 'gone.txt']);

  await commitFiles([
    { path: a, text: 'new a' },
    { path: gone, text: null },
  ]);
  assert.deepEqual((await readdir(root)).sort(), ['a.txt', 'blocked']);
  assert.equal(await readFile(a, 'utf8'), 'new a');
});

test('reduce on a hook outside the checks stage is a problem at the reduce field, in the core and for the wizard', async () => {
  const root = await project();
  const { problems } = hookFromInput(input({ stage: 'finish', reduce: true }), root);
  assert.deepEqual(
    problems.map((p) => [p.field, p.code]),
    [['reduce', 'reduce-stage']],
  );
  assert.deepEqual(validateHook({ name: 'unit', description: '', run: 'npm test', stage: 'setup', reduce: true }, root), [
    'hook "unit": reduce works only for the checks stage; turn it off or move the hook to checks',
  ]);
  assert.deepEqual(hookFromInput(input({ stage: 'checks', reduce: true }), root).problems, []);
  // Not saved, and not dropped either: the person decides.
  await assert.rejects(saveHook(root, input({ stage: 'finish', reduce: true })), HookInvalidError);
  assert.deepEqual(await readHooks(root), { hooks: [], version: 'none' });
});

test('hooks.json that is not JSON is an error with its path', async () => {
  const root = await project();
  await mkdir(warbandDir(root), { recursive: true });
  await writeFile(join(warbandDir(root), 'hooks.json'), '{ nope');
  await assert.rejects(readHooks(root), /hooks\.json is not valid JSON/);
  await assert.rejects(saveHook(root, input()), /not valid JSON/);
});
