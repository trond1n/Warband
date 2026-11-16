import { NAME_PATTERN } from './names.ts';

/*
 * The text of a skill file, .warband/skills/<name>.md:
 *
 *   ---
 *   name: <name>
 *   description: <one line>
 *   ---
 *
 *   <the rules, in Markdown>
 *
 * This is what `createSkill` writes and `parseFrontMatter` reads. The whole
 * file goes into the prompt of every run of an agent that lists the skill.
 * Pure functions only, so the window can use them too.
 */

export interface SkillParts {
  name?: string;
  description?: string;
  /** Other front matter lines, kept as they are. */
  extra: string[];
  body: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits a skill file into its front matter fields and the body after the blank line. */
export function splitSkill(text: string): SkillParts {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { extra: [], body: text };
  const parts: SkillParts = { extra: [], body: text.slice(match[0].length).replace(/^\r?\n/, '') };
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^(name|description):\s*(.*)$/.exec(line);
    if (pair?.[1] === 'name' && parts.name === undefined) parts.name = (pair[2] ?? '').trim();
    else if (pair?.[1] === 'description' && parts.description === undefined) parts.description = (pair[2] ?? '').trim();
    else parts.extra.push(line);
  }
  return parts;
}

/** The file text for a skill; `splitSkill` gives the same parts back. */
export function composeSkill(name: string, description: string, body: string, extra: readonly string[] = []): string {
  const head = `---\nname: ${name}\ndescription: ${description}\n${extra.map((line) => `${line}\n`).join('')}---\n`;
  if (body.trim() === '') return head;
  return `${head}\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

/** Characters of the skill that go into a prompt (the engine trims the file). */
export const promptSize = (text: string): number => [...text.trim()].length;

export type SkillProblemCode = 'name-invalid' | 'name-taken' | 'rename-in-use' | 'description-empty' | 'description-multiline';

/** One reason a skill cannot be saved; `message` is in English, the window shows its own text by `code`. */
export interface SkillProblem {
  field: 'name' | 'description';
  code: SkillProblemCode;
  message: string;
  /** rename-in-use: agents that list the skill under its old name. */
  agents?: string[];
}

/** Name and description as the front matter can hold them: a valid name, one line of description. */
export function checkSkill(name: string, description: string): SkillProblem[] {
  const problems: SkillProblem[] = [];
  if (!NAME_PATTERN.test(name)) problems.push({ field: 'name', code: 'name-invalid', message: `skill name "${name}" must be lowercase letters, digits and dashes` });
  if (/[\r\n]/.test(description)) {
    problems.push({ field: 'description', code: 'description-multiline', message: `skill "${name}": the description is one line` });
  } else if (description.trim() === '') {
    problems.push({ field: 'description', code: 'description-empty', message: `skill "${name}" has no description` });
  }
  return problems;
}
