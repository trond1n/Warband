import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { normalizeName, validateAgent } from './agents.ts';
import type { AgentDefinition } from './agents.ts';
import {
  createSkill,
  listAgents,
  listSkills,
  loadAgent,
  loadHooks,
  parseFrontMatter,
  saveAgent,
  saveHooks,
  warbandDir,
} from './workspace.ts';

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
