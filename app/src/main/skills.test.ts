import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createSkill, listSkills, saveAgent, warbandDir } from '../../../src/core/workspace.ts';
import { SkillService } from './skills.ts';

/* The "Скиллы" screen's service against temporary project folders. */

const roots: string[] = [];
const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'warband-app-skills-'));
  roots.push(root);
  return root;
};
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const roles = { implementer: { runner: 'claude' as const }, reviewer: { runner: 'claude' as const, model: 'opus' } };

test('the view has each skill with its body, size, file, version and the agents that use it', async () => {
  const root = await project();
  await createSkill(root, 'canon', 'How we write code');
  await saveAgent(root, { name: 'dev', description: '', skills: ['canon'], hooks: [], roles });
  const view = await new SkillService().view(root);
  const [canon] = view.skills;
  assert.equal(canon?.name, 'canon');
  assert.equal(canon?.description, 'How we write code');
  assert.equal(canon?.file, '.warband/skills/canon.md');
  assert.match(canon?.body ?? '', /^<!-- Write the rules/);
  assert.deepEqual(canon?.usedBy, ['dev']);
  const text = await readFile(join(warbandDir(root), 'skills', 'canon.md'), 'utf8');
  assert.equal(canon?.size, text.trim().length);
  assert.equal(canon?.version.length, 64);
});

test('a broken agent file leaves "used by" unknown but still lists the skills', async () => {
  const root = await project();
  await createSkill(root, 'canon', 'rules');
  await saveAgent(root, { name: 'dev', description: '', skills: [], hooks: [], roles });
  await writeFile(join(warbandDir(root), 'agents', 'dev.json'), '{ nope');
  const view = await new SkillService().view(root);
  assert.equal(view.skills[0]?.usedBy, undefined);
  assert.match(view.agentsError ?? '', /dev\.json/);
});

test('save, rename with confirmed agents and delete report problems, changes on disk and users', async () => {
  const root = await project();
  const svc = new SkillService();
  const bad = await svc.save(root, { name: 'my canon', description: '', body: '' }, undefined, '');
  assert.ok(!bad.ok && 'problems' in bad);
  assert.deepEqual(bad.problems.map((p) => p.code), ['name-invalid', 'description-empty']);

  const saved = await svc.save(root, { name: 'canon', description: 'rules', body: '# Rules\n' }, undefined, '');
  assert.ok(saved.ok);
  assert.deepEqual(await svc.save(root, { name: 'canon', description: 'rules 2', body: '' }, 'canon', 'stale'), { ok: false, changed: true });
  await saveAgent(root, { name: 'dev', description: '', skills: ['canon'], hooks: [], roles });

  const asked = await svc.save(root, { name: 'canon-2', description: 'rules', body: '# Rules\n' }, 'canon', saved.version);
  assert.ok(!asked.ok && 'problems' in asked);
  assert.deepEqual(asked.problems.map((p) => [p.code, p.agents]), [['rename-in-use', ['dev']]]);
  const renamed = await svc.save(root, { name: 'canon-2', description: 'rules', body: '# Rules\n' }, 'canon', saved.version, ['dev']);
  assert.ok(renamed.ok);
  assert.deepEqual((await svc.view(root)).skills.map((s) => [s.name, s.file, s.usedBy]), [['canon-2', '.warband/skills/canon-2.md', ['dev']]]);

  assert.deepEqual(await svc.remove(root, 'canon-2', renamed.version), { ok: false, usedBy: ['dev'] });
  await saveAgent(root, { name: 'dev', description: '', skills: [], hooks: [], roles });
  assert.deepEqual(await svc.remove(root, 'canon-2', 'stale'), { ok: false, changed: true });
  assert.deepEqual(await svc.remove(root, 'canon-2', renamed.version), { ok: true });
  assert.deepEqual(await listSkills(root), []);
});
