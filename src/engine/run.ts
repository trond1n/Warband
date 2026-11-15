import { existsSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { validateAgent } from '../core/agents.ts';
import type { AgentDefinition } from '../core/agents.ts';
import { toAgentEvents } from '../core/events.ts';
import type { AgentEvent } from '../core/events.ts';
import { runHook } from '../core/hooks.ts';
import type { Hook, HookResult, HookStage } from '../core/hooks.ts';
import type { RoleAssignment } from '../core/roles.ts';
import type { Access, Runner, RunnerId } from '../core/runner.ts';
import { advance, DEFAULT_ROUTE, initialState } from '../core/stages.ts';
import type { Outcome, RouteOptions, RunState, Stage } from '../core/stages.ts';
import { which } from '../core/which.ts';
import { listSkills, loadHooks, warbandDir } from '../core/workspace.ts';
import {
  addWorktree,
  branchExists,
  commitAll,
  excludeLocally,
  headCommit,
  removeWorktree,
  repoRoot,
  stagedDiff,
  uncommitted,
  UNSTAGED_DIRS,
} from './git.ts';
import { worktreePath, worktreesHome } from './places.ts';
import { findingLine, pendingPlans, planFeedback as plansFeedback, readPlans, renderPlan, writePlan } from './plan-file.ts';
import type { Finding } from './plan-file.ts';
import {
  CLARIFY_SCHEMA,
  REVIEW_SCHEMA,
  clarifyPrompt,
  implementPrompt,
  planPrompt,
  reviewPrompt,
} from './prompts.ts';
import type { PromptContext } from './prompts.ts';

export type Role = 'planner' | 'implementer' | 'reviewer';

/** Everything the engine reports. A UI only needs to render this stream. */
export type EngineEvent =
  | { type: 'run_started'; runId: string; agent: string; task: string; worktree: string; branch: string; base: string }
  | { type: 'warning'; message: string }
  | { type: 'stage'; stage: Stage; reworks: number }
  | { type: 'agent_started'; stage: Stage; role: Role; runner: RunnerId; model?: string; access: Access }
  | { type: 'agent'; stage: Stage; role: Role; event: AgentEvent }
  | { type: 'agent_finished'; stage: Stage; role: Role; ok: boolean; seconds: number }
  | { type: 'hook_started'; stage: HookStage; name: string; run: string }
  | { type: 'hook'; stage: HookStage; result: HookResult }
  | { type: 'gate_open'; stage: 'clarify'; questions: string[] }
  | { type: 'gate_open'; stage: 'approve'; plan: string }
  | { type: 'gate_open'; stage: 'accept'; result: AcceptRequest }
  | { type: 'gate'; stage: Stage; outcome: Outcome; comment?: string }
  | { type: 'review'; verdict: 'approve' | 'changes_requested'; findings: Finding[] }
  /** A review plan in .plan/ of the worktree (reslop format), from the reviewer or the person. */
  | { type: 'plan_written'; stage: Stage; name: string; source: 'reviewer' | 'person'; findings: number }
  | { type: 'run_finished'; state: RunState; branch?: string; commit?: string; worktree?: string; archive?: string };

export interface GateDecision {
  outcome: 'ok' | 'changes_requested' | 'rejected';
  comment?: string;
  /** Line comments from a diff view; they become a review plan. */
  findings?: Finding[];
}

export interface AcceptRequest {
  summary: string;
  diffStat: readonly string[];
  reviewComments: readonly string[];
  findings: readonly Finding[];
  worktree: string;
  base: string;
  branch: string;
}

/** The person at the two gates, plus answers to the planner's questions. */
export interface HumanGate {
  answerQuestions(questions: readonly string[]): Promise<string>;
  reviewPlan(plan: string): Promise<GateDecision>;
  acceptResult(result: AcceptRequest): Promise<GateDecision>;
}

export interface EngineOptions {
  /** Project directory: a git repository with at least one commit. */
  root: string;
  runners: Readonly<Record<RunnerId, Runner>>;
  gate: HumanGate;
  report(event: EngineEvent): void;
  route?: RouteOptions;
  timeouts?: Partial<Record<'agent' | 'hook', number>>;
  /** Lets a runner whose adapter is unverified edit files. Off by default. */
  allowUnverified?: boolean;
  /** The folder for run worktrees. Defaults to worktreesHome(); never inside the project. */
  worktrees?: string;
  now?: () => Date;
  /** Stops the run: running agents and hooks are killed, and the run halts as cancelled. */
  signal?: AbortSignal;
  /** Path of reslop, false to never use it. Looked up on PATH when not given. */
  reslop?: string | false;
}

export interface RunResult {
  runId: string;
  state: RunState;
  branch: string;
  commit?: string;
  /** Kept when the run stopped with changes, so the person can look at them. */
  worktree?: string;
}

const DEFAULT_TIMEOUTS = { agent: 30 * 60_000, hook: 10 * 60_000 };

interface StepResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  deniedTools: string[];
  errors: string[];
}

function stamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Structured answer from the CLI, or the final text parsed as JSON. */
export function structuredAnswer(step: StepResult): unknown {
  if (step.structured !== undefined) return step.structured;
  const text = step.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const SEVERITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);
const findings = (value: unknown): Finding[] =>
  (Array.isArray(value) ? value : []).flatMap((item): Finding[] => {
    const f = record(item);
    const problem = f?.['problem'];
    if (typeof problem !== 'string' || problem.trim() === '') return [];
    const severity = f?.['severity'];
    const where = f?.['where'];
    const expected = f?.['expected'];
    return [
      {
        problem,
        ...(typeof severity === 'string' && SEVERITIES.has(severity) ? { severity: severity as NonNullable<Finding['severity']> } : {}),
        ...(typeof where === 'string' && where.trim() !== '' ? { where } : {}),
        ...(typeof expected === 'string' && expected.trim() !== '' ? { expected } : {}),
        check: strings(f?.['check']),
      },
    ];
  });
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export async function runTask(options: EngineOptions, agent: AgentDefinition, task: string): Promise<RunResult> {
  const { report, gate, runners } = options;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const now = options.now ?? (() => new Date());

  // --- Preconditions: everything that can be checked before spending tokens.
  const root = await repoRoot(options.root);
  if (!root) throw new Error(`${options.root} is not inside a git repository`);
  const base = await headCommit(root);
  if (!base) throw new Error('the repository has no commits yet; commit something first');

  const [skills, allHooks] = await Promise.all([listSkills(options.root), loadHooks(options.root)]);
  const problems = validateAgent(agent, { skills, hooks: allHooks });
  if (problems.length > 0) throw new Error(`agent /${agent.name} is not valid:\n  ${problems.join('\n  ')}`);

  const roles: Record<Role, RoleAssignment> = {
    planner: agent.roles.reviewer,
    implementer: agent.roles.implementer,
    reviewer: agent.roles.reviewer,
  };
  for (const role of ['planner', 'implementer', 'reviewer'] as const) {
    const runner = runners[roles[role].runner];
    const detection = await runner.detect();
    if (!detection.found) throw new Error(`${runner.displayName} (${role}) is not installed`);
    if (!runner.capabilities.verified) {
      if (role === 'implementer' && !options.allowUnverified) {
        throw new Error(
          `${runner.displayName} has an unverified adapter, so Warband cannot tell what it will do when allowed to edit. ` +
            'See docs/runners.md, or pass --allow-unverified to accept that.',
        );
      }
      report({ type: 'warning', message: `${runner.displayName} (${role}) has an unverified adapter, see docs/runners.md` });
    }
  }

  const dirty = await uncommitted(root);
  if (dirty.length > 0) {
    report({
      type: 'warning',
      message: `${dirty.length} uncommitted change(s) in the project are not part of this run: it starts from the last commit`,
    });
  }

  const skillTexts = await Promise.all(skills.filter((s) => agent.skills.includes(s.name)).map(async (s) => ({ name: s.name, text: await readFile(s.path, 'utf8') })));
  const hooks = agent.hooks.map((name) => allHooks.find((h) => h.name === name)).filter((h): h is Hook => h !== undefined);
  const hooksFor = (stage: HookStage): Hook[] => hooks.filter((h) => h.stage === stage);
  const reslop = options.reslop === false ? undefined : (options.reslop ?? (await which('reslop')));
  if (!reslop && hooks.some((h) => h.reduce)) {
    report({ type: 'warning', message: 'reslop is not installed, so hooks marked "reduce" give their full output (npm i -g reslop)' });
  }
  const signal = options.signal;

  // --- Worktree: the agents never touch the person's own checkout, and the
  // checkout is not an ancestor of their working directory (ADR-0003).
  // Two runs of one agent started within the same second get -2, -3...
  const home = options.worktrees ?? worktreesHome();
  const stem = `${agent.name}-${stamp(now())}`;
  let runId = stem;
  for (let n = 2; (await branchExists(root, `warband/${runId}`)) || existsSync(worktreePath(root, runId, home)); n++) {
    runId = `${stem}-${n}`;
  }
  const branch = `warband/${runId}`;
  const worktree = worktreePath(root, runId, home);
  await mkdir(dirname(worktree), { recursive: true });
  await excludeLocally(root, ['.warband/runs/']);
  await addWorktree(root, worktree, branch, base);
  report({ type: 'run_started', runId, agent: agent.name, task, worktree, branch, base });

  const ctx: PromptContext = {
    instructions: agent.description,
    skills: skillTexts,
    task,
    checks: hooksFor('checks').map((h) => `${h.name}: ${h.run}`),
  };

  async function step(stage: Stage, role: Role, prompt: string, access: Access, jsonSchema?: Record<string, unknown>): Promise<StepResult> {
    const assignment = roles[role];
    const runner = runners[assignment.runner];
    report({
      type: 'agent_started',
      stage,
      role,
      runner: assignment.runner,
      access,
      ...(assignment.model ? { model: assignment.model } : {}),
    });
    const started = Date.now();
    const result: StepResult = { ok: false, text: '', deniedTools: [], errors: [] };
    let sawResult = false;
    for await (const raw of runner.run({
      prompt,
      cwd: worktree,
      timeoutMs: timeouts.agent,
      access,
      ...(signal ? { signal } : {}),
      ...(assignment.model ? { model: assignment.model } : {}),
      ...(jsonSchema ? { jsonSchema } : {}),
    })) {
      for (const event of toAgentEvents(raw, runner.mapRaw)) {
        report({ type: 'agent', stage, role, event });
        if (event.kind === 'result') {
          sawResult = true;
          result.ok = event.ok;
          result.text = event.text;
          result.deniedTools = event.deniedTools;
          if (event.structured !== undefined) result.structured = event.structured;
        } else if (event.kind === 'error') {
          result.errors.push(event.message);
        }
      }
    }
    if (!sawResult) result.errors.push('the agent ended without a final result');
    result.ok = result.ok && result.errors.length === 0;
    report({ type: 'agent_finished', stage, role, ok: result.ok, seconds: Math.round((Date.now() - started) / 1000) });
    return result;
  }

  async function runHooks(stage: HookStage): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const hook of hooksFor(stage)) {
      report({ type: 'hook_started', stage, name: hook.name, run: hook.run });
      const result = await runHook(hook, worktree, {
        timeoutMs: timeouts.hook,
        warbandDir: warbandDir(options.root),
        ...(reslop ? { reslop } : {}),
        ...(signal ? { signal } : {}),
      });
      report({ type: 'hook', stage, result });
      results.push(result);
    }
    return results;
  }

  const describeFailures = (results: readonly HookResult[]): string =>
    results
      .filter((r) => !r.ok)
      .map((r) => `Check "${r.name}" failed (${r.timedOut ? 'timed out' : `exit ${r.exitCode}`}). Its output:\n${r.output.join('\n')}`)
      .join('\n\n');

  // --- The route. Each handler returns the stage outcome; advance() decides what comes next.
  let feedback: string | undefined;
  let planFeedback: string | undefined;
  let summary = '';
  let reviewComments: string[] = [];
  let reviewFindings: Finding[] = [];
  let commit: string | undefined;

  const handlers: Record<Stage, (state: RunState) => Promise<Outcome>> = {
    async clarify() {
      const result = await step('clarify', 'planner', clarifyPrompt(ctx), 'read', CLARIFY_SCHEMA as unknown as Record<string, unknown>);
      if (!result.ok) return 'failed';
      const answer = record(structuredAnswer(result));
      const questions = answer?.['status'] === 'questions' ? strings(answer['questions']) : [];
      if (questions.length > 0) {
        report({ type: 'gate_open', stage: 'clarify', questions });
        const answers = (await gate.answerQuestions(questions)).trim();
        if (answers !== '') {
          ctx.clarifications = questions.map((q, i) => `${i + 1}. ${q}`).join('\n') + `\n\nAnswers:\n${answers}`;
        }
      }
      return 'ok';
    },

    async plan() {
      const previous = planFeedback && ctx.plan ? { plan: ctx.plan, feedback: planFeedback } : undefined;
      const result = await step('plan', 'planner', planPrompt(ctx, previous), 'read');
      if (!result.ok || result.text.trim() === '') return 'failed';
      ctx.plan = result.text.trim();
      planFeedback = undefined;
      return 'ok';
    },

    async approve() {
      report({ type: 'gate_open', stage: 'approve', plan: ctx.plan ?? '' });
      const decision = await gate.reviewPlan(ctx.plan ?? '');
      report({ type: 'gate', stage: 'approve', outcome: decision.outcome, ...(decision.comment ? { comment: decision.comment } : {}) });
      if (decision.outcome === 'changes_requested') planFeedback = decision.comment ?? 'Improve the plan.';
      return decision.outcome;
    },

    async implement(state) {
      const rework = state.reworks > 0 && feedback ? { attempt: state.reworks, feedback } : undefined;
      const result = await step('implement', 'implementer', implementPrompt(ctx, rework), 'edit');
      summary = result.text.trim();
      if (!result.ok) {
        feedback = `The previous attempt did not finish: ${result.errors.join('; ') || 'the agent reported a failure'}.`;
        return 'failed';
      }
      return 'ok';
    },

    async checks() {
      const results = await runHooks('checks');
      if (results.every((r) => r.ok)) return 'ok';
      feedback = describeFailures(results);
      return 'failed';
    },

    async review(state) {
      const change = await stagedDiff(worktree, base);
      if (change.diff.trim() === '') {
        feedback = 'No files were changed. Implement the plan.';
        reviewComments = ['No files were changed.'];
        return 'changes_requested';
      }
      const result = await step('review', 'reviewer', reviewPrompt(ctx, { diff: change.diff, summary }), 'read', REVIEW_SCHEMA as unknown as Record<string, unknown>);
      if (!result.ok) return 'failed';
      const answer = record(structuredAnswer(result));
      const verdict = answer?.['verdict'];
      if (verdict !== 'approve' && verdict !== 'changes_requested') return 'failed';
      reviewFindings = findings(answer?.['findings']);
      reviewComments = reviewFindings.map(findingLine);
      report({ type: 'review', verdict, findings: reviewFindings });
      if (verdict === 'approve') return 'ok';
      if (reviewFindings.length === 0) {
        reviewFindings = [{ problem: 'The reviewer asked for changes without details. Re-read the plan and the task.' }];
      }
      const name = await writePlan(worktree, renderPlan(`Review of attempt ${state.reworks + 1}`, reviewFindings), now());
      report({ type: 'plan_written', stage: 'review', name, source: 'reviewer', findings: reviewFindings.length });
      feedback = plansFeedback(pendingPlans(await readPlans(worktree)));
      return 'changes_requested';
    },

    async accept() {
      const change = await stagedDiff(worktree, base);
      const request: AcceptRequest = { summary, diffStat: change.stat, reviewComments, findings: reviewFindings, worktree, base, branch };
      report({ type: 'gate_open', stage: 'accept', result: request });
      const decision = await gate.acceptResult(request);
      report({ type: 'gate', stage: 'accept', outcome: decision.outcome, ...(decision.comment ? { comment: decision.comment } : {}) });
      if (decision.outcome === 'changes_requested') {
        // Line comments become a plan; a plan the person wrote in reslop is already in .plan/.
        const lineComments = decision.findings ?? [];
        if (lineComments.length > 0) {
          const name = await writePlan(worktree, renderPlan('Changes asked for at acceptance', lineComments, decision.comment), now());
          report({ type: 'plan_written', stage: 'accept', name, source: 'person', findings: lineComments.length });
        }
        const pending = pendingPlans(await readPlans(worktree));
        const said =
          decision.comment && lineComments.length === 0 ? `The person who set the task asked for changes:\n${decision.comment}` : '';
        feedback =
          [said, pending.length > 0 ? plansFeedback(pending) : ''].filter(Boolean).join('\n\n') ||
          'The person who set the task asked for changes but gave no details. Re-read the task and the plan.';
      }
      return decision.outcome;
    },

    async finish() {
      const results = await runHooks('finish');
      if (!results.every((r) => r.ok)) return 'failed';
      const firstLine = task.split('\n')[0]?.slice(0, 72) ?? task;
      commit = await commitAll(worktree, `${agent.name}: ${firstLine}\n\nMade by Warband run ${runId}.`);
      return 'ok';
    },
  };

  let state = initialState();
  try {
    const setup = await runHooks('setup');
    const failed = setup.find((r) => !r.ok);
    if (failed) throw new Error(`setup hook "${failed.name}" failed, so no agent was started`);
    while (state.status !== 'done' && state.status !== 'halted') {
      if (signal?.aborted) {
        state = { ...state, status: 'halted', haltReason: 'cancelled' };
        break;
      }
      report({ type: 'stage', stage: state.stage, reworks: state.reworks });
      const outcome = await handlers[state.stage](state);
      state = signal?.aborted
        ? { ...state, status: 'halted', haltReason: 'cancelled' }
        : advance(state, outcome, options.route ?? DEFAULT_ROUTE);
    }
  } catch (err) {
    state = { ...state, status: 'halted', haltReason: (err as Error).message };
  }

  // --- Cleanup: keep the worktree only when there is something to look at.
  // A process a hook left running (a build daemon, a watcher) can hold the
  // folder. The run's result stands either way: the folder is reported as kept.
  // Review plans and reslop logs are not committed; they are kept with the run.
  const archive = join(warbandDir(options.root), 'runs', runId);
  let archived = false;
  for (const dir of UNSTAGED_DIRS) {
    try {
      await cp(join(worktree, dir), join(archive, dir.slice(1)), { recursive: true });
      archived = true;
    } catch {
      // nothing to keep
    }
  }

  let kept: string | undefined;
  const remove = async (deleteBranch?: string): Promise<void> => {
    try {
      await removeWorktree(root, worktree, deleteBranch);
    } catch (err) {
      kept = worktree;
      report({
        type: 'warning',
        message: `could not remove ${worktree} (${(err as Error).message}). A process started by a hook may still be using it; delete the folder later and run git worktree prune`,
      });
    }
  };
  if (state.status === 'done') {
    await remove();
  } else {
    const change = await stagedDiff(worktree, base).catch(() => ({ diff: '', stat: [] }));
    if (change.diff.trim() === '') await remove(branch);
    else kept = worktree;
  }

  report({
    type: 'run_finished',
    state,
    ...(state.status === 'done' ? { branch } : {}),
    ...(commit ? { commit } : {}),
    ...(kept ? { worktree: kept } : {}),
    ...(archived ? { archive } : {}),
  });
  return { runId, state, branch, ...(commit ? { commit } : {}), ...(kept ? { worktree: kept } : {}) };
}
