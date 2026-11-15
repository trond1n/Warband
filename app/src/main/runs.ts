import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { validateAgent } from '../../../src/core/agents.ts';
import type { Runner, RunnerId } from '../../../src/core/runner.ts';
import { listAgents, listSkills, loadAgent, loadHooks, warbandDir } from '../../../src/core/workspace.ts';
import { git } from '../../../src/engine/git.ts';
import { eventLog } from '../../../src/engine/log.ts';
import { parsePlan, PLAN_DIR, readPlans } from '../../../src/engine/plan-file.ts';
import { runTask } from '../../../src/engine/run.ts';
import type { EngineEvent, GateDecision, HumanGate } from '../../../src/engine/run.ts';
import type { DiffFile, PlanInfo, ProjectInfo, RunStatus, RunSummary, TimedEvent } from '../shared/api.ts';

/*
 * Runs started from the window. The engine is the same one `warband run`
 * uses; this keeps the runs that are in progress, turns the human gates
 * into requests the window answers, and reads past runs from their event
 * logs. No Electron here, so it is tested with node:test.
 */

interface Active {
  root: string;
  events: TimedEvent[];
  controller: AbortController;
  gate?: { kind: 'questions'; resolve(answers: string): void } | { kind: 'decision'; resolve(decision: GateDecision): void };
}

export interface RunManagerOptions {
  runners: Readonly<Record<RunnerId, Runner>>;
  /** Every event of every active run, as it happens. */
  emit(runId: string, event: TimedEvent): void;
  /** A gate opened and is waiting for the person. */
  notify?(title: string, body: string): void;
  reslop?: string | false;
  now?: () => Date;
}

export class RunManager {
  readonly #options: RunManagerOptions;
  readonly #active = new Map<string, Active>();

  constructor(options: RunManagerOptions) {
    this.#options = options;
  }

  async project(root: string): Promise<ProjectInfo> {
    const problems: string[] = [];
    const [agents, skills, hooks] = await Promise.all([
      listAgents(root).catch((err: Error) => (problems.push(err.message), [])),
      listSkills(root).catch((err: Error) => (problems.push(err.message), [])),
      loadHooks(root).catch((err: Error) => (problems.push(err.message), [])),
    ]);
    for (const agent of agents) {
      for (const problem of validateAgent(agent, { skills, hooks })) problems.push(`/${agent.name}: ${problem}`);
    }
    const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return {
      root,
      name: basename(root),
      ...(head.code === 0 && head.stdout[0] ? { branch: head.stdout[0] } : {}),
      agents,
      skills: skills.map((s) => ({ name: s.name, description: s.description })),
      hooks,
      problems,
    };
  }

  async start(root: string, agentName: string, task: string): Promise<{ runId: string } | { error: string }> {
    const agent = await loadAgent(root, agentName).catch(() => undefined);
    if (!agent) return { error: `No agent "${agentName}" in ${root}` };
    if (task.trim() === '') return { error: 'The task is empty' };

    const log = eventLog(root);
    const controller = new AbortController();
    const held: TimedEvent[] = [];
    let runId: string | undefined;
    let active: Active | undefined;
    let started: (value: { runId: string } | { error: string }) => void = () => {};
    const result = new Promise<{ runId: string } | { error: string }>((resolve) => (started = resolve));

    const report = (event: EngineEvent): void => {
      log.write(event);
      const timed = { ...event, time: (this.#options.now?.() ?? new Date()).toISOString() } as TimedEvent;
      if (!active) {
        held.push(timed);
        if (event.type !== 'run_started') return;
        runId = event.runId;
        active = { root, events: [], controller };
        this.#active.set(runId, active);
        for (const e of held) this.#push(runId, active, e);
        started({ runId });
        return;
      }
      this.#push(runId as string, active, timed);
      if (event.type === 'gate_open') {
        const what = event.stage === 'clarify' ? 'Вопросы планировщика' : event.stage === 'approve' ? 'План готов' : 'Результат готов';
        this.#options.notify?.(`${what}: /${agent.name}`, task.split('\n')[0]?.slice(0, 120) ?? '');
      }
    };

    const gate: HumanGate = {
      answerQuestions: () => new Promise((resolve) => this.#setGate(runId, { kind: 'questions', resolve })),
      reviewPlan: () => new Promise((resolve) => this.#setGate(runId, { kind: 'decision', resolve })),
      acceptResult: () => new Promise((resolve) => this.#setGate(runId, { kind: 'decision', resolve })),
    };

    runTask(
      {
        root,
        runners: this.#options.runners,
        gate,
        report,
        signal: controller.signal,
        ...(this.#options.reslop !== undefined ? { reslop: this.#options.reslop } : {}),
        ...(this.#options.now ? { now: this.#options.now } : {}),
      },
      agent,
      task,
    )
      .catch((err: Error) => {
        // Before run_started this is a refused precondition; after it, the engine has already halted.
        if (!runId) started({ error: err.message });
      })
      .finally(() => {
        if (runId) this.#active.delete(runId);
      });
    return result;
  }

  #setGate(runId: string | undefined, gate: NonNullable<Active['gate']>): void {
    const active = runId ? this.#active.get(runId) : undefined;
    if (active) active.gate = gate;
  }

  #push(runId: string, active: Active, event: TimedEvent): void {
    active.events.push(event);
    this.#options.emit(runId, event);
  }

  decide(runId: string, decision: GateDecision): void {
    const active = this.#active.get(runId);
    if (active?.gate?.kind !== 'decision') return;
    const { resolve } = active.gate;
    delete active.gate;
    resolve(decision);
  }

  answer(runId: string, answers: string): void {
    const active = this.#active.get(runId);
    if (active?.gate?.kind !== 'questions') return;
    const { resolve } = active.gate;
    delete active.gate;
    resolve(answers);
  }

  /** Kills what is running; a run waiting at a gate is rejected there. */
  cancel(runId: string): void {
    const active = this.#active.get(runId);
    if (!active) return;
    active.controller.abort();
    if (active.gate?.kind === 'decision') this.decide(runId, { outcome: 'rejected' });
    else if (active.gate?.kind === 'questions') this.answer(runId, '');
  }

  /** Cancels every run and waits until they have stopped, for quitting. */
  async cancelAll(timeoutMs = 10_000): Promise<void> {
    const ids = [...this.#active.keys()];
    for (const id of ids) this.cancel(id);
    const deadline = Date.now() + timeoutMs;
    while (this.#active.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  get activeCount(): number {
    return this.#active.size;
  }

  isActive(runId: string): boolean {
    return this.#active.has(runId);
  }

  async events(root: string, runId: string): Promise<TimedEvent[]> {
    const active = this.#active.get(runId);
    if (active) return [...active.events];
    const file = join(warbandDir(root), 'runs', runId, 'events.jsonl');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as TimedEvent];
        } catch {
          return [];
        }
      });
  }

  async run(root: string, runId: string): Promise<{ summary: RunSummary; events: TimedEvent[] } | undefined> {
    const events = await this.events(root, runId);
    const summary = summarize(events, this.#active.get(runId));
    return summary ? { summary, events } : undefined;
  }

  async runs(root: string): Promise<RunSummary[]> {
    let ids: string[] = [];
    try {
      ids = await readdir(join(warbandDir(root), 'runs'));
    } catch {
      // no runs yet
    }
    for (const [id, active] of this.#active) if (active.root === root && !ids.includes(id)) ids.push(id);
    const summaries = await Promise.all(ids.map(async (id) => summarize(await this.events(root, id), this.#active.get(id))));
    return summaries.filter((s): s is RunSummary => s !== undefined).sort((a, b) => b.started.localeCompare(a.started));
  }

  /** What the run changed: from the worktree while it exists, from the branch after. */
  async diff(root: string, runId: string): Promise<DiffFile[]> {
    const started = (await this.events(root, runId)).find((e) => e.type === 'run_started');
    if (started?.type !== 'run_started') return [];
    const { base, branch, worktree } = started;
    const live = existsSync(worktree);
    const cwd = live ? worktree : root;
    if (live) await git(worktree, ['add', '-A', '--', '.', ':(exclude).plan', ':(exclude).log']);
    const names = await git(cwd, live ? ['diff', '--cached', '--name-status', '--no-renames', base] : ['diff', '--name-status', '--no-renames', base, branch]);
    if (names.code !== 0) return [];
    const show = async (rev: string, path: string): Promise<string> => {
      const out = await git(cwd, ['show', `${rev}:${path}`]);
      return out.code === 0 ? out.stdout.join('\n') : '';
    };
    const files: DiffFile[] = [];
    for (const line of names.stdout) {
      const [status = 'M', path] = line.split('\t');
      if (!path) continue;
      const original = status === 'A' ? '' : await show(base, path);
      const modified = status === 'D' ? '' : live ? await readFile(join(worktree, path), 'utf8').catch(() => '') : await show(branch, path);
      files.push({ path, status, original: printable(original), modified: printable(modified) });
    }
    return files;
  }

  /** Review plans of the run: in the worktree while it exists, else archived with the run. */
  async plans(root: string, runId: string): Promise<PlanInfo[]> {
    const started = (await this.events(root, runId)).find((e) => e.type === 'run_started');
    if (started?.type === 'run_started' && existsSync(join(started.worktree, PLAN_DIR))) {
      return (await readPlans(started.worktree)).map(planInfo);
    }
    const dir = join(warbandDir(root), 'runs', runId, 'plan');
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.md')).sort();
    return Promise.all(names.map(async (n) => planInfo(parsePlan(n, await readFile(join(dir, n), 'utf8')))));
  }

  async worktree(root: string, runId: string): Promise<string | undefined> {
    const started = (await this.events(root, runId)).find((e) => e.type === 'run_started');
    return started?.type === 'run_started' && existsSync(started.worktree) ? started.worktree : undefined;
  }
}

const planInfo = (p: { name: string; status: string | undefined; open: number; text: string }): PlanInfo => ({
  name: p.name,
  open: p.open,
  text: p.text,
  ...(p.status ? { status: p.status } : {}),
});

const printable = (text: string): string => (text.includes('\0') ? '(binary file)' : text);

/** A run's summary from its events, plus whether it is in progress here. */
export function summarize(events: readonly TimedEvent[], active?: { gate?: unknown }): RunSummary | undefined {
  const started = events.find((e) => e.type === 'run_started');
  if (started?.type !== 'run_started') return undefined;
  const finished = events.find((e) => e.type === 'run_finished');
  const stages = events.filter((e) => e.type === 'stage');
  const lastStage = stages.at(-1);
  let status: RunStatus;
  if (finished?.type === 'run_finished') status = finished.state.status === 'done' ? 'done' : 'halted';
  else if (active) status = active.gate ? 'waiting' : 'running';
  else status = 'interrupted';
  return {
    runId: started.runId,
    agent: started.agent,
    task: started.task,
    branch: started.branch,
    status,
    ...(lastStage?.type === 'stage' ? { stage: lastStage.stage } : {}),
    started: started.time,
    ...(finished ? { finished: finished.time } : {}),
    ...(finished?.type === 'run_finished' && finished.state.haltReason ? { haltReason: finished.state.haltReason } : {}),
    ...(finished?.type === 'run_finished' && finished.commit ? { commit: finished.commit } : {}),
  };
}
