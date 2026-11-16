import { agentFromInput } from '../../../src/core/agents.ts';
import { checkRoles } from '../../../src/core/roles.ts';
import type { AgentDefinition, AgentInput, AgentProblem, AgentsView, Hook, ProviderChoice } from '../shared/api.ts';
import { driftText } from './providers-model.ts';

/*
 * Form logic and labels for the "Агенты" screen, kept apart from React so
 * they can be tested with node:test. The agent itself is made by the core
 * (agentFromInput), so what the form compares and shows is what gets saved.
 */

export interface RoleForm {
  runner: string;
  /** Blank: the CLI's own default model. */
  model: string;
}

export interface AgentForm {
  name: string;
  description: string;
  /** In the order they were picked, as the wizard keeps them. */
  skills: string[];
  hooks: string[];
  implementer: RoleForm;
  reviewer: RoleForm;
}

/** What the form is showing. */
export type AgentMode = { kind: 'none' } | { kind: 'edit'; name: string } | { kind: 'new' };

/**
 * The form while the person makes a skill or hook for it on another screen,
 * and what was made there, to add on the way back.
 */
export interface AgentDraft {
  mode: AgentMode;
  form: AgentForm;
  /** The agent file's version when the form opened. */
  version?: string;
  created?: { kind: 'skill' | 'hook'; name: string };
}

/** A new agent starts on the first installed provider for both roles, models to be picked. */
export function blankForm(providers: readonly ProviderChoice[] = []): AgentForm {
  const runner = (providers.find((p) => p.found && p.verified) ?? providers.find((p) => p.found) ?? providers[0])?.id ?? 'claude';
  return { name: '', description: '', skills: [], hooks: [], implementer: { runner, model: '' }, reviewer: { runner, model: '' } };
}

export const formOf = (agent: AgentDefinition): AgentForm => ({
  name: agent.name,
  description: agent.description,
  skills: [...agent.skills],
  hooks: [...agent.hooks],
  implementer: { runner: agent.roles.implementer.runner, model: agent.roles.implementer.model ?? '' },
  reviewer: { runner: agent.roles.reviewer.runner, model: agent.roles.reviewer.model ?? '' },
});

export const inputOf = (form: AgentForm): AgentInput => form;

/** The form differs from the saved agent (or, for a new one, from the blank form it started as). */
export function isDirty(form: AgentForm, saved: AgentDefinition | undefined, blank: AgentForm): boolean {
  return JSON.stringify(agentFromInput(form)) !== JSON.stringify(agentFromInput(saved ? formOf(saved) : blank));
}

/** Adds or removes a name, keeping the order things were picked in. */
export const toggle = (list: readonly string[], name: string, on: boolean): string[] => (on ? (list.includes(name) ? [...list] : [...list, name]) : list.filter((n) => n !== name));

export const STAGE_ORDER: readonly Hook['stage'][] = ['setup', 'checks', 'finish'];

export const STAGE_TITLE: Record<Hook['stage'], string> = {
  setup: 'setup: один раз в новом worktree, до агентов',
  checks: 'checks: после каждой реализации',
  finish: 'finish: перед коммитом',
};

/** The project's hooks by stage, in the order the run meets them. */
export function hooksByStage(hooks: readonly Hook[]): { stage: Hook['stage']; hooks: Hook[] }[] {
  return STAGE_ORDER.map((stage) => ({ stage, hooks: hooks.filter((h) => h.stage === stage) })).filter((g) => g.hooks.length > 0);
}

/** Characters the picked skills add to every prompt of a run. */
export function skillsTotal(picked: readonly string[], skills: AgentsView['skills']): number {
  return picked.reduce((sum, name) => sum + (skills.find((s) => s.name === name)?.size ?? 0), 0);
}

const name = (providers: readonly ProviderChoice[], id: string): string => providers.find((p) => p.id === id)?.name ?? id;

/** "Claude Code (sonnet)" or "Claude Code (модель по умолчанию)". */
export const roleLabel = (providers: readonly ProviderChoice[], role: RoleForm): string =>
  `${name(providers, role.runner)} (${role.model.trim() || 'модель по умолчанию'})`;

const list = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} и ${items.at(-1)}`);

const WHEN: Record<Hook['stage'], string> = {
  setup: 'до работы агентов в worktree',
  checks: 'после каждой реализации',
  finish: 'перед коммитом',
};

/** One sentence: who writes, who reviews, which checks run and when. */
export function summary(form: AgentForm, providers: readonly ProviderChoice[], hooks: readonly Hook[]): string {
  const picked = form.hooks.map((n) => hooks.find((h) => h.name === n)).filter((h): h is Hook => h !== undefined);
  const parts = STAGE_ORDER.flatMap((stage) => {
    const names = picked.filter((h) => h.stage === stage).map((h) => h.name);
    return names.length > 0 ? [`${WHEN[stage]} — ${list(names)}`] : [];
  });
  const checks = parts.length > 0 ? `проверки: ${parts.join('; ')}` : 'проверок кодом нет, только ревью';
  return `Пишет ${roleLabel(providers, form.implementer)}, проверяет ${roleLabel(providers, form.reviewer)}; ${checks}.`;
}

/** Marks for a provider in a role: not installed, the engine's refusal for an unverified implementer, another version. */
export function providerMarks(provider: ProviderChoice | undefined, role: 'implementer' | 'reviewer'): { kind: 'missing' | 'unverified' | 'drift'; text: string }[] {
  if (!provider) return [];
  const marks: { kind: 'missing' | 'unverified' | 'drift'; text: string }[] = [];
  if (!provider.found) marks.push({ kind: 'missing', text: `${provider.name} не установлен на этой машине: прогон не начнётся. Путь к CLI задаётся на экране «Провайдеры».` });
  if (!provider.verified && role === 'implementer') marks.push({ kind: 'unverified', text: provider.unverifiedMessage });
  if (!provider.verified && role === 'reviewer') marks.push({ kind: 'unverified', text: 'Адаптер не подтверждён: ревьюером можно, движок предупредит об этом в журнале.' });
  const drift = provider.found ? driftText(provider.drift) : undefined;
  if (drift) marks.push({ kind: 'drift', text: drift });
  return marks;
}

/** The writer-is-not-the-reviewer rule, checked as the roles are picked. */
export const roleProblems = (form: AgentForm): AgentProblem[] =>
  checkRoles({ implementer: agentFromInput(form).roles.implementer, reviewer: agentFromInput(form).roles.reviewer }).map((p) => ({ field: 'reviewer', ...p }));

/** The same problems the core reports, in the window's language. */
export function problemText(problem: AgentProblem): string {
  switch (problem.code) {
    case 'name-invalid':
      return 'Только строчные латинские буквы, цифры и дефисы, например test или test-writer. Вызывается как /имя.';
    case 'name-taken':
      return 'Агент с таким именем уже есть.';
    case 'description-empty':
      return 'Опишите, что делает агент: это его инструкции.';
    case 'skill-unknown':
      return `Скилла «${problem.item ?? ''}» нет в проекте.`;
    case 'hook-unknown':
      return `Хука «${problem.item ?? ''}» нет в проекте.`;
    case 'runner-unknown':
      return 'Выберите провайдера из списка.';
    case 'same-cli-no-model':
      return 'Исполнитель и ревьюер на одном CLI: укажите обоим модель явно, чтобы было видно, что это разные модели.';
    case 'same-cli-and-model':
      return 'Ревьюер не может совпадать с исполнителем: тот, кто пишет код, не принимает его сам. Смените CLI или модель.';
  }
}
