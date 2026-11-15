import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * Review plans in the format reslop reads and writes
 * (https://github.com/tshemsedinov/reslop): `.plan/YYYY-MM-DD-NN.md`, with
 * front matter `status: editing | partial | done` and one Markdown checkbox
 * per finding, its fields as sub-items. The same file goes to the
 * implementer on rework and can be opened, edited or extended in reslop.
 */

export const PLAN_DIR = '.plan';
export const PLAN_NAME = /^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/;
export type PlanStatus = 'editing' | 'partial' | 'done';

export interface Finding {
  severity?: 'high' | 'medium' | 'low';
  /** path, path:line or path#symbol */
  where?: string;
  problem: string;
  expected?: string;
  /** Acceptance criteria, each a checkbox. */
  check?: readonly string[];
}

export interface PlanFile {
  /** Name inside .plan/, such as 2026-11-15-01.md */
  name: string;
  status: PlanStatus | undefined;
  /** Unchecked findings, counted by their top-level checkboxes. */
  open: number;
  text: string;
}

const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').trim();

/** A finding as one line, for a list of comments. */
export const findingLine = (f: Finding): string =>
  `${f.severity ? `${f.severity}: ` : ''}${f.where ? `${f.where}: ` : ''}${oneLine(f.problem)}`;

export function renderPlan(title: string, findings: readonly Finding[], context?: string): string {
  const lines = ['---', 'status: editing', '---', '', `# ${oneLine(title)}`, ''];
  if (context && context.trim() !== '') lines.push(context.trim(), '');
  lines.push('## Improvements', '');
  for (const f of findings) {
    const headline = oneLine(f.problem).split(/(?<=[.!?])\s/)[0] ?? oneLine(f.problem);
    lines.push(`- [ ] ${f.severity ? `${f.severity}: ` : ''}${headline}`);
    if (f.where) lines.push(`  - where: \`${oneLine(f.where)}\``);
    lines.push(`  - problem: ${oneLine(f.problem)}`);
    if (f.expected) lines.push(`  - expected: ${oneLine(f.expected)}`);
    const checks = (f.check ?? []).filter((c) => c.trim() !== '');
    if (checks.length > 0) {
      lines.push('  - check:');
      for (const c of checks) lines.push(`    - [ ] ${oneLine(c)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function parsePlan(name: string, text: string): PlanFile {
  const status = /^---\r?\n(?:.*\r?\n)*?status:\s*(\w+)/.exec(text)?.[1];
  const known = status === 'editing' || status === 'partial' || status === 'done' ? status : undefined;
  const open = text.split(/\r?\n/).filter((line) => /^- \[ \]/.test(line)).length;
  return { name, status: known, open, text };
}

export async function readPlans(worktree: string): Promise<PlanFile[]> {
  const dir = join(worktree, PLAN_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (n) => parsePlan(n, await readFile(join(dir, n), 'utf8'))));
}

/** Plans still to work through: not done, with at least one open item. */
export const pendingPlans = (plans: readonly PlanFile[]): PlanFile[] =>
  plans.filter((p) => p.status !== 'done' && p.open > 0);

export async function writePlan(worktree: string, text: string, now: Date): Promise<string> {
  const dir = join(worktree, PLAN_DIR);
  await mkdir(dir, { recursive: true });
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const taken = (await readdir(dir).catch(() => [] as string[]))
    .map((n) => PLAN_NAME.exec(n))
    .filter((m) => m !== null && m[1] === day)
    .map((m) => Number(m?.[2]));
  const name = `${day}-${p(Math.max(0, ...taken) + 1)}.md`;
  await writeFile(join(dir, name), text, { flag: 'wx' });
  return name;
}

/** The instruction that goes with pending plans to the implementer. */
export function planFeedback(plans: readonly PlanFile[]): string {
  return (
    `Work through the unchecked items in ${plans.map((p) => `\`${PLAN_DIR}/${p.name}\``).join(', ')}. ` +
    'Read the fields under an item before working on it; `check` items are its acceptance criteria. ' +
    'Tick each `check` item when it holds and mark the item `[x]` when it is done. Add `- result:` under each ' +
    'finished item: what changed, in a few lines. Edit only those lines and the front matter `status` ' +
    '(`partial` if items remain, `done` if all are `[x]`). Do not rewrite the rest of the file.\n\n' +
    plans.map((p) => `### ${PLAN_DIR}/${p.name}\n\n${p.text.trim()}`).join('\n\n')
  );
}
