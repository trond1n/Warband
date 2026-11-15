import type { RawMapper } from './events.ts';
import { runProcess } from './proc.ts';

export const KNOWN_RUNNER_IDS = ['claude', 'codex', 'antigravity', 'kimi'] as const;

export type RunnerId = (typeof KNOWN_RUNNER_IDS)[number];

/**
 * What a CLI can do when it runs without a human at the terminal.
 * Every field is a claim to be confirmed by `npm run spike`; `verified`
 * stays false until someone has run the probe against a real install.
 */
export interface Capabilities {
  /** How Warband talks to the CLI. */
  transport: 'print' | 'stream' | 'pty';
  /** stdout carries one JSON object per line. */
  structuredOutput: boolean;
  /** Isolation the CLI provides on its own. */
  sandbox: 'os' | 'agent' | 'none';
  /** What happens to a tool call that would ask for approval interactively. */
  headlessApprovals: 'auto-run' | 'deny' | 'may-hang' | 'unknown';
  verified: boolean;
  /**
   * The CLI version the probes confirmed these fields on, e.g. "2.1.325".
   * Set together with `verified`. CLIs update themselves, so a different
   * installed version is reported (see `versionDrift`) but not blocked.
   */
  verifiedOn?: string;
}

/**
 * The last full set of probes run on this machine, kept in the machine
 * settings (providers.json). When every probe gave the result recorded for
 * the verified version, `differs` is empty and the installed version counts
 * as checked locally: no drift warning for it. The code's `verifiedOn` is
 * never changed by this.
 */
export interface LocalCheck {
  /** The CLI version the probes ran on, as --version printed it. */
  version: string;
  /** ISO time of the run. */
  at: string;
  /** Probes whose result differed from the recorded one; empty when all matched. */
  differs: string[];
}

/** The first dotted number in a version line, e.g. "2.1.325 (Claude Code)" -> [2, 1, 325]. */
export function parseVersion(text: string | undefined): number[] | undefined {
  const match = /\d+(?:\.\d+)+/.exec(text ?? '');
  return match ? match[0].split('.').map(Number) : undefined;
}

/**
 * How the installed version compares with the one the adapter was verified
 * on. Any difference counts, patch included: these CLIs release under the
 * patch number (Claude Code 2.1.325 is one of hundreds of 2.1 releases), and
 * the headless contract has changed inside a patch series (docs/runners.md:
 * agy 1.5.0 to 1.5.9 changed where print mode writes). Comparing only the
 * major or minor part would stay silent through exactly those changes.
 */
export type VersionDrift =
  /** Nothing to compare: the adapter is not verified, or the CLI is not installed. */
  | { kind: 'none' }
  | { kind: 'same'; verifiedOn: string }
  /** The probes passed on this machine on the installed version, so it is not reported. */
  | { kind: 'checked'; verifiedOn: string; installed: string; at: string }
  /** `failed`: the probes ran on the installed version here and these gave a different result. */
  | { kind: 'differs'; verifiedOn: string; installed: string; newer: boolean; failed?: string[] }
  /** The CLI did not print a version Warband can read. */
  | { kind: 'unknown'; verifiedOn: string };

const sameVersion = (a: number[] | undefined, b: number[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((n, i) => n === b[i]);

/** `local`: the last full probe run on this machine, from the machine settings. */
export function versionDrift(capabilities: Capabilities, installed: string | undefined, found = true, local?: LocalCheck): VersionDrift {
  const verifiedOn = capabilities.verifiedOn;
  if (!capabilities.verified || verifiedOn === undefined || !found) return { kind: 'none' };
  const want = parseVersion(verifiedOn);
  const have = parseVersion(installed);
  if (!want || !have) return { kind: 'unknown', verifiedOn };
  const length = Math.max(want.length, have.length);
  for (let i = 0; i < length; i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a === b) continue;
    const version = have.join('.');
    // Only a run on exactly this version says anything about it.
    if (local && sameVersion(parseVersion(local.version), have)) {
      if (local.differs.length === 0) return { kind: 'checked', verifiedOn, installed: version, at: local.at };
      return { kind: 'differs', verifiedOn, installed: version, newer: a > b, failed: [...local.differs] };
    }
    return { kind: 'differs', verifiedOn, installed: version, newer: a > b };
  }
  return { kind: 'same', verifiedOn };
}

/** One line for the terminal and the run log, or undefined when there is nothing to say. */
export function driftMessage(name: string, id: string, drift: VersionDrift): string | undefined {
  const probe = `Run the probes to check it: npm run spike -- ${id}, or "Проверить" in the window.`;
  if (drift.kind === 'differs' && drift.failed) {
    return `${name} is ${drift.installed}, but its adapter was verified on ${drift.verifiedOn}, and on this machine these probes gave a different result: ${drift.failed.join(', ')}. Headless behaviour has changed; see docs/runners.md before relying on it.`;
  }
  if (drift.kind === 'differs') {
    return `${name} is ${drift.installed}, but its adapter was verified on ${drift.verifiedOn}; headless behaviour may have changed. ${probe}`;
  }
  if (drift.kind === 'unknown') return `${name} did not report a version Warband can compare with ${drift.verifiedOn}, the one its adapter was verified on. ${probe}`;
  return undefined;
}

export type RunnerEvent =
  /** A stdout line that parsed as a JSON object. Shape is CLI-specific. */
  | { type: 'raw'; data: Record<string, unknown> }
  /** A stdout line that was not JSON. */
  | { type: 'text'; text: string }
  | { type: 'stderr'; text: string }
  | { type: 'done'; exitCode: number | null; timedOut: boolean }
  | { type: 'error'; message: string };

/**
 * What the agent may do without asking:
 *   read  read the project; anything that would need approval is denied.
 *         Not "no shell": Claude Code runs commands it considers read-only
 *         (ls, cat, head) without approval, seen in a real run.
 *   edit  also create and edit files inside `cwd`; other shell commands are
 *         still denied
 */
export type Access = 'read' | 'edit';

export interface RunRequest {
  prompt: string;
  /** Working directory, normally a per-task git worktree. */
  cwd: string;
  model?: string;
  /** Defaults to 'read'. */
  access?: Access;
  /** JSON Schema the final answer must match, for CLIs that support it. */
  jsonSchema?: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface Detection {
  found: boolean;
  version?: string;
  problem?: string;
}

/**
 * Whether the CLI says it is logged in. Learned only by asking the CLI
 * itself (ADR-0001); 'unknown' when it has no way to tell.
 */
export interface LoginState {
  state: 'in' | 'out' | 'unknown';
  /** How, as the CLI names it, e.g. "claude.ai". */
  method?: string;
}

export interface Runner {
  readonly id: RunnerId;
  readonly displayName: string;
  readonly binary: string;
  readonly capabilities: Capabilities;
  /** The last full probe run on this machine, from the machine settings. */
  readonly localCheck?: LocalCheck;
  /** Maps this CLI's JSON lines to common events. Absent until real logs exist. */
  readonly mapRaw?: RawMapper;
  detect(): Promise<Detection>;
  /** Asks the CLI for its login state, for CLIs that report it. */
  login?(): Promise<LoginState>;
  run(request: RunRequest): AsyncIterable<RunnerEvent>;
}

export interface CliRunnerSpec {
  id: RunnerId;
  displayName: string;
  binary: string;
  capabilities: Capabilities;
  versionArgs: readonly string[];
  /** Builds argv for one headless run. */
  buildArgs(request: RunRequest): string[];
  /**
   * Send the prompt on stdin instead of argv. buildArgs must then leave it
   * out. Only for CLIs where this has been checked.
   */
  promptOnStdin?: boolean;
  mapRaw?: RawMapper;
  /** A command that makes the CLI report its own login state, and how to read its stdout. */
  login?: { args: readonly string[]; parse(stdout: string): LoginState };
}

/** Turns one stdout line into an event without assuming a CLI-specific schema. */
export function parseLine(line: string): RunnerEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('{')) {
    try {
      const data: unknown = JSON.parse(trimmed);
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        return { type: 'raw', data: data as Record<string, unknown> };
      }
    } catch {
      // Not JSON after all: fall through and report it as text.
    }
  }
  return { type: 'text', text: line };
}

async function askLogin(binary: string, login: NonNullable<CliRunnerSpec['login']>): Promise<LoginState> {
  const lines: string[] = [];
  let code: number | null = null;
  for await (const event of runProcess(binary, login.args, { cwd: process.cwd(), timeoutMs: 15_000 })) {
    if (event.type === 'stdout') lines.push(event.line);
    if (event.type === 'spawn_error') return { state: 'unknown' };
    if (event.type === 'exit') code = event.timedOut ? null : event.code;
  }
  if (code === null) return { state: 'unknown' };
  try {
    return login.parse(lines.join('\n'));
  } catch {
    return { state: 'unknown' };
  }
}

/** A runner that launches an installed CLI as a child process. */
export function cliRunner(spec: CliRunnerSpec): Runner {
  return {
    id: spec.id,
    displayName: spec.displayName,
    binary: spec.binary,
    capabilities: spec.capabilities,
    ...(spec.mapRaw ? { mapRaw: spec.mapRaw } : {}),

    async detect(): Promise<Detection> {
      let output = '';
      for await (const event of runProcess(spec.binary, spec.versionArgs, {
        cwd: process.cwd(),
        timeoutMs: 15_000,
      })) {
        if (event.type === 'stdout' && output === '') output = event.line.trim();
        if (event.type === 'spawn_error') return { found: false, problem: event.message };
        if (event.type === 'exit') {
          if (event.timedOut) return { found: true, problem: 'version check timed out' };
          if (event.code !== 0) return { found: true, problem: `version check exited with ${event.code}` };
        }
      }
      return output === '' ? { found: true } : { found: true, version: output };
    },

    ...(spec.login ? { login: () => askLogin(spec.binary, spec.login as NonNullable<CliRunnerSpec['login']>) } : {}),

    async *run(request: RunRequest): AsyncGenerator<RunnerEvent> {
      const procOptions = {
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(spec.promptOnStdin ? { input: request.prompt } : {}),
      };
      for await (const event of runProcess(spec.binary, spec.buildArgs(request), procOptions)) {
        switch (event.type) {
          case 'stdout': {
            const parsed = parseLine(event.line);
            if (parsed) yield parsed;
            break;
          }
          case 'stderr':
            yield { type: 'stderr', text: event.line };
            break;
          case 'spawn_error':
            yield { type: 'error', message: event.message };
            break;
          case 'exit':
            yield { type: 'done', exitCode: event.code, timedOut: event.timedOut };
            break;
        }
      }
    },
  };
}
