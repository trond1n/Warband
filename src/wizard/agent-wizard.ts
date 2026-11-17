import { normalizeName, validateAgent, validateName } from '../core/agents.ts';
import type { AgentDefinition, Skill } from '../core/agents.ts';
import { HOOK_STAGES, NAME_PATTERN, validateHook } from '../core/hooks.ts';
import type { Hook, HookStage } from '../core/hooks.ts';
import type { RoleAssignment } from '../core/roles.ts';
import { validateRoles } from '../core/roles.ts';
import type { RunnerId } from '../core/runner.ts';

/** Terminal I/O, injected so the wizard can be tested with scripted answers. */
export interface Prompter {
  ask(question: string): Promise<string>;
  say(text: string): void;
}

export interface WizardEnv {
  /** Project root, used for policy checks on hook commands. */
  root: string;
  /** CLIs that are installed, in the order they should be offered. */
  runners: readonly { id: RunnerId; displayName: string }[];
  /** Model ids the CLI itself reports. Empty when it cannot tell. */
  models(runner: RunnerId): Promise<string[]>;
  existingAgents: readonly string[];
  skills: readonly Skill[];
  hooks: readonly Hook[];
  /** reslop is installed, so a checks hook can be offered its short report. */
  reslop?: boolean;
}

/** What the wizard decided. Nothing is written until the caller saves it. */
export interface WizardResult {
  agent: AgentDefinition;
  newSkills: { name: string; description: string }[];
  newHooks: Hook[];
}

async function askRequired(io: Prompter, question: string, check?: (answer: string) => string | undefined): Promise<string> {
  while (true) {
    const answer = (await io.ask(question)).trim();
    if (answer === '') {
      io.say('  An answer is required.');
      continue;
    }
    const problem = check?.(answer);
    if (!problem) return answer;
    io.say(`  ${problem}`);
  }
}

/** Reads lines until an empty one. */
async function askMultiline(io: Prompter, question: string): Promise<string> {
  io.say(question);
  while (true) {
    const lines: string[] = [];
    while (true) {
      const line = await io.ask('> ');
      if (line.trim() === '') break;
      lines.push(line.trimEnd());
    }
    if (lines.length > 0) return lines.join('\n');
    io.say('  Describe what the agent does, then press Enter on an empty line.');
  }
}

async function chooseOne<T>(io: Prompter, question: string, options: readonly { label: string; value: T }[]): Promise<T> {
  io.say(question);
  options.forEach((option, i) => io.say(`  ${i + 1}) ${option.label}`));
  while (true) {
    const answer = (await io.ask('Number: ')).trim();
    const index = Number(answer) - 1;
    const option = Number.isInteger(index) ? options[index] : undefined;
    if (option) return option.value;
    io.say(`  Enter a number from 1 to ${options.length}.`);
  }
}

async function confirm(io: Prompter, question: string, byDefault: boolean): Promise<boolean> {
  while (true) {
    const answer = (await io.ask(`${question} ${byDefault ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (answer === '') return byDefault;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    io.say('  Answer y or n.');
  }
}

/**
 * Lets the person pick any number of existing items by number, or add new
 * ones with "n". Returns the chosen names.
 */
async function chooseMany(
  io: Prompter,
  what: string,
  available: () => readonly { name: string; description: string }[],
  addNew: () => Promise<string>,
): Promise<string[]> {
  const chosen: string[] = [];
  while (true) {
    const items = available();
    io.say(`\n${what}${chosen.length ? ` (chosen: ${chosen.join(', ')})` : ''}:`);
    if (items.length === 0) io.say('  none yet');
    items.forEach((item, i) => io.say(`  ${i + 1}) ${item.name}${item.description ? ` - ${item.description}` : ''}`));
    const answer = (await io.ask('Numbers separated by commas, n for new, Enter when done: ')).trim().toLowerCase();
    if (answer === '') return chosen;
    if (answer === 'n') {
      const name = await addNew();
      if (!chosen.includes(name)) chosen.push(name);
      continue;
    }
    const picks = answer.split(/[\s,]+/).filter(Boolean).map((part) => items[Number(part) - 1]);
    if (picks.some((pick) => pick === undefined)) {
      io.say(`  Use numbers from 1 to ${items.length}, or n.`);
      continue;
    }
    for (const pick of picks) if (pick && !chosen.includes(pick.name)) chosen.push(pick.name);
  }
}

const OTHER = Symbol('other');
const CLI_DEFAULT = Symbol('default');

async function askRole(io: Prompter, env: WizardEnv, title: string): Promise<RoleAssignment> {
  const runner = await chooseOne(
    io,
    `\n${title}: which CLI?`,
    env.runners.map((r) => ({ label: r.displayName, value: r.id })),
  );
  const models = await env.models(runner);
  const choice = await chooseOne<string | typeof OTHER | typeof CLI_DEFAULT>(io, `${title}: which model?`, [
    ...models.map((model) => ({ label: model, value: model })),
    { label: 'other (type the id)', value: OTHER },
    { label: "the CLI's default", value: CLI_DEFAULT },
  ]);
  if (choice === CLI_DEFAULT) return { runner };
  if (choice === OTHER) return { runner, model: await askRequired(io, 'Model id: ') };
  return { runner, model: choice };
}

export async function agentWizard(io: Prompter, env: WizardEnv): Promise<WizardResult | null> {
  if (env.runners.length === 0) {
    io.say('No agent CLI is installed. Run `warband doctor` to see what Warband looks for.');
    return null;
  }

  io.say('New agent. It will be saved to .warband/agents/<name>.json.\n');

  let name = '';
  while (true) {
    name = normalizeName(await askRequired(io, 'Name (used as a command, e.g. /test): ', (answer) => validateName(normalizeName(answer))));
    if (!env.existingAgents.includes(name)) break;
    if (await confirm(io, `Agent "${name}" already exists. Replace it?`, false)) break;
  }

  const description = await askMultiline(
    io,
    '\nWhat does the agent do? This becomes its instructions. Finish with an empty line.',
  );

  const newSkills: WizardResult['newSkills'] = [];
  const skills = await chooseMany(
    io,
    'Skills the agent follows (rules such as a coding canon)',
    () => [...env.skills, ...newSkills],
    async () => {
      const taken = (n: string): boolean => env.skills.some((s) => s.name === n) || newSkills.some((s) => s.name === n);
      const skillName = normalizeName(
        await askRequired(io, 'Skill name: ', (a) => validateName(normalizeName(a)) ?? (taken(normalizeName(a)) ? 'that name is taken' : undefined)),
      );
      const skillDescription = await askRequired(io, 'What is it about, in one line: ');
      newSkills.push({ name: skillName, description: skillDescription });
      io.say(`  Will create .warband/skills/${skillName}.md. Write its rules there after saving.`);
      return skillName;
    },
  );

  const newHooks: Hook[] = [];
  const hooks = await chooseMany(
    io,
    'Hooks: checks run by code, not by a model (linter, tests, pre-commit)',
    () => [...env.hooks, ...newHooks].map((h) => ({ name: h.name, description: `${h.run} [${h.stage}]` })),
    async () => {
      const taken = (n: string): boolean => env.hooks.some((h) => h.name === n) || newHooks.some((h) => h.name === n);
      const hookName = normalizeName(
        await askRequired(io, 'Hook name: ', (a) =>
          NAME_PATTERN.test(normalizeName(a)) ? (taken(normalizeName(a)) ? 'that name is taken' : undefined) : validateName(normalizeName(a)),
        ),
      );
      while (true) {
        const run = await askRequired(io, 'Command (e.g. npm test): ');
        const stage = await chooseOne<HookStage>(io, 'When does it run?', [
          { label: 'checks: after the code is written; a failure sends it back for rework', value: 'checks' },
          { label: 'finish: right before the commit (pre-commit)', value: 'finish' },
          { label: 'setup: once in the new worktree, before any agent (e.g. install dependencies)', value: 'setup' },
        ]);
        const reduce =
          stage === 'checks' && env.reslop === true
            ? await confirm(io, 'Pass its output through reslop, so a failure comes back as a short report?', true)
            : false;
        const hook: Hook = { name: hookName, description: '', run, stage, ...(reduce ? { reduce } : {}) };
        const problems = validateHook(hook, env.root);
        if (problems.length === 0) {
          newHooks.push(hook);
          return hookName;
        }
        for (const problem of problems) io.say(`  ${problem}`);
      }
    },
  );

  io.say('\nThe implementer writes the work, the reviewer checks it.');
  io.say('They must differ by CLI or by model, e.g. a cheaper model writes and a stronger one reviews.');
  let implementer = await askRole(io, env, 'Implementer');
  let reviewer = await askRole(io, env, 'Reviewer');
  while (true) {
    const problems = validateRoles({ implementer, reviewer });
    if (problems.length === 0) break;
    for (const problem of problems) io.say(`  ${problem}`);
    io.say('  Choose both roles again.');
    implementer = await askRole(io, env, 'Implementer');
    reviewer = await askRole(io, env, 'Reviewer');
  }

  const planner = await confirm(io, 'Choose a separate planner for clarification and planning?', false)
    ? await askRole(io, env, 'Planner')
    : undefined;
  const agent: AgentDefinition = {
    name, description, skills, hooks,
    roles: { ...(planner ? { planner } : {}), implementer, reviewer },
  };
  const problems = validateAgent(agent, {
    skills: [...env.skills, ...newSkills],
    hooks: [...env.hooks, ...newHooks],
  });
  if (problems.length > 0) {
    for (const problem of problems) io.say(`  ${problem}`);
    return null;
  }

  const role = (r: RoleAssignment): string => `${r.runner}${r.model ? ` / ${r.model}` : ' / default model'}`;
  io.say(`\n/${agent.name}`);
  io.say(`  does:        ${description.split('\n')[0]}${description.includes('\n') ? ' ...' : ''}`);
  io.say(`  skills:      ${skills.join(', ') || 'none'}`);
  io.say(`  hooks:       ${hooks.join(', ') || 'none'}`);
  io.say(`  implementer: ${role(implementer)}`);
  io.say(`  reviewer:    ${role(reviewer)}`);
  io.say(`  planner:     ${planner ? role(planner) : 'reviewer'}`);

  if (!(await confirm(io, '\nSave?', true))) return null;
  return { agent, newSkills, newHooks };
}
