import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentDefinition } from '../core/agents.ts';
import type { Runner, RunnerId } from '../core/runner.ts';
import { DEFAULT_ROUTE } from '../core/stages.ts';
import { changedFiles, gitOk } from '../engine/git.ts';
import { eventLog } from '../engine/log.ts';
import { runTask } from '../engine/run.ts';
import type { EngineEvent, Role, RoleInfo, RunResult } from '../engine/run.ts';
import { parseEvents, runMetrics } from './metrics.ts';
import type { RunMetrics } from './metrics.ts';
import { autoGate, BenchRepo } from './repo.ts';
import { scriptedImplementer, scriptedPlanner } from './scripted.ts';
import { runKey } from './tasks.ts';
import type { BenchTask, Expectation, Variant } from './tasks.ts';

/*
 * Runs bench tasks with an agent, strictly one at a time (ADR-0004): every
 * run starts from a fresh copy of the task's setup/ in a temporary folder,
 * goes through every stage of the engine with the gates answered
 * automatically, and is judged by the task's verify.mjs and its events.
 */

export interface Skill {
  name: string;
  text: string;
}

export interface BenchOptions {
  tasks: readonly BenchTask[];
  /** The agent as defined in its project; its hooks are replaced by each task's checks. */
  agent: AgentDefinition;
  /** The agent's skills, read from its project. */
  skills: readonly Skill[];
  runners: Readonly<Record<RunnerId, Runner>>;
  repeat?: number;
  /** Where each run's events.jsonl is kept. Not kept when absent. */
  logDir?: string;
  /** Stand-ins for roles beyond the ones a task scripts itself (tests). */
  standIns?: (task: BenchTask, variant: Variant, attempt: number) => Partial<Record<Role, Runner>>;
  /** Every engine event, as it happens. */
  onEvent?: (key: string, attempt: number, event: EngineEvent) => void;
  /** One line when a run starts and when it ends. */
  onProgress?: (line: string) => void;
  now?: () => Date;
}

export interface RunRecord {
  key: string;
  task: string;
  variant?: string;
  attempt: number;
  /** verify.mjs exited 0. This alone is "passed". */
  verify: { ok: boolean; code: number | null; output: string };
  /** What task.toml expects (verify: the outcome it wants), compared with what happened. */
  expected: { verify: 'pass' | 'fail'; ok: boolean; misses: string[] };
  /** The run did not start or broke off (a missing CLI, an engine error). */
  error?: string;
  timedOut: boolean;
  metrics: RunMetrics;
  /** The run's events.jsonl, relative to the report. */
  events?: string;
}

export interface BenchReport {
  format: 1;
  agent: { name: string; roles: AgentDefinition['roles']; skills: string[] };
  /** Who played each role in the first run that recorded it: CLI, model, version. */
  roles: Partial<Record<Role, RoleInfo>>;
  started: string;
  finished: string;
  repeat: number;
  tasks: string[];
  runs: RunRecord[];
}

/** Model calls a set of runs may take: without reworks, and with every rework the route allows. */
export function estimateCalls(tasks: readonly BenchTask[], repeat = 1): { runs: number; min: number; max: number } {
  let runs = 0;
  let min = 0;
  let max = 0;
  for (const task of tasks) {
    const planner = task.scripted.planner ? 0 : 2;
    const implementer = task.scripted.implementer ? 0 : 1;
    const reviewer = 1;
    const reworks = task.maxReworks ?? DEFAULT_ROUTE.maxReworks;
    const n = task.variants.length * repeat;
    runs += n;
    min += n * (planner + implementer + reviewer);
    max += n * (planner + implementer + reviewer + reworks * (implementer + reviewer));
  }
  return { runs, min, max };
}

/** Where task.toml's expectation and the run differ, in words. */
export function unmet(expect: Expectation, m: RunMetrics, verifyOk: boolean, changed: readonly string[]): string[] {
  const misses: string[] = [];
  if ((expect.verify === 'pass') !== verifyOk) misses.push(`verify: expected ${expect.verify}, got ${verifyOk ? 'pass' : 'fail'}`);
  if (expect.status && m.status !== expect.status) misses.push(`status: expected ${expect.status}, got ${m.status}`);
  const review = m.reviews[0];
  if (expect.review && review?.verdict !== expect.review) misses.push(`review: expected ${expect.review}, got ${review?.verdict ?? 'no review'}`);
  if (expect.reviewFindingsMax !== undefined && review && review.findings > expect.reviewFindingsMax) {
    misses.push(`review findings: expected at most ${expect.reviewFindingsMax}, got ${review.findings}`);
  }
  if (expect.reworksMin !== undefined && m.reworks < expect.reworksMin) misses.push(`reworks: expected at least ${expect.reworksMin}, got ${m.reworks}`);
  for (const path of expect.flagged ?? []) {
    if (changed.includes(path) && !m.protectedPaths.includes(path)) misses.push(`${path} changed but protected_changes did not report it`);
  }
  return misses;
}

function runVerify(script: string, cwd: string, eventsFile: string | undefined): Promise<RunRecord['verify']> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env: { ...process.env, ...(eventsFile ? { WARBAND_BENCH_EVENTS: eventsFile } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('error', (err) => resolve({ ok: false, code: null, output: err.message }));
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = output.trim();
      resolve({ ok: code === 0, code, output: text.length > 4000 ? `${text.slice(0, 4000)}…` : text });
    });
  });
}

async function runOne(options: BenchOptions, task: BenchTask, variant: Variant, attempt: number): Promise<RunRecord> {
  const key = runKey(task, variant);
  const skills = [...options.skills];
  if (variant.skill && task.skill) {
    if (skills.some((s) => s.name === task.skill?.name)) throw new Error(`${key}: the agent already has a skill named ${task.skill.name}`);
    skills.push({ name: task.skill.name, text: await readFile(join(task.dir, task.skill.file), 'utf8') });
  }
  const repo = await BenchRepo.create({ setup: join(task.dir, 'setup'), skills, hooks: task.hooks, protectedPaths: task.protectedPaths });
  try {
    const agent: AgentDefinition = { ...options.agent, skills: skills.map((s) => s.name), hooks: task.hooks.map((h) => h.name) };
    const standIns: Partial<Record<Role, Runner>> = {
      ...(task.scripted.planner ? { planner: scriptedPlanner() } : {}),
      ...(task.scripted.implementer ? { implementer: scriptedImplementer(task.scripted.implementer.map((o) => join(task.dir, o))) } : {}),
      ...options.standIns?.(task, variant, attempt),
    };
    const log = eventLog(repo.root);
    const controller = new AbortController();
    const timeoutMs = task.timeoutSeconds * 1000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result: RunResult | undefined;
    let error: string | undefined;
    try {
      result = await runTask(
        {
          root: repo.root,
          runners: options.runners,
          gate: autoGate(repo),
          report: (event) => {
            log.write(event);
            options.onEvent?.(key, attempt, event);
          },
          route: { maxReworks: task.maxReworks ?? DEFAULT_ROUTE.maxReworks },
          timeouts: { agent: timeoutMs, hook: Math.min(timeoutMs, 5 * 60_000) },
          worktrees: repo.worktrees,
          signal: controller.signal,
          reslop: false,
          standIns,
          ...(options.now ? { now: options.now } : {}),
        },
        agent,
        task.prompt,
      );
    } catch (err) {
      error = (err as Error).message;
    } finally {
      clearTimeout(timer);
    }
    const eventsFile = log.path();
    const events = eventsFile ? parseEvents(await readFile(eventsFile, 'utf8')) : [];
    const metrics = runMetrics(events);
    const started = events.find((e) => e.type === 'run_started');

    // The result to judge: the commit when the run finished, the kept worktree when it stopped with changes.
    let dir = repo.root;
    if (result?.commit) await gitOk(repo.root, ['checkout', '--quiet', '--force', result.branch]);
    else if (result?.worktree) dir = result.worktree;
    const changed = started?.type === 'run_started' ? (await changedFiles(dir, started.base)).map((c) => c.path) : [];
    const verify = await runVerify(join(task.dir, 'verify.mjs'), dir, eventsFile);
    const misses = error ? [`the run did not complete: ${error}`] : unmet(variant.expect, metrics, verify.ok, changed);

    let kept: string | undefined;
    if (options.logDir && eventsFile) {
      await mkdir(options.logDir, { recursive: true });
      kept = `${key.replace(/:/g, '.')}-${attempt}.jsonl`;
      await copyFile(eventsFile, join(options.logDir, kept));
    }
    return {
      key,
      task: task.id,
      ...(variant.name ? { variant: variant.name } : {}),
      attempt,
      verify,
      expected: { verify: variant.expect.verify, ok: misses.length === 0, misses },
      ...(error ? { error } : {}),
      timedOut: controller.signal.aborted,
      metrics,
      ...(kept ? { events: kept } : {}),
    };
  } finally {
    await repo.dispose();
  }
}

export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const now = options.now ?? (() => new Date());
  const repeat = Math.max(1, options.repeat ?? 1);
  const started = now().toISOString();
  const runs: RunRecord[] = [];
  let roles: BenchReport['roles'] = {};
  for (const task of options.tasks) {
    for (const variant of task.variants) {
      for (let attempt = 1; attempt <= repeat; attempt++) {
        const key = runKey(task, variant);
        options.onProgress?.(`${key}${repeat > 1 ? ` #${attempt}` : ''}: running`);
        const record = await runOne(options, task, variant, attempt);
        runs.push(record);
        // The real CLIs, as the first run that used one for a role saw them.
        for (const [role, info] of Object.entries(record.metrics.roles) as [Role, RoleInfo][]) {
          if (!info.scripted && !roles[role]) roles = { ...roles, [role]: info };
        }
        const verdict = record.error ? `error: ${record.error}` : record.verify.ok ? 'verify passed' : 'verify failed';
        options.onProgress?.(`${key}${repeat > 1 ? ` #${attempt}` : ''}: ${verdict}${record.expected.ok ? '' : ` (unexpected: ${record.expected.misses.join('; ')})`}`);
      }
    }
  }
  return {
    format: 1,
    agent: { name: options.agent.name, roles: options.agent.roles, skills: options.skills.map((s) => s.name) },
    roles,
    started,
    finished: now().toISOString(),
    repeat,
    tasks: options.tasks.map((t) => t.id),
    runs,
  };
}
