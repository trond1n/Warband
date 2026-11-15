import { NAME_PATTERN } from './hooks.ts';
import type { Hook } from './hooks.ts';
import { validateRoles } from './roles.ts';
import type { RoleAssignment } from './roles.ts';

/**
 * A reusable agent, e.g. `/test`: what it does, the skills it follows, the
 * deterministic hooks that check its work, and which CLI and model write
 * and review. Writer and reviewer must differ, as for any Warband task.
 */
export interface AgentDefinition {
  name: string;
  /** What the agent does. Becomes its instructions. */
  description: string;
  /** Skill names, see `Skill`. */
  skills: string[];
  /** Hook names, see `Hook`. */
  hooks: string[];
  roles: {
    implementer: RoleAssignment;
    reviewer: RoleAssignment;
  };
}

/**
 * A skill is a Markdown document of rules the agent must follow, such as a
 * team's coding canon. Warband puts it into the agent's prompt, so it works
 * the same for every CLI.
 */
export interface Skill {
  name: string;
  description: string;
  /** File the skill lives in. */
  path: string;
}

/** Accepts what a person types, e.g. "/Test", and returns the stored name. */
export function normalizeName(input: string): string {
  return input.trim().replace(/^\/+/, '').toLowerCase();
}

export function validateName(name: string): string | undefined {
  return NAME_PATTERN.test(name) ? undefined : 'use lowercase letters, digits and dashes, e.g. test or test-writer';
}

export interface KnownParts {
  skills: readonly Pick<Skill, 'name'>[];
  hooks: readonly Pick<Hook, 'name'>[];
}

export function validateAgent(agent: AgentDefinition, known: KnownParts): string[] {
  const problems: string[] = [];
  const badName = validateName(agent.name);
  if (badName) problems.push(`agent name "${agent.name}": ${badName}`);
  if (agent.description.trim() === '') problems.push('agent has no description of what it does');
  for (const skill of agent.skills) {
    if (!known.skills.some((s) => s.name === skill)) problems.push(`unknown skill "${skill}"`);
  }
  for (const hook of agent.hooks) {
    if (!known.hooks.some((h) => h.name === hook)) problems.push(`unknown hook "${hook}"`);
  }
  problems.push(...validateRoles(agent.roles));
  return problems;
}
