import { join } from 'node:path';

import { expandRun, runHook } from '../../../src/core/hooks.ts';
import type { HookProblem } from '../../../src/core/hooks.ts';
import { deleteHook, HookInUseError, HookInvalidError, hookFromInput, HooksChangedError, listAgents, readHooks, saveHook, warbandDir } from '../../../src/core/workspace.ts';
import type { HookInput } from '../../../src/core/workspace.ts';
import { keepLogsClean } from '../../../src/core/reslop-logs.ts';
import type { DeleteHookResult, HookInfo, HooksView, SaveHookResult, TrialRequest, TrialResult } from '../shared/api.ts';

/*
 * The "Хуки" screen: .warband/hooks.json of a project, edited one hook at a
 * time through the core, and a trial run of a hook in the project checkout,
 * the way `warband check` runs it. No Electron here, so it is tested with
 * node:test.
 *
 * A trial run is an arbitrary shell command, so it takes two calls: the
 * window asks for the exact command line (`request`), shows it to the person,
 * and passes the command they confirmed back to `trial`, which runs only if
 * it is still exactly what would run.
 */

export interface HookServiceOptions {
  /** Path of reslop when it is on PATH. */
  reslop(): string | undefined;
}

export class HookService {
  readonly #options: HookServiceOptions;
  #trial: AbortController | undefined;

  constructor(options: HookServiceOptions) {
    this.#options = options;
  }

  async view(root: string): Promise<HooksView> {
    const reslop = this.#options.reslop();
    const base = { warbandDir: warbandDir(root), ...(reslop ? { reslop } : {}) };
    let snapshot;
    try {
      snapshot = await readHooks(root);
    } catch (err) {
      return { ...base, hooks: [], version: 'unreadable', error: (err as Error).message };
    }
    // A broken agent file must not hide the hooks; "used by" is then unknown.
    let agents: { name: string; hooks: string[] }[] | undefined;
    let agentsError: string | undefined;
    try {
      agents = await listAgents(root);
    } catch (err) {
      agentsError = (err as Error).message;
    }
    const hooks = snapshot.hooks.map((hook): HookInfo => ({
      hook,
      ...(agents ? { usedBy: agents.filter((a) => a.hooks.includes(hook.name)).map((a) => a.name) } : {}),
    }));
    return { ...base, hooks, version: snapshot.version, ...(agentsError ? { agentsError } : {}) };
  }

  /** `renameAgents`: the agents the person agreed to update when a used hook gets a new name. */
  async save(root: string, input: HookInput, original: string | undefined, version: string, renameAgents?: readonly string[]): Promise<SaveHookResult> {
    try {
      const saved = await saveHook(root, input, {
        ...(original !== undefined ? { original } : {}),
        expectedVersion: version,
        ...(renameAgents ? { renameAgents } : {}),
      });
      return { ok: true, version: saved.version, name: saved.hook.name };
    } catch (err) {
      if (err instanceof HookInvalidError) return { ok: false, problems: err.problems };
      if (err instanceof HooksChangedError) return { ok: false, changed: true };
      return { ok: false, error: (err as Error).message };
    }
  }

  async remove(root: string, name: string, version: string): Promise<DeleteHookResult> {
    try {
      const snapshot = await deleteHook(root, name, version);
      return { ok: true, version: snapshot.version };
    } catch (err) {
      if (err instanceof HookInUseError) return { ok: false, usedBy: err.agents };
      if (err instanceof HooksChangedError) return { ok: false, changed: true };
      return { ok: false, error: (err as Error).message };
    }
  }

  /** The exact command line, folder and variables a trial run would use, as the confirmation shows them. */
  request(root: string, input: HookInput): TrialRequest | { problems: HookProblem[] } {
    const { hook, problems } = hookFromInput(input, root);
    if (problems.length > 0) return { problems };
    const reslop = this.#options.reslop();
    const command = expandRun(hook.run, warbandDir(root));
    const reduced = Boolean(hook.reduce && reslop);
    return { command: reduced ? `reslop t -- ${command}` : command, cwd: root, env: hook.env ?? {}, reduced };
  }

  /**
   * Runs the hook as the form has it now, saved or not, in the project
   * checkout, as `warband check` does. `confirmed` is the command line the
   * person saw and accepted; if the hook would now run anything else (the
   * form changed, reslop appeared or went away), nothing runs. Refused too
   * while the hook has problems and while another trial runs.
   */
  async trial(root: string, input: HookInput, confirmed: string): Promise<TrialResult> {
    if (this.#trial) return { status: 'refused', error: 'Уже идёт пробный запуск.' };
    const request = this.request(root, input);
    if ('problems' in request) return { status: 'invalid', problems: request.problems };
    if (request.command !== confirmed) return { status: 'refused', error: 'Команда изменилась после подтверждения. Запустите ещё раз.' };
    const controller = new AbortController();
    this.#trial = controller;
    try {
      const { hook } = hookFromInput(input, root);
      const reslop = this.#options.reslop();
      const started = Date.now();
      const run = (): ReturnType<typeof runHook> => runHook(hook, root, { warbandDir: warbandDir(root), ...(reslop ? { reslop } : {}), signal: controller.signal });
      // reslop records each run in .log/ of the checkout; a trial from the window takes that back.
      const hold = join(warbandDir(root), `.trial-hold-${process.pid}-${started}`);
      const { result, cleanup } = request.reduced ? await keepLogsClean(root, hold, run) : { result: await run(), cleanup: undefined };
      return {
        status: controller.signal.aborted ? 'cancelled' : 'finished',
        command: request.command,
        cwd: root,
        ok: result.ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        reduced: result.reduced,
        seconds: (Date.now() - started) / 1000,
        output: result.output,
        ...(cleanup ? { logs: cleanup } : {}),
      };
    } finally {
      this.#trial = undefined;
    }
  }

  cancelTrial(): void {
    this.#trial?.abort();
  }

  get running(): boolean {
    return this.#trial !== undefined;
  }
}
