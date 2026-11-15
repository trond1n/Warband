import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { AgentEvent } from '../../../src/core/events.ts';
import type { Runner, RunnerId, RunRequest } from '../../../src/core/runner.ts';
import { saveAgent, saveHooks } from '../../../src/core/workspace.ts';
import { gitOk } from '../../../src/engine/git.ts';
import type { TimedEvent } from '../shared/api.ts';
import { worktreePath } from '../../../src/engine/places.ts';
import { RunManager, summarize } from './runs.ts';

/* The window's run manager against a real repository, with scripted agents. */

const roots: string[] = [];
const worktreeHome = await mkdtemp(join(tmpdir(), 'warband-wt-'));
process.env['WARBAND_WORKTREES'] = worktreeHome;
roots.push(worktreeHome);
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'warband-app-'));
  roots.push(root);
  await gitOk(root, ['init', '--quiet']);
  await gitOk(root, ['config', 'user.email', 'test@example.invalid']);
  await gitOk(root, ['config', 'user.name', 'Warband Test']);
  await writeFile(join(root, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
  await gitOk(root, ['add', '-A']);
  await gitOk(root, ['commit', '--quiet', '-m', 'init']);
  await saveHooks(root, []);
  await saveAgent(root, {
    name: 'dev',
    description: 'Fix bugs.',
    skills: [],
    hooks: [],
    roles: { implementer: { runner: 'claude', model: 'sonnet' }, reviewer: { runner: 'claude', model: 'opus' } },
  });
  return root;
}

const result = (text: string, structured?: unknown): AgentEvent => ({ kind: 'result', ok: true, text, deniedTools: [], ...(structured === undefined ? {} : { structured }) });

function runners(onImplement?: (req: RunRequest) => Promise<void>): Record<RunnerId, Runner> {
  const make = (id: RunnerId): Runner => ({
    id,
    displayName: id,
    binary: id,
    capabilities: { transport: 'stream', structuredOutput: true, sandbox: 'agent', headlessApprovals: 'deny', verified: true },
    mapRaw: (data) => [data as unknown as AgentEvent],
    detect: async () => ({ found: true }),
    async *run(req) {
      const props = (req.jsonSchema?.['properties'] ?? {}) as Record<string, unknown>;
      let events: AgentEvent[];
      if ('status' in props) events = [result('', { status: 'questions', questions: ['Which file?'] })];
      else if ('verdict' in props) events = [result('', { verdict: 'approve', findings: [{ severity: 'low', where: 'sum.js:1', problem: 'Name a and b.', expected: '', check: [] }] })];
      else if (req.access === 'edit') {
        await writeFile(join(req.cwd, 'sum.js'), 'export const sum = (a, b) => a + b;\n');
        await onImplement?.(req);
        events = [result('Fixed the sign.')];
      } else events = [result('1. Change - to + in sum.js.')];
      for (const event of events) yield { type: 'raw', data: event as unknown as Record<string, unknown> };
      yield { type: 'done', exitCode: 0, timedOut: false };
    },
  });
  return { claude: make('claude'), codex: make('codex'), antigravity: make('antigravity'), kimi: make('kimi') };
}

/** Resolves when an event of the type arrives for the run. */
function waitFor(seen: { runId: string; event: TimedEvent }[], type: string, count = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = (): void => {
      if (seen.filter((s) => s.event.type === type).length >= count) resolve();
      else if (Date.now() - started > 20_000) reject(new Error(`no ${type} event`));
      else setTimeout(check, 20);
    };
    check();
  });
}

test('a run from the window: questions, plan and acceptance are answered through the manager, then it is in the history', async () => {
  const root = await project();
  const seen: { runId: string; event: TimedEvent }[] = [];
  const notes: string[] = [];
  const manager = new RunManager({ runners: runners(), emit: (runId, event) => seen.push({ runId, event }), notify: (title) => notes.push(title), reslop: false });

  const started = await manager.start(root, 'dev', 'Fix sum');
  assert.ok('runId' in started);
  const { runId } = started;

  await waitFor(seen, 'gate_open');
  assert.equal((await manager.runs(root))[0]?.status, 'waiting');
  manager.answer(runId, 'sum.js');

  await waitFor(seen, 'gate_open', 2);
  manager.decide(runId, { outcome: 'ok' });

  await waitFor(seen, 'gate_open', 3);
  const files = await manager.diff(root, runId);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.original.trim(), f.modified.trim()]),
    [['sum.js', 'M', 'export const sum = (a, b) => a - b;', 'export const sum = (a, b) => a + b;']],
  );
  const accept = seen.find((s) => s.event.type === 'gate_open' && s.event.stage === 'accept')?.event;
  assert.ok(accept?.type === 'gate_open' && accept.stage === 'accept' && accept.result.findings[0]?.where === 'sum.js:1');
  manager.decide(runId, { outcome: 'ok' });

  await waitFor(seen, 'run_finished');
  assert.deepEqual(notes, ['Вопросы планировщика: /dev', 'План готов: /dev', 'Результат готов: /dev']);
  assert.ok(seen.every((s) => s.runId === runId));
  assert.ok(seen[0]?.event.type === 'warning' || seen[0]?.event.type === 'run_started', 'events before the run id are delivered too');

  // From the log, as after a restart.
  const fresh = new RunManager({ runners: runners(), emit: () => {}, reslop: false });
  const [summary] = await fresh.runs(root);
  assert.equal(summary?.status, 'done');
  assert.equal(summary?.task, 'Fix sum');
  const after = await fresh.diff(root, runId);
  assert.equal(after[0]?.modified.trim(), 'export const sum = (a, b) => a + b;', 'the diff comes from the branch once the worktree is gone');
});

test('cancel at a gate rejects it, and a refused start reports the reason', async () => {
  const root = await project();
  const seen: { runId: string; event: TimedEvent }[] = [];
  const manager = new RunManager({ runners: runners(), emit: (runId, event) => seen.push({ runId, event }), reslop: false });
  const started = await manager.start(root, 'dev', 'Fix sum');
  assert.ok('runId' in started);
  await waitFor(seen, 'gate_open');
  manager.answer(started.runId, '');
  await waitFor(seen, 'gate_open', 2);
  manager.cancel(started.runId);
  await waitFor(seen, 'run_finished');
  const run = await manager.run(root, started.runId);
  assert.equal(run?.summary.status, 'halted');
  assert.equal(manager.isActive(started.runId), false);

  assert.deepEqual(await manager.start(root, 'nobody', 'x'), { error: `No agent "nobody" in ${root}` });
  const bare = await mkdtemp(join(tmpdir(), 'warband-app-'));
  roots.push(bare);
  await gitOk(bare, ['init', '--quiet']);
  await saveAgent(bare, { name: 'dev', description: 'x', skills: [], hooks: [], roles: { implementer: { runner: 'claude', model: 'sonnet' }, reviewer: { runner: 'claude', model: 'opus' } } });
  const refused = await manager.start(bare, 'dev', 'x');
  assert.ok('error' in refused && /no commits/.test(refused.error));
});

test('plans in the worktree are listed while it exists, then from the run archive', async () => {
  const root = await project();
  const seen: { runId: string; event: TimedEvent }[] = [];
  const manager = new RunManager({ runners: runners(), emit: (runId, event) => seen.push({ runId, event }), reslop: false });
  const started = await manager.start(root, 'dev', 'Fix sum');
  assert.ok('runId' in started);
  await waitFor(seen, 'gate_open');
  manager.answer(started.runId, '');
  await waitFor(seen, 'gate_open', 2);
  manager.decide(started.runId, { outcome: 'ok' });
  await waitFor(seen, 'gate_open', 3);
  // Return with a line comment: it becomes a plan in the worktree.
  manager.decide(started.runId, { outcome: 'changes_requested', findings: [{ where: 'sum.js:1', problem: 'Add a test' }] });
  await waitFor(seen, 'gate_open', 4);
  const live = await manager.plans(root, started.runId);
  assert.equal(live.length, 1);
  assert.match(live[0]?.text ?? '', /- \[ \] Add a test/);
  assert.ok(existsSync(worktreePath(root, started.runId, worktreeHome)), 'the worktree is outside the project while the run is open');
  manager.decide(started.runId, { outcome: 'ok' });
  await waitFor(seen, 'run_finished');
  const archived = await manager.plans(root, started.runId);
  assert.deepEqual(archived.map((p) => p.name), live.map((p) => p.name));
});

test('a run with no record of its end, and not active, is interrupted', () => {
  const events = [{ type: 'run_started', runId: 'r', agent: 'a', task: 't', worktree: 'w', branch: 'b', base: 'x', time: '2026-01-01T00:00:00Z' }] as TimedEvent[];
  assert.equal(summarize(events)?.status, 'interrupted');
  assert.equal(summarize(events, {})?.status, 'running');
  assert.equal(summarize(events, { gate: {} })?.status, 'waiting');
  assert.equal(summarize([]), undefined);
});
