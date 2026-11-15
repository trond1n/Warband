import type { RunnerEvent } from './runner.ts';

/**
 * CLI-independent events. Raw CLI output is mapped into these by one
 * function per CLI (see src/runners/events/), written only against fields
 * seen in real logs. Anything a mapper does not recognise is dropped, never
 * guessed at.
 */
export type AgentEvent =
  /** Text the assistant wrote to the user. */
  | { kind: 'assistant_text'; text: string }
  /** The agent asked to run a tool. This is the request, not its outcome. */
  | { kind: 'tool_call'; id?: string; name: string; input: unknown }
  /** The agent asked the user something and needs an answer to continue. */
  | { kind: 'question'; text: string }
  /** The run's final answer. `ok` is the CLI's own verdict on the turn. */
  | {
      kind: 'result';
      ok: boolean;
      text: string;
      deniedTools: string[];
      /** The answer as an object, when the run asked for a JSON Schema. */
      structured?: unknown;
    }
  | { kind: 'error'; message: string };

/** Maps one parsed JSON line from a CLI's stdout. */
export type RawMapper = (data: Record<string, unknown>) => AgentEvent[];

/**
 * Turns one runner event into common events. Process-level outcomes are the
 * same for every CLI; JSON lines go to the CLI's own mapper. Plain-text and
 * stderr lines are not interpreted: for the CLIs mapped so far the structured
 * stream carries everything, and stderr only repeats it.
 */
export function toAgentEvents(event: RunnerEvent, mapRaw: RawMapper | undefined): AgentEvent[] {
  switch (event.type) {
    case 'raw':
      return mapRaw ? mapRaw(event.data) : [];
    case 'text':
    case 'stderr':
      return [];
    case 'error':
      return [{ kind: 'error', message: event.message }];
    case 'done':
      if (event.timedOut) return [{ kind: 'error', message: 'timed out' }];
      if (event.exitCode !== 0) return [{ kind: 'error', message: `exited with code ${event.exitCode}` }];
      return [];
  }
}

/* Small readers for untyped JSON. */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
