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
