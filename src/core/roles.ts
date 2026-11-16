import type { RunnerId } from './runner-ids.ts';

export type Role = 'planner' | 'implementer' | 'reviewer';

export interface RoleAssignment {
  runner: RunnerId;
  /** Model id as the CLI itself accepts it. Warband does not interpret it. */
  model?: string;
}

export type Roles = Record<Role, RoleAssignment>;

export type RoleProblemCode = 'same-cli-no-model' | 'same-cli-and-model';

/** A broken role rule, with a code for the window and the wizard's text. */
export interface RoleProblem {
  code: RoleProblemCode;
  message: string;
}

/**
 * The one rule Warband insists on: whoever writes the code does not get to
 * accept it. The reviewer must differ from the implementer by CLI or by model.
 */
export function checkRoles(roles: Pick<Roles, 'implementer' | 'reviewer'>): RoleProblem[] {
  const { implementer, reviewer } = roles;
  if (implementer.runner !== reviewer.runner) return [];
  if (!implementer.model || !reviewer.model) {
    return [{ code: 'same-cli-no-model', message: 'implementer and reviewer use the same CLI, so both need an explicit model to prove they differ' }];
  }
  if (implementer.model === reviewer.model) return [{ code: 'same-cli-and-model', message: 'reviewer must not be the same CLI and model as the implementer' }];
  return [];
}

export function validateRoles(roles: Pick<Roles, 'implementer' | 'reviewer'>): string[] {
  return checkRoles(roles).map((p) => p.message);
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
