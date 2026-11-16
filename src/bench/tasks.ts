import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Hook } from '../core/hooks.ts';
import { NAME_PATTERN } from '../core/names.ts';
import { parseToml } from './toml.ts';
import type { TomlTable, TomlValue } from './toml.ts';

/*
 * A bench task is a folder: prompt.md (the task), setup/ (the repository it
 * starts from), task.toml (timeout, tags, checks, expected outcome) and
 * verify.mjs (exit 0 = passed), see bench/README.md.
 */

export type RunStatus = 'done' | 'halted';

/** The expected outcome. verify alone decides pass; the rest is compared and shown. */
export interface Expectation {
  verify: 'pass' | 'fail';
  status?: RunStatus;
  /** The reviewer's first verdict. */
  review?: 'approve' | 'changes_requested';
  reviewFindingsMax?: number;
  reworksMin?: number;
  /** Paths that, if the run changed them, must be in protected_changes. */
  flagged?: string[];
}

export interface Variant {
  /** Empty for a task without variants. */
  name: string;
  /** Add the task's skill to the agent's skills. */
  skill: boolean;
  expect: Expectation;
}

export interface BenchTask {
  id: string;
  dir: string;
  prompt: string;
  timeoutSeconds: number;
  tags: string[];
  source?: string;
  license?: string;
  maxReworks?: number;
  /** Hooks of the checks stage, used instead of the agent's own. */
  hooks: Hook[];
  /** Added to the protected paths of the bench repository. */
  protectedPaths: string[];
  /** Roles played by stand-ins instead of the agent's CLIs. */
  scripted: { planner: boolean; implementer?: string[] };
  skill?: { name: string; file: string };
  variants: Variant[];
}

const STATUSES: readonly string[] = ['done', 'halted'];
const VERDICTS: readonly string[] = ['approve', 'changes_requested'];

class Fields {
  readonly table: TomlTable;
  readonly where: string;
  readonly #seen = new Set<string>();
  constructor(table: TomlTable, where: string) {
    this.table = table;
    this.where = where;
  }
  #get(key: string): TomlValue | undefined {
    this.#seen.add(key);
    return this.table[key];
  }
  fail(message: string): never {
    throw new Error(`${this.where}: ${message}`);
  }
  string(key: string): string | undefined {
    const v = this.#get(key);
    if (v !== undefined && typeof v !== 'string') this.fail(`${key} must be a string`);
    return v;
  }
  oneOf<T extends string>(key: string, allowed: readonly string[]): T | undefined {
    const v = this.string(key);
    if (v !== undefined && !allowed.includes(v)) this.fail(`${key} must be one of ${allowed.join(', ')}`);
    return v as T | undefined;
  }
  count(key: string): number | undefined {
    const v = this.#get(key);
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) this.fail(`${key} must be a whole number, 0 or more`);
    return v;
  }
  bool(key: string): boolean | undefined {
    const v = this.#get(key);
    if (v !== undefined && typeof v !== 'boolean') this.fail(`${key} must be true or false`);
    return v;
  }
  strings(key: string): string[] | undefined {
    const v = this.#get(key);
    if (v !== undefined && (!Array.isArray(v) || !v.every((s) => typeof s === 'string'))) this.fail(`${key} must be a list of strings`);
    return v as string[] | undefined;
  }
  table_(key: string): TomlTable | undefined {
    const v = this.#get(key);
    if (v !== undefined && (typeof v !== 'object' || Array.isArray(v))) this.fail(`[${key}] must be a table`);
    return v as TomlTable | undefined;
  }
  /** Typos are errors: a misspelt key would silently change what a task measures. */
  done(): void {
    const unknown = Object.keys(this.table).filter((k) => !this.#seen.has(k));
    if (unknown.length > 0) this.fail(`unknown key(s): ${unknown.join(', ')}`);
  }
}

function expectation(table: TomlTable | undefined, where: string, base?: Expectation): Expectation {
  const f = new Fields(table ?? {}, where);
  const verify = f.oneOf<'pass' | 'fail'>('verify', ['pass', 'fail']);
  const status = f.oneOf<RunStatus>('status', STATUSES);
  const review = f.oneOf<'approve' | 'changes_requested'>('review', VERDICTS);
  const reviewFindingsMax = f.count('review_findings_max');
  const reworksMin = f.count('reworks_min');
  const flagged = f.strings('flagged');
  f.done();
  return {
    ...base,
    verify: verify ?? base?.verify ?? 'pass',
    ...(status ? { status } : {}),
    ...(review ? { review } : {}),
    ...(reviewFindingsMax !== undefined ? { reviewFindingsMax } : {}),
    ...(reworksMin !== undefined ? { reworksMin } : {}),
    ...(flagged ? { flagged } : {}),
  };
}

export async function loadTask(dir: string, id: string): Promise<BenchTask> {
  const where = `bench task ${id}`;
  for (const part of ['prompt.md', 'task.toml', 'verify.mjs', 'setup']) {
    if (!existsSync(join(dir, part))) throw new Error(`${where}: ${part} is missing`);
  }
  let doc: TomlTable;
  try {
    doc = parseToml(await readFile(join(dir, 'task.toml'), 'utf8'));
  } catch (err) {
    throw new Error(`${where}: task.toml: ${(err as Error).message}`);
  }
  const top = new Fields(doc, `${where}, task.toml`);
  const t = new Fields(top.table_('task') ?? top.fail('[task] is missing'), `${where}, [task]`);
  const timeoutSeconds = t.count('timeout_seconds') ?? 600;
  const tags = t.strings('tags') ?? [];
  const source = t.string('source');
  const license = t.string('license');
  const maxReworks = t.count('max_reworks');
  t.done();

  const checks = top.table_('checks') ?? {};
  const hooks: Hook[] = Object.entries(checks).map(([name, run]) => {
    if (!NAME_PATTERN.test(name)) top.fail(`[checks] ${name} is not a valid hook name`);
    if (typeof run !== 'string' || run.trim() === '') return top.fail(`[checks] ${name} must be a command`);
    return { name, description: `bench check of ${id}`, run, stage: 'checks' };
  });

  const p = new Fields(top.table_('protected') ?? {}, `${where}, [protected]`);
  const protectedPaths = p.strings('paths') ?? [];
  p.done();

  const s = new Fields(top.table_('scripted') ?? {}, `${where}, [scripted]`);
  const planner = s.bool('planner') ?? false;
  const implementer = s.strings('implementer');
  s.done();
  for (const overlay of implementer ?? []) {
    if (!existsSync(join(dir, overlay))) throw new Error(`${where}: scripted implementer folder ${overlay} is missing`);
  }

  const k = top.table_('skill');
  let skill: BenchTask['skill'];
  if (k) {
    const f = new Fields(k, `${where}, [skill]`);
    const name = f.string('name') ?? f.fail('name is missing');
    const file = f.string('file') ?? f.fail('file is missing');
    f.done();
    if (!NAME_PATTERN.test(name)) f.fail(`${name} is not a valid skill name`);
    if (!existsSync(join(dir, file))) f.fail(`${file} is missing`);
    skill = { name, file };
  }

  const base = expectation(top.table_('expect'), `${where}, [expect]`);
  const variantTables = top.table_('variants');
  top.done();
  const variants: Variant[] = variantTables
    ? Object.entries(variantTables).map(([name, value]) => {
        if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: [variants.${name}] must be a table`);
        const v = new Fields(value, `${where}, [variants.${name}]`);
        const withSkill = v.bool('skill') ?? false;
        const expect = expectation(v.table_('expect'), `${where}, [variants.${name}.expect]`, base);
        v.done();
        if (withSkill && !skill) v.fail('skill = true needs a [skill] table');
        return { name, skill: withSkill, expect };
      })
    : [{ name: '', skill: skill !== undefined, expect: base }];

  return {
    id,
    dir,
    prompt: (await readFile(join(dir, 'prompt.md'), 'utf8')).trim(),
    timeoutSeconds,
    tags,
    ...(source ? { source } : {}),
    ...(license ? { license } : {}),
    ...(maxReworks !== undefined ? { maxReworks } : {}),
    hooks,
    protectedPaths,
    scripted: { planner, ...(implementer ? { implementer } : {}) },
    ...(skill ? { skill } : {}),
    variants,
  };
}

/** Every task in `tasksDir`, or the ones named, in the order given (folder order otherwise). */
export async function loadTasks(tasksDir: string, only?: readonly string[]): Promise<BenchTask[]> {
  const all = (await readdir(tasksDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && existsSync(join(tasksDir, e.name, 'task.toml')))
    .map((e) => e.name)
    .sort();
  const ids = only ?? all;
  const unknown = ids.filter((id) => !all.includes(id));
  if (unknown.length > 0) throw new Error(`no such bench task: ${unknown.join(', ')} (there are: ${all.join(', ')})`);
  return Promise.all(ids.map((id) => loadTask(join(tasksDir, id), id)));
}

/** The key of one task variant in reports: "skill-rule:with-skill", or the id. */
export const runKey = (task: BenchTask, variant: Variant): string => (variant.name ? `${task.id}:${variant.name}` : task.id);
