import type { RunnerId } from './runner.ts';

export type Role = 'planner' | 'implementer' | 'reviewer';

export interface RoleAssignment {
  runner: RunnerId;
  /** Model id as the CLI itself accepts it. Warband does not interpret it. */
  model?: string;
}

export type Roles = Record<Role, RoleAssignment>;

/**
 * The one rule Warband insists on: whoever writes the code does not get to
 * accept it. The reviewer must differ from the implementer by CLI or by model.
 */
export function validateRoles(roles: Pick<Roles, 'implementer' | 'reviewer'>): string[] {
  const problems: string[] = [];
  const { implementer, reviewer } = roles;

  if (implementer.runner === reviewer.runner) {
    if (!implementer.model || !reviewer.model) {
      problems.push(
        'implementer and reviewer use the same CLI, so both need an explicit model to prove they differ',
      );
    } else if (implementer.model === reviewer.model) {
      problems.push('reviewer must not be the same CLI and model as the implementer');
    }
  }
  return problems;
}

/** Starting points for the agent pairs the team actually uses. */
export const PRESETS = {
  'claude+antigravity': {
    planner: { runner: 'claude' },
    implementer: { runner: 'antigravity' },
    reviewer: { runner: 'claude' },
  },
  'claude+codex': {
    planner: { runner: 'claude' },
    implementer: { runner: 'codex' },
    reviewer: { runner: 'claude' },
  },
  'codex+kimi': {
    planner: { runner: 'codex' },
    implementer: { runner: 'kimi' },
    reviewer: { runner: 'codex' },
  },
} as const satisfies Record<string, Roles>;

export type PresetName = keyof typeof PRESETS;
