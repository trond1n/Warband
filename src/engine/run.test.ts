import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { AgentDefinition } from '../core/agents.ts';
import type { AgentEvent } from '../core/events.ts';
import type { Hook } from '../core/hooks.ts';
import type { Runner, RunnerId, RunRequest } from '../core/runner.ts';
import { createSkill, saveHooks, skillHash, warbandDir } from '../core/workspace.ts';
import { git, gitOk } from './git.ts';
import { eventLog } from './log.ts';
import { isInside, worktreePath } from './places.ts';
import { runTask, structuredAnswer } from './run.ts';
import type { AcceptRequest, EngineEvent, GateDecision, HumanGate } from './run.ts';

/*
 * The engine against a real git repository and real hooks, with scripted
 * agents in place of model calls.
 */

const roots: string[] = [];
// Run worktrees go to a temporary folder, never to the real per-user one.
const worktreeHome = await mkdtemp(join(tmpdir(), 'warband-wt-'));
process.env['WARBAND_WORKTREES'] = worktreeHome;
roots.push(worktreeHome);
const worktreeOf = (root: string, runId: string): string => worktreePath(root, runId, worktreeHome);
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'warband-run-'));
  roots.push(root);
  await gitOk(root, ['init', '--quiet']);
  await gitOk(root, ['config', 'user.email', 'test@example.invalid']);
  await gitOk(root, ['config', 'user.name', 'Warband Test']);
  await writeFile(join(root, 'README.md'), '# demo\n');
  await gitOk(root, ['add', '-A']);
  await gitOk(root, ['commit', '--quiet', '-m', 'init']);
  return root;
}

type Stage = 'clarify' | 'plan' | 'implement' | 'review';

/** Which stage a request belongs to, from what the engine asks for. */
const stageOf = (req: RunRequest): Stage => {
  const props = (req.jsonSchema?.['properties'] ?? {}) as Record<string, unknown>;
  if ('status' in props) return 'clarify';
  if ('verdict' in props) return 'review';
  return req.access === 'edit' ? 'implement' : 'plan';
};

type Script = Partial<Record<Stage, (req: RunRequest, call: number) => AgentEvent[] | Promise<AgentEvent[]>>>;

const result = (text: string, structured?: unknown): AgentEvent => ({
  kind: 'result',
  ok: true,
  text,
  deniedTools: [],
  ...(structured === undefined ? {} : { structured }),
});

const DEFAULTS: Required<Script> = {
  clarify: () => [result('', { status: 'clear', questions: [] })],
  plan: () => [result('1. Create out.txt with the word fixed.')],
  implement: async (req) => {
    await writeFile(join(req.cwd, 'out.txt'), 'fixed\n');
    return [{ kind: 'tool_call', name: 'Write', input: {} }, result('Created out.txt.')];
  },
  review: () => [result('', { verdict: 'approve', findings: [] })],
};

function fakeRunners(script: Script, verified = true): { runners: Record<RunnerId, Runner>; calls: { stage: Stage; req: RunRequest }[] } {
  const calls: { stage: Stage; req: RunRequest }[] = [];
  const counts: Record<Stage, number> = { clarify: 0, plan: 0, implement: 0, review: 0 };
  const make = (id: RunnerId): Runner => ({
    id,
    displayName: `fake ${id}`,
    binary: id,
    capabilities: { transport: 'stream', structuredOutput: true, sandbox: 'agent', headlessApprovals: 'deny', verified },
    mapRaw: (data) => [data as unknown as AgentEvent],
    async detect() {
      return { found: true };
    },
    async *run(req) {
      const stage = stageOf(req);
      calls.push({ stage, req });
      const events = await (script[stage] ?? DEFAULTS[stage])(req, counts[stage]++);
      for (const event of events) yield { type: 'raw', data: event as unknown as Record<string, unknown> };
      yield { type: 'done', exitCode: 0, timedOut: false };
    },
  });
  return { runners: { claude: make('claude'), codex: make('codex'), antigravity: make('antigravity'), kimi: make('kimi') }, calls };
}

function scriptedGate(plan: GateDecision[], accept: GateDecision[], answers = ''): HumanGate & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    answerQuestions: async (questions) => {
      asked.push([...questions]);
      return answers;
    },
    reviewPlan: async () => plan.shift() ?? { outcome: 'ok' },
    acceptResult: async () => accept.shift() ?? { outcome: 'ok' },
  };
}

const agent: AgentDefinition = {
  name: 'test',
  description: 'Write the file the task asks for.',
  skills: ['canon'],
  hooks: ['content'],
  roles: { implementer: { runner: 'claude', model: 'sonnet' }, reviewer: { runner: 'claude', model: 'opus' } },
};

const node = (script: string): string => `"${process.execPath}" -e "${script}"`;
const contentHook: Hook = {
  name: 'content',
  description: '',
  run: node("process.exit(require('fs').readFileSync('out.txt','utf8').includes('fixed')?0:1)"),
  stage: 'checks',
};

async function setup(hooks: Hook[] = [contentHook]): Promise<string> {
  const root = await repo();
  await createSkill(root, 'canon', 'House rules');
  await saveHooks(root, hooks);
  return root;
}

const go = (root: string, runners: Record<RunnerId, Runner>, gate: HumanGate, events: EngineEvent[] = []) =>
  runTask({ root, runners, gate, report: (e) => events.push(e), timeouts: { hook: 30_000 } }, agent, 'Create out.txt saying fixed');

test('an explicit planner handles clarification and planning independently of the reviewer', async () => {
  const root = await repo();
  const { runners, calls } = fakeRunners({});
  const run = await runTask({ root, runners, gate: scriptedGate([], []), report: () => {} }, {
    ...agent,
    skills: [],
    hooks: [],
    roles: {
      planner: { runner: 'codex', model: 'planner-model' },
      reviewer: { runner: 'codex', model: 'reviewer-model' },
      implementer: { runner: 'antigravity', model: 'gemini-model' },
    },
  }, 'Create out.txt saying fixed');
  assert.equal(run.state.status, 'done');
  assert.deepEqual(calls.map(({ stage, req }) => [stage, req.model]), [
    ['clarify', 'planner-model'],
    ['plan', 'planner-model'],
    ['implement', 'gemini-model'],
    ['review', 'reviewer-model'],
  ]);
});

test('happy path: every stage runs once and the result is committed on its own branch', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({});
  const events: EngineEvent[] = [];
  const run = await go(root, runners, scriptedGate([], []), events);

  assert.equal(run.state.status, 'done');
  assert.deepEqual(calls.map((c) => c.stage), ['clarify', 'plan', 'implement', 'review']);
  assert.deepEqual(calls.map((c) => c.req.model), ['opus', 'opus', 'sonnet', 'opus'], 'planner uses the reviewer model');
  assert.deepEqual(calls.map((c) => c.req.access), ['read', 'read', 'edit', 'read']);
  assert.match(calls[2]?.req.prompt ?? '', /## Rules you must follow\n\n### canon/);
  assert.match(calls[3]?.req.prompt ?? '', /\+fixed/, 'the reviewer sees the diff');

  const files = await gitOk(root, ['show', '--name-only', '--format=%s', run.branch]);
  assert.deepEqual(files.filter(Boolean), ['test: Create out.txt saying fixed', 'out.txt']);
  assert.equal(existsSync(join(root, 'out.txt')), false, "the person's checkout is untouched");
  assert.equal(existsSync(worktreeOf(root, run.runId)), false, 'worktree removed after success');

  const status = await gitOk(root, ['status', '--porcelain']);
  assert.deepEqual(status.filter((l) => !l.includes('.warband/')), []);
  assert.ok(!status.some((l) => l.includes('runs')), 'the run log is excluded locally');
  assert.deepEqual(
    events.filter((e) => e.type === 'stage').map((e) => e.type === 'stage' && e.stage),
    ['clarify', 'plan', 'approve', 'implement', 'checks', 'review', 'accept', 'finish'],
  );
});

test('a stand-in plays its role instead of the CLI; run_started records who played each role', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({});
  const detected = { ...runners, claude: { ...runners.claude, detect: async () => ({ found: true, version: '2.1.325' }) } };
  const standIn = fakeRunners({}).runners.claude;
  const events: EngineEvent[] = [];
  const run = await runTask(
    { root, runners: detected, gate: scriptedGate([], []), report: (e) => events.push(e), timeouts: { hook: 30_000 }, standIns: { implementer: standIn } },
    agent,
    'Create out.txt saying fixed',
  );
  assert.equal(run.state.status, 'done');
  assert.deepEqual(calls.map((c) => c.stage), ['clarify', 'plan', 'review'], 'the implementer CLI was not called');
  const started = events.find((e) => e.type === 'run_started');
  assert.deepEqual(started?.type === 'run_started' && started.roles, {
    planner: { runner: 'claude', model: 'opus', version: '2.1.325' },
    implementer: { runner: 'claude', scripted: true },
    reviewer: { runner: 'claude', model: 'opus', version: '2.1.325' },
  });
  const agents = events.filter((e) => e.type === 'agent_started');
  assert.deepEqual(agents.map((e) => e.type === 'agent_started' && [e.role, e.scripted ?? false]), [
    ['planner', false],
    ['planner', false],
    ['implementer', true],
    ['reviewer', false],
  ]);
});

test('a failing check sends the work back with the check output in the next prompt', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({
    implement: async (req, call) => {
      await writeFile(join(req.cwd, 'out.txt'), call === 0 ? 'broken\n' : 'fixed\n');
      return [result('done')];
    },
  });
  const run = await go(root, runners, scriptedGate([], []));
  assert.equal(run.state.status, 'done');
  assert.equal(run.state.reworks, 1);
  const attempts = calls.filter((c) => c.stage === 'implement');
  assert.equal(attempts.length, 2);
  assert.match(
    attempts[1]?.req.prompt ?? '',
    /attempt 2[\s\S]*These checks failed: "content" \(exit 1\)\. Their output follows\.\n\n<<<UNTRUSTED kind="check-output" label="content, exit 1" id="[0-9a-f]{12}">>>/,
    'the check output is fenced as material',
  );
});

const finding = {
  severity: 'high',
  where: 'out.txt:1',
  problem: 'No trailing newline check.',
  expected: 'The file ends with a newline.',
  check: ['out.txt ends with a newline'],
};

test('reviewer findings become a reslop plan in .plan/, which goes back to the implementer and is not committed', async () => {
  const root = await setup();
  let planSeen = '';
  const { runners, calls } = fakeRunners({
    implement: async (req, call) => {
      await writeFile(join(req.cwd, 'out.txt'), 'fixed\n');
      if (call === 1) {
        // The implementer ticks the plan off, as reslop's agent instructions ask.
        const [name] = (await readdir(join(req.cwd, '.plan'))).sort();
        const file = join(req.cwd, '.plan', name ?? '');
        planSeen = await readFile(file, 'utf8');
        await writeFile(file, planSeen.replace('status: editing', 'status: done').replaceAll('[ ]', '[x]'));
      }
      return [result('done')];
    },
    review: (_req, call) => [
      result('', call === 0 ? { verdict: 'changes_requested', findings: [finding] } : { verdict: 'approve', findings: [] }),
    ],
  });
  const events: EngineEvent[] = [];
  const run = await go(root, runners, scriptedGate([], []), events);
  assert.equal(run.state.status, 'done');

  assert.match(
    planSeen,
    /^---\nstatus: editing\n---\n\n# Review of attempt 1\n\n## Improvements\n\n- \[ \] high: No trailing newline check\.\n  - where: `out\.txt:1`\n/,
  );
  assert.match(planSeen, /  - check:\n    - \[ \] out\.txt ends with a newline\n/);
  const second = calls.filter((c) => c.stage === 'implement')[1];
  assert.match(second?.req.prompt ?? '', /Work through the unchecked items in `\.plan\/\d{4}-\d{2}-\d{2}-01\.md`/);
  assert.match(second?.req.prompt ?? '', /- \[ \] high: No trailing newline check\./);

  const files = await gitOk(root, ['show', '--name-only', '--format=', run.branch]);
  assert.deepEqual(files.filter(Boolean), ['out.txt'], '.plan/ is not committed');
  const finished = events.find((e) => e.type === 'run_finished');
  assert.ok(finished?.type === 'run_finished' && finished.archive);
  const archived = await readdir(join(finished.archive, 'plan'));
  assert.equal(archived.length, 1, 'the plan is archived with the run');
  assert.ok(events.some((e) => e.type === 'plan_written' && e.source === 'reviewer' && e.findings === 1));
});

test('line comments at acceptance become a plan, together with plans the person left in .plan/', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({});
  const gate: HumanGate = {
    answerQuestions: async () => '',
    reviewPlan: async () => ({ outcome: 'ok' }),
    acceptResult: async (req) => {
      if (calls.filter((c) => c.stage === 'implement').length > 1) return { outcome: 'ok' };
      // As if written in reslop.
      await mkdir(join(req.worktree, '.plan'), { recursive: true });
      await writeFile(join(req.worktree, '.plan', '2000-01-01-01.md'), '---\nstatus: editing\n---\n\n# Mine\n\n- [ ] Rename the file\n');
      return { outcome: 'changes_requested', comment: 'Two things.', findings: [{ where: 'out.txt:1', problem: 'Say fixed!' }] };
    },
  };
  const run = await go(root, runners, gate);
  assert.equal(run.state.status, 'done');
  const second = calls.filter((c) => c.stage === 'implement')[1]?.req.prompt ?? '';
  assert.match(second, /`\.plan\/2000-01-01-01\.md`, `\.plan\/\d{4}-\d{2}-\d{2}-01\.md`/);
  assert.match(second, /# Changes asked for at acceptance\n\nTwo things\.\n\n## Improvements\n\n- \[ \] Say fixed!\n  - where: `out\.txt:1`/);
  assert.match(second, /- \[ \] Rename the file/);
});

test('the worktree is outside the project: the checkout is not one of its parents', async () => {
  const root = await setup();
  let cwd = '';
  const { runners } = fakeRunners({
    implement: async (req) => {
      cwd = req.cwd;
      await writeFile(join(req.cwd, 'out.txt'), 'fixed\n');
      return [result('done')];
    },
  });
  const events: EngineEvent[] = [];
  const run = await go(root, runners, scriptedGate([], []), events);
  assert.equal(run.state.status, 'done');
  assert.equal(cwd, worktreeOf(root, run.runId));
  assert.ok(!isInside(root, cwd), 'the agent works outside the project');
  assert.ok(!isInside(cwd, root));
  assert.ok(isInside(worktreeHome, cwd));
  const started = events.find((e) => e.type === 'run_started');
  assert.ok(started?.type === 'run_started' && started.worktree === cwd);
});

test('changes to protected files and deleted tests are found after implement and shown to the reviewer and at acceptance', async () => {
  const root = await setup();
  await writeFile(join(root, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  await writeFile(join(root, 'sum.test.js'), 'test\n');
  await gitOk(root, ['add', '-A']);
  await gitOk(root, ['commit', '--quiet', '-m', 'more']);
  let accepted: AcceptRequest | undefined;
  const { runners, calls } = fakeRunners({
    implement: async (req) => {
      await writeFile(join(req.cwd, 'out.txt'), 'fixed\n');
      await writeFile(join(req.cwd, 'package.json'), '{"scripts":{"test":"exit 0"}}\n');
      await rm(join(req.cwd, 'sum.test.js'));
      return [result('done')];
    },
  });
  const gate: HumanGate = {
    answerQuestions: async () => '',
    reviewPlan: async () => ({ outcome: 'ok' }),
    acceptResult: async (req) => {
      accepted = req;
      return { outcome: 'ok' };
    },
  };
  const events: EngineEvent[] = [];
  const run = await go(root, runners, gate, events);
  assert.equal(run.state.status, 'done', 'protected changes do not block the run');

  const found = events.filter((e) => e.type === 'protected_changes');
  assert.equal(found.length, 1);
  assert.deepEqual(
    found[0]?.type === 'protected_changes' && found[0].changes.map((c) => [c.path, c.reason]),
    [
      ['package.json', 'protected'],
      ['sum.test.js', 'test_deleted'],
    ],
  );
  const review = calls.find((c) => c.stage === 'review')?.req.prompt ?? '';
  assert.match(review, /## Changes to protected files[\s\S]*- package\.json: modified \(protected by "package\.json"\)\n- sum\.test\.js: test file deleted/);
  assert.deepEqual(accepted?.protectedChanges.map((c) => c.path), ['package.json', 'sum.test.js']);
});

test('without protected changes the reviewer prompt has no such section', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({});
  const events: EngineEvent[] = [];
  await go(root, runners, scriptedGate([], []), events);
  assert.ok(!(calls.find((c) => c.stage === 'review')?.req.prompt ?? '').includes('Changes to protected files'));
  const found = events.find((e) => e.type === 'protected_changes');
  assert.ok(found?.type === 'protected_changes' && found.changes.length === 0, 'the empty result is still logged');
});

test('a worktree folder inside the project is refused before anything starts', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({});
  await assert.rejects(
    runTask({ root, runners, gate: scriptedGate([], []), report: () => {}, worktrees: join(root, 'wt'), reslop: false }, agent, 'x'),
    /worktrees must be outside the project/,
  );
  assert.deepEqual(calls, []);
});

test('two runs started in the same second get their own branches', async () => {
  const root = await setup();
  const fixed = new Date(2026, 10, 15, 12, 0, 0);
  const once = async () => {
    const { runners } = fakeRunners({});
    return runTask({ root, runners, gate: scriptedGate([], []), report: () => {}, timeouts: { hook: 30_000 }, now: () => fixed, reslop: false }, agent, 'x');
  };
  const first = await once();
  const second = await once();
  assert.equal(first.branch, 'warband/test-20261115-120000');
  assert.equal(second.branch, 'warband/test-20261115-120000-2');
  assert.equal(second.state.status, 'done');
});

test('cancelling stops the run before the next stage', async () => {
  const root = await setup();
  const controller = new AbortController();
  const { runners, calls } = fakeRunners({
    plan: () => {
      controller.abort();
      return [result('1. Plan.')];
    },
  });
  const run = await runTask(
    { root, runners, gate: scriptedGate([], []), report: () => {}, timeouts: { hook: 30_000 }, signal: controller.signal, reslop: false },
    agent,
    'Create out.txt saying fixed',
  );
  assert.equal(run.state.status, 'halted');
  assert.equal(run.state.haltReason, 'cancelled');
  assert.deepEqual(calls.map((c) => c.stage), ['clarify', 'plan']);
});

test('a hook marked reduce runs through reslop when it is there, and warns when it is not', async () => {
  const root = await setup([{ ...contentHook, reduce: true }]);
  // A stand-in for `reslop t -- <command>`: prints a marker, then runs the command.
  const bin = join(root, 'fake-bin');
  await mkdir(bin);
  const shim = join(bin, 'shim.mjs');
  await writeFile(
    shim,
    "import { spawnSync } from 'node:child_process';\n" +
      "console.log('REDUCED ' + process.argv.slice(2, 4).join(' '));\n" +
      "const r = spawnSync(process.argv[4], process.argv.slice(5), { stdio: 'inherit' });\n" +
      'process.exit(r.status ?? 1);\n',
  );
  const isWin = process.platform === 'win32';
  const reslop = join(bin, isWin ? 'reslop.cmd' : 'reslop');
  await writeFile(
    reslop,
    isWin ? `@"${process.execPath}" "${shim}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${shim}" "$@"\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env['PATH'];
  process.env['PATH'] = `${bin}${isWin ? ';' : ':'}${oldPath ?? ''}`;
  try {
    const { runners } = fakeRunners({});
    const events: EngineEvent[] = [];
    const run = await runTask(
      { root, runners, gate: scriptedGate([], []), report: (e) => events.push(e), timeouts: { hook: 30_000 }, reslop },
      { ...agent },
      'x',
    );
    assert.equal(run.state.status, 'done');
    const hook = events.find((e) => e.type === 'hook');
    assert.ok(hook?.type === 'hook' && hook.result.reduced);
    assert.equal(hook.result.output[0], 'REDUCED t --');
  } finally {
    process.env['PATH'] = oldPath;
  }
  const { runners } = fakeRunners({});
  const events: EngineEvent[] = [];
  await runTask({ root, runners, gate: scriptedGate([], []), report: (e) => events.push(e), timeouts: { hook: 30_000 }, reslop: false }, agent, 'x');
  assert.ok(events.some((e) => e.type === 'warning' && /reslop is not installed/.test(e.message)));
});

test('questions from the planner go to the person, and the answers reach the plan', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({
    clarify: () => [result('', { status: 'questions', questions: ['Which directory?'] })],
  });
  const gate = scriptedGate([], [], 'The repository root.');
  await go(root, runners, gate);
  assert.deepEqual(gate.asked, [['Which directory?']]);
  assert.match(calls.find((c) => c.stage === 'plan')?.req.prompt ?? '', /1\. Which directory\?\n\nAnswers:\nThe repository root\./);
});

test('plan feedback re-plans; rejecting the result halts and keeps the work for inspection', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({});
  const run = await go(
    root,
    runners,
    scriptedGate([{ outcome: 'changes_requested', comment: 'Mention tests.' }], [{ outcome: 'rejected' }]),
  );
  assert.equal(run.state.status, 'halted');
  assert.match(run.state.haltReason ?? '', /rejected by human/);
  const plans = calls.filter((c) => c.stage === 'plan');
  assert.equal(plans.length, 2);
  assert.match(plans[1]?.req.prompt ?? '', /## What the person wants changed in it\n\nMention tests\./);
  assert.ok(run.worktree && existsSync(join(run.worktree, 'out.txt')), 'worktree kept with the change');
});

test('rejecting the plan halts and leaves no worktree or branch behind', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({});
  const run = await go(root, runners, scriptedGate([{ outcome: 'rejected' }], []));
  assert.equal(run.state.status, 'halted');
  assert.equal(calls.some((c) => c.stage === 'implement'), false);
  assert.equal(run.worktree, undefined);
  assert.notEqual((await git(root, ['rev-parse', '--verify', run.branch])).code, 0, 'branch deleted');
});

test('an agent that fails at planning halts the run', async () => {
  const root = await setup();
  const { runners } = fakeRunners({ plan: () => [{ kind: 'error', message: 'quota exceeded' }] });
  const run = await go(root, runners, scriptedGate([], []));
  assert.equal(run.state.status, 'halted');
  assert.equal(run.state.haltReason, 'plan failed');
});

test('an unverified adapter is not allowed to implement unless the person opts in', async () => {
  const root = await setup();
  const { runners, calls } = fakeRunners({}, false);
  await assert.rejects(go(root, runners, scriptedGate([], [])), /unverified adapter/);
  assert.equal(calls.length, 0, 'nothing ran');
  assert.equal(existsSync(join(worktreeHome, 'nothing-made-here')), false);
  assert.deepEqual((await gitOk(root, ['worktree', 'list'])).length, 1, 'no worktree was added');
});

test('setup hooks run once in the new worktree before any agent', async () => {
  const prepare: Hook = { name: 'prepare', description: '', run: node("require('fs').writeFileSync('ready.txt','')"), stage: 'setup' };
  const root = await setup([contentHook, prepare]);
  let sawReady = false;
  const { runners } = fakeRunners({
    clarify: async (req) => {
      sawReady = existsSync(join(req.cwd, 'ready.txt'));
      return [result('{"status":"clear","questions":[]}', { status: 'clear', questions: [] })];
    },
  });
  const events: EngineEvent[] = [];
  const withSetup = { ...agent, hooks: ['prepare', 'content'] };
  const run = await runTask({ root, runners, gate: scriptedGate([], []), report: (e) => events.push(e), timeouts: { hook: 30_000 } }, withSetup, 'Create out.txt saying fixed');

  assert.equal(run.state.status, 'done');
  assert.ok(sawReady, 'the planner sees what setup made');
  assert.deepEqual(events.filter((e) => e.type === 'hook_started').map((e) => e.type === 'hook_started' && e.name), ['prepare', 'content']);
});

test('a failing setup hook halts before any agent and leaves nothing behind', async () => {
  const broken: Hook = { name: 'broken', description: '', run: node('process.exit(3)'), stage: 'setup' };
  const root = await setup([contentHook, broken]);
  const { runners, calls } = fakeRunners({});
  const run = await runTask(
    { root, runners, gate: scriptedGate([], []), report: () => {}, timeouts: { hook: 30_000 } },
    { ...agent, hooks: ['broken', 'content'] },
    'Create out.txt saying fixed',
  );

  assert.equal(run.state.status, 'halted');
  assert.match(run.state.haltReason ?? '', /setup hook "broken" failed/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(worktreeOf(root, run.runId)), false);
  assert.deepEqual(await gitOk(root, ['branch', '--list', run.branch]), []);
});

test('a repository without commits is refused before any agent runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'warband-empty-'));
  roots.push(root);
  await gitOk(root, ['init', '--quiet']);
  const { runners } = fakeRunners({});
  await assert.rejects(go(root, runners, scriptedGate([], [])), /no commits yet/);
});

test('the event log records the run under its id', async () => {
  const root = await setup();
  const { runners } = fakeRunners({});
  const log = eventLog(root);
  await runTask({ root, runners, gate: scriptedGate([], []), report: log.write, timeouts: { hook: 30_000 } }, agent, 'Create out.txt saying fixed');
  const lines = (await readFile(log.path() ?? '', 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string });
  assert.equal(lines[0]?.type, 'run_started');
  assert.equal(lines.at(-1)?.type, 'run_finished');
});

test('run_started records the hash of each skill text the prompts were built from', async () => {
  const root = await setup();
  const skillPath = join(warbandDir(root), 'skills', 'canon.md');
  const used = await readFile(skillPath, 'utf8');
  const { runners, calls } = fakeRunners({
    implement: async (req) => {
      // The person edits the skill while the run is going; the run keeps the version it started with.
      await writeFile(skillPath, `${used}\nA rule added mid-run.\n`);
      await writeFile(join(req.cwd, 'out.txt'), 'fixed\n');
      return [result('done')];
    },
  });
  const log = eventLog(root);
  await runTask({ root, runners, gate: scriptedGate([], []), report: log.write, timeouts: { hook: 30_000 } }, agent, 'Create out.txt saying fixed');
  const started = (await readFile(log.path() ?? '', 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as EngineEvent)
    .find((e) => e.type === 'run_started');
  assert.ok(started?.type === 'run_started');
  assert.deepEqual(started.skills, [{ name: 'canon', sha256: skillHash(used) }]);
  // Every prompt, before and after the edit, has the text that was hashed.
  for (const call of calls) assert.ok(call.req.prompt.includes('House rules') && !call.req.prompt.includes('A rule added mid-run.'), call.stage);
});

test('structured answers fall back to JSON in the final text', () => {
  const base = { ok: true, deniedTools: [], errors: [] };
  assert.deepEqual(structuredAnswer({ ...base, text: '```json\n{"verdict":"approve"}\n```' }), { verdict: 'approve' });
  assert.equal(structuredAnswer({ ...base, text: 'not json' }), undefined);
});

test('a CLI that updated itself since its adapter was verified is reported once, and the run goes on', async () => {
  const root = await setup();
  const { runners } = fakeRunners({});
  for (const runner of Object.values(runners) as Runner[]) {
    Object.assign(runner, {
      capabilities: { ...runner.capabilities, verifiedOn: '2.1.325' },
      detect: async () => ({ found: true, version: '2.1.330 (Claude Code)' }),
    });
  }
  const events: EngineEvent[] = [];
  const run = await go(root, runners, scriptedGate([], []), events);
  assert.equal(run.state.status, 'done');
  const drift = events.filter((e) => e.type === 'warning' && /verified on 2\.1\.325/.test(e.message));
  assert.equal(drift.length, 1, 'planner, implementer and reviewer share one CLI: one warning');
  assert.match(drift[0]?.type === 'warning' ? drift[0].message : '', /is 2\.1\.330.*npm run spike -- claude/);
});
