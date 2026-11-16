import { evaluate } from './policy.ts';
import { runProcess } from './proc.ts';

/**
 * A hook is a deterministic check run by Warband itself, not by a model:
 * a linter, the test suite, a pre-commit script. It costs no tokens and its
 * verdict is the exit code.
 *
 *   setup   once, in the fresh worktree before any agent runs, such as
 *           installing dependencies (ignored files like node_modules are not
 *           in a new worktree); a failure stops the run
 *   checks  after implement; a failing hook sends the task back to implement
 *   finish  right before the result is committed (pre-commit style)
 */
export const HOOK_STAGES = ['setup', 'checks', 'finish'] as const;
export type HookStage = (typeof HOOK_STAGES)[number];

export interface Hook {
  name: string;
  description: string;
  /** Shell command line, run in the task worktree. */
  run: string;
  stage: HookStage;
  /**
   * Extra environment variables, set the same way on every OS. For example
   * NX_DAEMON=false, so Nx does not leave a daemon holding the worktree.
   */
  env?: Record<string, string>;
  /** Run through `reslop t` when reslop is installed, for a short report of failures. */
  reduce?: boolean;
}

export interface HookResult {
  name: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** The output is reslop's reduced report. */
  reduced: boolean;
  /** Last lines of combined stdout and stderr. */
  output: string[];
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** An environment variable name that every shell and OS takes as is. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type HookProblemCode =
  | 'name-invalid'
  | 'name-taken'
  | 'rename-in-use'
  | 'run-empty'
  | 'run-denied'
  | 'stage-unknown'
  | 'env-name-invalid'
  | 'env-name-duplicate'
  | 'reduce-stage';

/**
 * One reason a hook cannot be saved, with the field it belongs to. `message`
 * is the English text the wizard prints; the window shows its own text by
 * `code`.
 */
export interface HookProblem {
  field: 'name' | 'run' | 'stage' | 'env' | 'reduce';
  code: HookProblemCode;
  message: string;
  /** run-denied: the policy rule that denied the command. */
  rule?: string;
  /** env-name-*: the variable name. */
  key?: string;
  /** rename-in-use: agents that use the hook under its old name and would have their references updated. */
  agents?: string[];
}

export function checkHook(hook: Hook, workspace: string): HookProblem[] {
  const problems: HookProblem[] = [];
  if (!NAME_PATTERN.test(hook.name)) {
    problems.push({ field: 'name', code: 'name-invalid', message: `hook name "${hook.name}" must be lowercase letters, digits and dashes` });
  }
  if (hook.run.trim() === '') problems.push({ field: 'run', code: 'run-empty', message: `hook "${hook.name}" has no command` });
  if (!(HOOK_STAGES as readonly string[]).includes(hook.stage)) {
    problems.push({ field: 'stage', code: 'stage-unknown', message: `hook "${hook.name}" has unknown stage "${hook.stage}"` });
  }
  const decision = evaluate({ kind: 'shell', command: hook.run }, { workspace });
  if (decision.effect === 'deny') {
    problems.push({
      field: 'run',
      code: 'run-denied',
      message: `hook "${hook.name}" is denied by policy: ${decision.reason ?? decision.rule ?? 'deny'}`,
      ...(decision.rule ? { rule: decision.rule } : {}),
    });
  }
  // reslop's short report is for failures that go back to the implementer; the wizard asks only for checks hooks.
  if (hook.reduce === true && hook.stage !== 'checks') {
    problems.push({
      field: 'reduce',
      code: 'reduce-stage',
      message: `hook "${hook.name}": reduce works only for the checks stage; turn it off or move the hook to checks`,
    });
  }
  for (const key of Object.keys(hook.env ?? {})) {
    if (!ENV_NAME_PATTERN.test(key)) {
      problems.push({ field: 'env', code: 'env-name-invalid', key, message: `hook "${hook.name}": environment variable name "${key}" must be letters, digits and _, not starting with a digit` });
    }
  }
  return problems;
}

export function validateHook(hook: Hook, workspace: string): string[] {
  return checkHook(hook, workspace).map((p) => p.message);
}

const OUTPUT_TAIL = 40;

/**
 * `{warband}` in a hook command stands for the absolute path of the
 * project's .warband folder. Hooks run in a worktree made from the last
 * commit, which does not have an uncommitted .warband, so a script kept
 * there is reached as `node "{warband}/hooks/check.mjs"`.
 */
export const expandRun = (run: string, warbandDir: string | undefined): string =>
  warbandDir === undefined ? run : run.replaceAll('{warband}', warbandDir.replaceAll('\\', '/'));

export interface HookRunOptions {
  timeoutMs?: number;
  /** The project's .warband folder, for `{warband}` in commands. */
  warbandDir?: string;
  /**
   * Path of the reslop binary when it is installed. A hook with `reduce`
   * then runs as `reslop t -- <command>`, which keeps the exit code and cuts
   * the output down to failures and a short summary.
   */
  reslop?: string;
  signal?: AbortSignal;
}

// Colour and cursor codes: the output is read by a model and shown as text.
const stripAnsi = (line: string): string => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/** reslop's reduced report is short and is the point, so more of it is kept. */
const REDUCED_TAIL = 200;

export async function runHook(hook: Hook, cwd: string, options: HookRunOptions = {}): Promise<HookResult> {
  const output: string[] = [];
  let exitCode: number | null = null;
  let timedOut = false;
  let spawnError: string | undefined;
  const reduced = Boolean(hook.reduce && options.reslop);
  const command = expandRun(hook.run, options.warbandDir);
  const tail = reduced ? REDUCED_TAIL : OUTPUT_TAIL;

  for await (const event of runProcess(reduced ? `reslop t -- ${command}` : command, [], {
    cwd,
    timeoutMs: options.timeoutMs ?? 600_000,
    shell: true,
    ...(hook.env ? { env: { ...process.env, ...hook.env } } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    switch (event.type) {
      case 'stdout':
      case 'stderr':
        output.push(stripAnsi(event.line));
        if (output.length > tail) output.shift();
        break;
      case 'spawn_error':
        spawnError = event.message;
        break;
      case 'exit':
        exitCode = event.code;
        timedOut = event.timedOut;
        break;
    }
  }
  if (spawnError) output.push(spawnError);
  return { name: hook.name, ok: !spawnError && !timedOut && exitCode === 0, exitCode, timedOut, reduced, output };
}
