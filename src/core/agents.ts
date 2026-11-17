import type { Hook } from './hooks.ts';
import { NAME_PATTERN } from './names.ts';
import { checkRoles } from './roles.ts';
import type { Role, RoleAssignment, RoleProblemCode } from './roles.ts';
import { KNOWN_RUNNER_IDS } from './runner-ids.ts';

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
    planner?: RoleAssignment;
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

export type AgentProblemCode =
  | 'name-invalid'
  | 'name-taken'
  | 'description-empty'
  | 'skill-unknown'
  | 'hook-unknown'
  | 'runner-unknown'
  | RoleProblemCode;

/**
 * One reason an agent cannot be saved or run, with the field it belongs to.
 * `message` is the English text the wizard and the engine print; the window
 * shows its own text by `code`.
 */
export interface AgentProblem {
  field: 'name' | 'description' | 'skills' | 'hooks' | Role;
  code: AgentProblemCode;
  message: string;
  /** skill-unknown, hook-unknown: the name that is not in the project. */
  item?: string;
}

/** Pure, so the window shows the same problems while the form is filled in. */
export function checkAgent(agent: AgentDefinition, known: KnownParts): AgentProblem[] {
  const problems: AgentProblem[] = [];
  const badName = validateName(agent.name);
  if (badName) problems.push({ field: 'name', code: 'name-invalid', message: `agent name "${agent.name}": ${badName}` });
  if (agent.description.trim() === '') problems.push({ field: 'description', code: 'description-empty', message: 'agent has no description of what it does' });
  for (const skill of agent.skills) {
    if (!known.skills.some((s) => s.name === skill)) problems.push({ field: 'skills', code: 'skill-unknown', item: skill, message: `unknown skill "${skill}"` });
  }
  for (const hook of agent.hooks) {
    if (!known.hooks.some((h) => h.name === hook)) problems.push({ field: 'hooks', code: 'hook-unknown', item: hook, message: `unknown hook "${hook}"` });
  }
  for (const role of ['planner', 'implementer', 'reviewer'] as const) {
    const runner = agent.roles[role]?.runner;
    if (runner === undefined && role === 'planner') continue;
    if (runner === undefined || !(KNOWN_RUNNER_IDS as readonly string[]).includes(runner)) {
      problems.push({ field: role, code: 'runner-unknown', message: `${role}: runner must be one of ${KNOWN_RUNNER_IDS.join(', ')}` });
    }
  }
  problems.push(...checkRoles(agent.roles).map((p): AgentProblem => ({ field: 'reviewer', ...p })));
  return problems;
}

export function validateAgent(agent: AgentDefinition, known: KnownParts): string[] {
  return checkAgent(agent, known).map((p) => p.message);
}

/** What a person fills in for an agent; models may be blank for "the CLI's default". */
export interface AgentInput {
  name: string;
  description: string;
  skills: readonly string[];
  hooks: readonly string[];
  planner?: { runner: string; model: string };
  implementer: { runner: string; model: string };
  reviewer: { runner: string; model: string };
}

/**
 * The description as the wizard stores it: each line without trailing
 * spaces, no blank lines before or after.
 */
export function normalizeDescription(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

const role = (r: { runner: string; model: string }): RoleAssignment => {
  const model = r.model.trim();
  return { runner: r.runner as RoleAssignment['runner'], ...(model ? { model } : {}) };
};

/**
 * The agent as `saveAgent` writes it, the same object, key order included,
 * that `warband agent new` makes from the same answers.
 */
export function agentFromInput(input: AgentInput): AgentDefinition {
  return {
    name: normalizeName(input.name),
    description: normalizeDescription(input.description),
    skills: [...new Set(input.skills)],
    hooks: [...new Set(input.hooks)],
    roles: {
      ...(input.planner ? { planner: role(input.planner) } : {}),
      implementer: role(input.implementer),
      reviewer: role(input.reviewer),
    },
  };
}
