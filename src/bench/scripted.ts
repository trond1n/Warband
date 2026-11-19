import { cp } from 'node:fs/promises';

import type { AgentEvent } from '../core/events.ts';
import type { Runner, RunRequest } from '../core/runner.ts';

/*
 * Stand-ins that play a role without a model: the bench uses them to
 * measure one role on a fixed input (the reviewer on a prepared change),
 * and its tests use them for every role. They speak the engine's common
 * events, so the engine treats them like any CLI.
 */

const result = (text: string, structured?: unknown): AgentEvent => ({
  kind: 'result',
  ok: true,
  text,
  deniedTools: [],
  ...(structured === undefined ? {} : { structured }),
});

function standIn(name: string, play: (req: RunRequest, call: number) => Promise<AgentEvent[]>): Runner {
  let calls = 0;
  return {
    id: 'claude',
    displayName: `scripted ${name}`,
    binary: 'scripted',
    capabilities: { transport: 'stream', structuredOutput: true, sandbox: 'agent', headlessApprovals: 'deny', verified: true },
    mapRaw: (data) => [data as unknown as AgentEvent],
    async detect() {
      return { found: true, version: 'scripted' };
    },
    async *run(req) {
      for (const event of await play(req, calls++)) yield { type: 'raw', data: event as unknown as Record<string, unknown> };
      yield { type: 'done', exitCode: 0, timedOut: false };
    },
  };
}

/** No questions, and a one-line plan. Clarify asks for JSON, plan does not. */
export const scriptedPlanner = (plan = '1. Apply the prepared change.'): Runner =>
  standIn('planner', async (req) => (req.jsonSchema ? [result('', { status: 'clear', questions: [] })] : [result(plan)]));

/**
 * Copies a folder over the worktree on each attempt: the first folder on the
 * first attempt, the second on the first rework, and the last one from then on.
 */
export const scriptedImplementer = (overlays: readonly string[]): Runner =>
  standIn('implementer', async (req, call) => {
    const overlay = overlays[Math.min(call, overlays.length - 1)];
    if (overlay) await cp(overlay, req.cwd, { recursive: true, force: true });
    return [{ kind: 'tool_call', name: 'Write', input: { overlay: call } }, result(`Applied the prepared change (attempt ${call + 1}).`)];
  });

export interface ScriptedReview {
  verdict: 'approve' | 'changes_requested';
  findings?: { problem: string; where?: string; severity?: 'high' | 'medium' | 'low' }[];
}

/** Gives the verdicts in turn, the last one from then on. */
export const scriptedReviewer = (verdicts: readonly ScriptedReview[]): Runner =>
  standIn('reviewer', async (_req, call) => {
    const v = verdicts[Math.min(call, verdicts.length - 1)] ?? { verdict: 'approve' };
    return [result('', { verdict: v.verdict, findings: v.findings ?? [] })];
  });
