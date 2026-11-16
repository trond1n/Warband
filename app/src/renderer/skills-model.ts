import { composeSkill, promptSize } from '../../../src/core/skills.ts';
import type { SkillInfo, SkillInput, SkillProblem } from '../shared/api.ts';
import { normalName } from './hooks-model.ts';

/*
 * Form logic and labels for the "Скиллы" screen, kept apart from React so
 * they can be tested with node:test. The file format comes from the core
 * (src/core/skills.ts), so the size shown is the size of what gets saved.
 */

export interface SkillForm {
  name: string;
  description: string;
  /** Markdown after the front matter. */
  body: string;
}

export const blankForm = (): SkillForm => ({ name: '', description: '', body: '' });

export const formOf = (skill: SkillInfo): SkillForm => ({ name: skill.name, description: skill.description, body: skill.body });

export const inputOf = (form: SkillForm): SkillInput => ({ name: form.name, description: form.description, body: form.body });

/** The file the form would save, as the core writes it. */
export const textOf = (form: SkillForm, extra: readonly string[] = []): string => composeSkill(normalName(form.name), form.description.trim(), form.body, extra);

/** The form differs from the saved skill (or, for a new one, from an empty form). */
export function isDirty(form: SkillForm, saved: SkillInfo | undefined): boolean {
  return textOf(form) !== textOf(saved ? formOf(saved) : blankForm());
}

/** Characters of the form's file that go into a prompt. */
export const sizeOf = (form: SkillForm, extra: readonly string[] = []): number => promptSize(textOf(form, extra));

/** "1 символ", "3 символа", "12 345 символов". */
export function charsText(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? 'символов' : ones === 1 ? 'символ' : ones >= 2 && ones <= 4 ? 'символа' : 'символов';
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${word}`;
}

const agentList = (agents: readonly string[]): string => agents.map((a) => `/${a}`).join(', ');

/** What the size means for the agents that use the skill. */
export function promptNote(usedBy: readonly string[] | undefined): string {
  if (usedBy === undefined) return 'Не удалось прочитать агентов, поэтому не видно, в чьи промпты уходит скилл.';
  if (usedBy.length === 0) return 'Пока ни один агент его не использует, в промпты он не попадает.';
  return `Скилл целиком уходит в промпт каждого прогона ${usedBy.length === 1 ? 'агента' : 'агентов'} ${agentList(usedBy)}.`;
}

/** The same problems the core reports, in the window's language. */
export function problemText(problem: SkillProblem, original?: string): string {
  switch (problem.code) {
    case 'name-invalid':
      return 'Только строчные латинские буквы, цифры и дефисы, например code-canon.';
    case 'name-taken':
      return 'Скилл с таким именем уже есть.';
    case 'rename-in-use':
      return `Скилл${original ? ` «${original}»` : ''} используют агенты ${agentList(problem.agents ?? [])}. Переименование обновит ссылки в них; сохраните ещё раз и подтвердите список.`;
    case 'description-empty':
      return 'Опишите в одну строку, о чём скилл.';
    case 'description-multiline':
      return 'Описание пишется в одну строку.';
  }
}
