import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { Runner, RunnerId } from '../../../src/core/runner.ts';
import { createSkill, saveHooks, warbandDir } from '../../../src/core/workspace.ts';
import { RUNNER_IDS, RUNNERS } from '../../../src/runners/registry.ts';
import { AgentService } from './agents.ts';

/* The "Агенты" screen's service against temporary project folders and scripted CLIs. */

const roots: string[] = [];
const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'warband-app-agents-'));
  roots.push(root);
  return root;
};
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Claude installed at the version its adapter was verified on, Codex at another one, the rest missing. */
function runners(): Record<RunnerId, Runner> {
  const versions: Partial<Record<RunnerId, string>> = { claude: RUNNERS.claude.capabilities.verifiedOn ?? '1.0.0', codex: '0.0.1' };
  return Object.fromEntries(
    RUNNER_IDS.map((id) => {
      const version = versions[id];
      return [id, { ...RUNNERS[id], detect: async () => (version ? { found: true, version } : { found: false }) }];
    }),
  ) as Record<RunnerId, Runner>;
}

const service = (): AgentService =>
  new AgentService({ providers: async () => ({ providers: { claude: { models: ['sonnet', 'opus'] } } }), runners });

const form = { name: 'dev', description: 'Writes code', skills: ['canon'], hooks: ['unit'], implementer: { runner: 'claude', model: 'sonnet' }, reviewer: { runner: 'claude', model: 'opus' } };

test('the view has the agents, what the form picks from, and each provider as the form marks it', async () => {
  const root = await project();
  await saveHooks(root, [{ name: 'unit', description: '', run: 'npm test', stage: 'checks' }]);
  await createSkill(root, 'canon', 'rules');
  const svc = service();
  const saved = await svc.save(root, form, undefined, '');
  assert.ok(saved.ok);
  const view = await svc.view(root);
  assert.deepEqual(view.agents.map((a) => [a.agent.name, a.file, a.version]), [['dev', '.warband/agents/dev.json', saved.version]]);
  const skillText = await readFile(join(warbandDir(root), 'skills', 'canon.md'), 'utf8');
  assert.deepEqual(view.skills, [{ name: 'canon', description: 'rules', size: skillText.trim().length }]);
  assert.deepEqual(view.hooks.map((h) => h.name), ['unit']);
  const byId = Object.fromEntries(view.providers.map((p) => [p.id, p]));
  assert.deepEqual(byId['claude']?.models, ['sonnet', 'opus']);
  assert.equal(byId['claude']?.drift.kind, 'same');
  assert.equal(byId['codex']?.found, true);
  assert.equal(byId['kimi']?.found, false);
  for (const p of view.providers) assert.match(p.unverifiedMessage, /has an unverified adapter, so Warband cannot tell/);
  if (RUNNERS.codex.capabilities.verified) assert.equal(byId['codex']?.drift.kind, 'differs');
});

test('save reports problems by field and changes on disk; delete removes the file', async () => {
  const root = await project();
  const svc = service();
  const bad = await svc.save(root, { ...form, skills: ['canon'] }, undefined, '');
  assert.ok(!bad.ok && 'problems' in bad);
  assert.deepEqual(bad.problems.map((p) => [p.field, p.code]), [
    ['skills', 'skill-unknown'],
    ['hooks', 'hook-unknown'],
  ]);
  const ok = await svc.save(root, { ...form, skills: [], hooks: [] }, undefined, '');
  assert.ok(ok.ok);
  assert.deepEqual(await svc.save(root, { ...form, skills: [], hooks: [], description: 'new' }, 'dev', 'stale'), { ok: false, changed: true });
  assert.deepEqual(await svc.remove(root, 'dev', 'stale'), { ok: false, changed: true });
  assert.deepEqual(await svc.remove(root, 'dev', ok.version), { ok: true });
  assert.deepEqual((await svc.view(root)).agents, []);
});
