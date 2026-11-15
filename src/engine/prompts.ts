/*
 * Prompts for each agent stage. Everything an agent needs is in the prompt:
 * Warband does not rely on a CLI's own memory or configuration.
 */

import { describeProtected } from '../core/protected.ts';
import type { ProtectedChange } from '../core/protected.ts';

export interface PromptContext {
  /** What the agent does, from its definition. */
  instructions: string;
  /** Skill documents, in full. */
  skills: readonly { name: string; text: string }[];
  task: string;
  /** Human answers to the planner's questions. */
  clarifications?: string;
  plan?: string;
  /** Names and commands of the checks run after implementation. */
  checks: readonly string[];
}

const section = (title: string, body: string | undefined): string =>
  body && body.trim() !== '' ? `## ${title}\n\n${body.trim()}\n\n` : '';

const skillsText = (ctx: PromptContext): string =>
  ctx.skills.length === 0
    ? ''
    : section(
        'Rules you must follow',
        ctx.skills.map((s) => `### ${s.name}\n\n${s.text.trim()}`).join('\n\n'),
      );

const common = (ctx: PromptContext): string =>
  section('Your role', ctx.instructions) +
  skillsText(ctx) +
  section('Task', ctx.task) +
  section('Answers to questions about the task', ctx.clarifications);

export const CLARIFY_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['clear', 'questions'] },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'questions'],
  additionalProperties: false,
} as const;

export function clarifyPrompt(ctx: PromptContext): string {
  return (
    'You are about to plan a coding task in the repository in the current directory. ' +
    'Look at the code as much as you need, but do not change anything.\n\n' +
    common(ctx) +
    'Decide whether the task is clear enough to plan. If something essential is ambiguous, ' +
    'return status "questions" with at most 5 short questions for the person who set the task. ' +
    'Otherwise return status "clear" and an empty list. Do not ask about things you can find out from the code.'
  );
}

export function planPrompt(ctx: PromptContext, previous?: { plan: string; feedback: string }): string {
  return (
    'You are planning a coding task in the repository in the current directory. ' +
    'Look at the code as much as you need, but do not change anything.\n\n' +
    common(ctx) +
    section('Your previous plan', previous?.plan) +
    section('What the person wants changed in it', previous?.feedback) +
    'Write a concise implementation plan in Markdown: which files to create or change, the steps, ' +
    'and how the result will be verified. A person will approve it, and then another agent will implement it ' +
    'without being able to ask you anything, so be specific. Reply with the plan only.'
  );
}

export function implementPrompt(ctx: PromptContext, rework?: { attempt: number; feedback: string }): string {
  const checks =
    ctx.checks.length > 0
      ? `When you finish, these checks will be run for you: ${ctx.checks.join('; ')}.`
      : 'No automatic checks are configured.';
  return (
    'You are implementing a coding task in the repository in the current directory.\n\n' +
    common(ctx) +
    section('Approved plan', ctx.plan) +
    (rework
      ? section(`This is attempt ${rework.attempt + 1}. Fix the following before anything else`, rework.feedback)
      : '') +
    'You can read, create and edit files in the current directory. You cannot run shell commands: ' +
    `they will be denied. ${checks} ` +
    'Do not commit. When you are done, reply with a short summary of what you changed.'
  );
}

/** Findings use the fields of a reslop plan item, so they can be written to .plan/ as they are. */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          where: { type: 'string', description: 'path, path:line or path#symbol' },
          problem: { type: 'string', description: 'what is wrong now' },
          expected: { type: 'string', description: 'how it behaves when fixed' },
          check: { type: 'array', items: { type: 'string' }, description: 'acceptance criteria' },
        },
        required: ['severity', 'where', 'problem', 'expected', 'check'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'findings'],
  additionalProperties: false,
} as const;

/** Above this the diff is cut, so the review prompt stays a reasonable size. */
export const MAX_DIFF_CHARS = 200_000;

export function reviewPrompt(
  ctx: PromptContext,
  change: { diff: string; summary: string; protectedChanges?: readonly ProtectedChange[] },
): string {
  const diff =
    change.diff.length > MAX_DIFF_CHARS
      ? `${change.diff.slice(0, MAX_DIFF_CHARS)}\n... diff cut at ${MAX_DIFF_CHARS} characters; read the files for the rest`
      : change.diff;
  return (
    'You are reviewing a change another agent made in the repository in the current directory. ' +
    'You can read any file for context, but do not change anything.\n\n' +
    common(ctx) +
    section('Approved plan', ctx.plan) +
    section("The implementer's summary", change.summary) +
    section(
      'Changes to protected files',
      change.protectedChanges && change.protectedChanges.length > 0
        ? 'Warband found these without a model. They change what the checks check (configs, scripts, CI, tests). ' +
            'Decide whether each one is needed for the task; a change that weakens a check is a reason to request changes.\n\n' +
            change.protectedChanges.map((c) => `- ${describeProtected(c)}`).join('\n')
        : undefined,
    ) +
    section('Checks that passed', ctx.checks.join('\n')) +
    section('The change', `\`\`\`diff\n${diff}\n\`\`\``) +
    'Do not try to run the tests or other commands: they will be denied, and the checks above have already run. ' +
    'Approve only if the change does the task, follows the plan and the rules, and has no bugs you can see. ' +
    'Otherwise request changes. Each finding needs: where (path:line), the problem, the expected behaviour, and checks ' +
    'that show it is fixed, specific enough for the implementer to act on without asking. With an approval, ' +
    'findings may list minor notes that do not block it.'
  );
}
