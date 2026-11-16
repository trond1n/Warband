import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { normalizeName } from './agents.ts';
import type { AgentDefinition, Skill } from './agents.ts';
import { checkHook, HOOK_STAGES } from './hooks.ts';
import type { Hook, HookProblem, HookStage } from './hooks.ts';
import { DEFAULT_PROTECTED, DEFAULT_TESTS } from './protected.ts';
import type { ProtectedRules } from './protected.ts';
import { KNOWN_RUNNER_IDS as RUNNER_IDS } from './runner.ts';

/*
 * Per-project configuration, kept as plain files a person can read, edit and
 * commit:
 *
 *   .warband/agents/<name>.json   agent definitions
 *   .warband/skills/<name>.md     skills: front matter (name, description) + rules
 *   .warband/hooks.json           { "hooks": [ { name, description, run, stage, env?, reduce? } ] }
 *   .warband/protected.json       { "paths": [...], "tests": [...], "defaults": true }
 *
 * Nothing secret belongs here.
 */
export const warbandDir = (root: string): string => join(root, '.warband');
const agentsDir = (root: string): string => join(warbandDir(root), 'agents');
const skillsDir = (root: string): string => join(warbandDir(root), 'skills');
const hooksFile = (root: string): string => join(warbandDir(root), 'hooks.json');

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function parseRole(value: unknown, where: string): AgentDefinition['roles']['implementer'] {
  if (!isObject(value) || typeof value['runner'] !== 'string' || !(RUNNER_IDS as readonly string[]).includes(value['runner'])) {
    throw new Error(`${where}: runner must be one of ${RUNNER_IDS.join(', ')}`);
  }
  const model = value['model'];
  if (model !== undefined && typeof model !== 'string') throw new Error(`${where}: model must be a string`);
  return { runner: value['runner'] as (typeof RUNNER_IDS)[number], ...(model ? { model } : {}) };
}

export function parseAgent(value: unknown, where: string): AgentDefinition {
  if (!isObject(value)) throw new Error(`${where}: expected an object`);
  const { name, description, skills, hooks, roles } = value;
  if (typeof name !== 'string' || typeof description !== 'string') {
    throw new Error(`${where}: name and description must be strings`);
  }
  if (!isStringArray(skills) || !isStringArray(hooks)) throw new Error(`${where}: skills and hooks must be lists of names`);
  if (!isObject(roles)) throw new Error(`${where}: roles missing`);
  return {
    name,
    description,
    skills,
    hooks,
    roles: {
      implementer: parseRole(roles['implementer'], `${where} roles.implementer`),
      reviewer: parseRole(roles['reviewer'], `${where} roles.reviewer`),
    },
  };
}

export async function listAgents(root: string): Promise<AgentDefinition[]> {
  let files: string[];
  try {
    files = await readdir(agentsDir(root));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const agents: AgentDefinition[] = [];
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    const path = join(agentsDir(root), file);
    agents.push(parseAgent(await readJson(path), path));
  }
  return agents;
}

export async function loadAgent(root: string, name: string): Promise<AgentDefinition | undefined> {
  const path = join(agentsDir(root), `${normalizeName(name)}.json`);
  try {
    return parseAgent(await readJson(path), path);
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

export async function saveAgent(root: string, agent: AgentDefinition): Promise<string> {
  await mkdir(agentsDir(root), { recursive: true });
  const path = join(agentsDir(root), `${agent.name}.json`);
  await writeFile(path, `${JSON.stringify(agent, null, 2)}\n`);
  return path;
}

export async function loadHooks(root: string): Promise<Hook[]> {
  return (await readHooks(root)).hooks;
}

export interface HooksSnapshot {
  hooks: Hook[];
  /** Hash of hooks.json, 'none' when there is none; pass it back to `saveHook` and `deleteHook`. */
  version: string;
}

/** hooks.json with a version, so a save can tell that the file changed under it. */
export async function readHooks(root: string): Promise<HooksSnapshot> {
  let text: string;
  try {
    text = await readFile(hooksFile(root), 'utf8');
  } catch (err) {
    if (isMissing(err)) return { hooks: [], version: 'none' };
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${hooksFile(root)} is not valid JSON: ${(err as Error).message}`);
  }
  return { hooks: parseHooks(data, root), version: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

function parseHooks(data: unknown, root: string): Hook[] {
  const list = isObject(data) ? data['hooks'] : undefined;
  if (!Array.isArray(list)) throw new Error(`${hooksFile(root)}: expected { "hooks": [...] }`);
  return list.map((item, i) => {
    const where = `${hooksFile(root)} hooks[${i}]`;
    if (!isObject(item)) throw new Error(`${where}: expected an object`);
    const { name, description, run, stage, env, reduce } = item;
    if (typeof name !== 'string' || typeof run !== 'string') throw new Error(`${where}: name and run must be strings`);
    if (typeof stage !== 'string' || !(HOOK_STAGES as readonly string[]).includes(stage)) {
      throw new Error(`${where}: stage must be one of ${HOOK_STAGES.join(', ')}`);
    }
    if (env !== undefined && (!isObject(env) || !Object.values(env).every((v) => typeof v === 'string'))) {
      throw new Error(`${where}: env must map names to strings`);
    }
    return {
      name,
      description: typeof description === 'string' ? description : '',
      run,
      stage: stage as Hook['stage'],
      ...(env ? { env: env as Record<string, string> } : {}),
      ...(reduce === true ? { reduce: true } : {}),
    };
  });
}

const protectedFile = (root: string): string => join(warbandDir(root), 'protected.json');

/** Protected paths for the project: the defaults plus .warband/protected.json. */
export async function loadProtected(root: string): Promise<ProtectedRules> {
  let data: unknown;
  try {
    data = await readJson(protectedFile(root));
  } catch (err) {
    if (isMissing(err)) return { paths: DEFAULT_PROTECTED, tests: DEFAULT_TESTS };
    throw err;
  }
  const where = protectedFile(root);
  if (!isObject(data)) throw new Error(`${where}: expected { "paths": [...], "tests": [...] }`);
  const list = (key: string): string[] => {
    const value = data[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) {
      throw new Error(`${where}: "${key}" must be a list of glob patterns`);
    }
    return value;
  };
  const defaults = data['defaults'] !== false;
  return {
    paths: [...(defaults ? DEFAULT_PROTECTED : []), ...list('paths')],
    tests: [...(defaults ? DEFAULT_TESTS : []), ...list('tests')],
  };
}

const hooksText = (hooks: readonly Hook[]): string => `${JSON.stringify({ hooks }, null, 2)}\n`;

export async function saveHooks(root: string, hooks: readonly Hook[]): Promise<void> {
  await mkdir(warbandDir(root), { recursive: true });
  await writeFile(hooksFile(root), hooksText(hooks));
}

/** What a person fills in for a hook: environment variables as rows, which may repeat or be blank. */
export interface HookInput {
  name: string;
  description: string;
  run: string;
  stage: string;
  env: readonly (readonly [string, string])[];
  reduce: boolean;
}

/**
 * The hook as `saveHooks` writes it, the same shape and key order as a hook
 * made by `warband agent new`: no `env` when there are no variables, and
 * `reduce` only when it is on. Rows with neither a name nor a value are
 * dropped; a repeated name is a problem rather than a silent overwrite.
 */
export function hookFromInput(input: HookInput, workspace: string): { hook: Hook; problems: HookProblem[] } {
  const rows = input.env.map(([k, v]) => [k.trim(), v] as const).filter(([k, v]) => k !== '' || v.trim() !== '');
  const env: Record<string, string> = {};
  const problems: HookProblem[] = [];
  for (const [key, value] of rows) {
    if (Object.hasOwn(env, key)) {
      if (!problems.some((p) => p.key === key)) {
        problems.push({ field: 'env', code: 'env-name-duplicate', key, message: `environment variable "${key}" is listed twice` });
      }
      continue;
    }
    env[key] = value;
  }
  const hook: Hook = {
    name: normalizeName(input.name),
    description: input.description.trim(),
    run: input.run.trim(),
    stage: input.stage as HookStage,
    ...(rows.length > 0 ? { env } : {}),
    ...(input.reduce ? { reduce: true } : {}),
  };
  return { hook, problems: [...checkHook(hook, workspace), ...problems] };
}

/** hooks.json changed on disk after the caller read it. */
export class HooksChangedError extends Error {
  readonly code = 'changed';
  constructor() {
    super('hooks.json changed on disk since it was read');
  }
}

/** Thrown with the problems when the hook is not valid; nothing is written. */
export class HookInvalidError extends Error {
  readonly code = 'invalid';
  readonly problems: HookProblem[];
  constructor(problems: HookProblem[]) {
    super(problems.map((p) => p.message).join('; '));
    this.problems = problems;
  }
}

/** The hook is used by agents, so it is not deleted. */
export class HookInUseError extends Error {
  readonly code = 'in-use';
  readonly agents: string[];
  constructor(name: string, agents: string[]) {
    super(`hook "${name}" is used by ${agents.map((a) => `/${a}`).join(', ')}`);
    this.agents = agents;
  }
}

/** Names of the agents whose hook list has `name`. */
export async function hookUsers(root: string, name: string): Promise<string[]> {
  return (await listAgents(root)).filter((a) => a.hooks.includes(name)).map((a) => a.name);
}

/** A file to write, or to remove when `text` is null. */
export interface FileChange {
  path: string;
  text: string | null;
}

/**
 * Writes several files as one change: either all of them end up with their
 * new content or all keep what they had. Every new text is written next to
 * its file first; the swaps come after, and if one fails, the files already
 * swapped get their old content back. Not proof against a power cut in the
 * middle, but no error leaves agents pointing at a name that is gone.
 */
export async function commitFiles(changes: readonly FileChange[]): Promise<void> {
  const before = await Promise.all(
    changes.map(async (c) => {
      try {
        return await readFile(c.path, 'utf8');
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    }),
  );
  const temp = (path: string): string => `${path}.warband-${process.pid}.tmp`;
  const staged: string[] = [];
  try {
    for (const c of changes) {
      if (c.text === null) continue;
      await mkdir(dirname(c.path), { recursive: true });
      await writeFile(temp(c.path), c.text, { flag: 'wx' });
      staged.push(temp(c.path));
    }
  } catch (err) {
    await Promise.all(staged.map((p) => rm(p, { force: true })));
    throw err;
  }
  const done: number[] = [];
  try {
    for (const [i, c] of changes.entries()) {
      if (c.text === null) await rm(c.path);
      else await rename(temp(c.path), c.path);
      done.push(i);
    }
  } catch (err) {
    for (const i of done.reverse()) {
      const c = changes[i] as FileChange;
      const old = before[i];
      if (old === null || old === undefined) await rm(c.path, { force: true });
      else await writeFile(c.path, old);
    }
    await Promise.all(changes.map((c) => (c.text === null ? undefined : rm(temp(c.path), { force: true }))));
    throw err;
  }
}

/**
 * The agent files that list `from` under `kind`, rewritten to list `to`
 * instead. The rest of each file stays as it was: the JSON is edited, not
 * re-made from the parsed definition.
 */
async function renamedReferences(root: string, kind: 'hooks' | 'skills', from: string, to: string): Promise<{ agents: string[]; changes: FileChange[] }> {
  let files: string[];
  try {
    files = await readdir(agentsDir(root));
  } catch (err) {
    if (isMissing(err)) return { agents: [], changes: [] };
    throw err;
  }
  const agents: string[] = [];
  const changes: FileChange[] = [];
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    const path = join(agentsDir(root), file);
    const data = await readJson(path);
    const agent = parseAgent(data, path);
    if (!agent[kind].includes(from)) continue;
    const raw = data as Record<string, unknown>;
    raw[kind] = (raw[kind] as string[]).map((n) => (n === from ? to : n));
    agents.push(agent.name);
    changes.push({ path, text: `${JSON.stringify(raw, null, 2)}\n` });
  }
  return { agents, changes };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

export interface SaveHookOptions {
  /** The name the hook had when the form opened; absent for a new hook. */
  original?: string;
  /** From `readHooks`; a file that changed since is not written over. */
  expectedVersion?: string;
  /**
   * The agents the person agreed to update when the hook is renamed. A
   * rename of a used hook goes ahead only when this is exactly the list of
   * agents that use it now.
   */
  renameAgents?: readonly string[];
}

/**
 * Creates or updates one hook in hooks.json, keeping the others and their
 * order. A new name must be free. Renaming a hook that agents use updates
 * their hook lists in the same change, once the caller passes the list of
 * those agents as confirmed; otherwise the problem names them.
 */
export async function saveHook(root: string, input: HookInput, options: SaveHookOptions = {}): Promise<HooksSnapshot & { hook: Hook }> {
  const { hook, problems } = hookFromInput(input, root);
  const { hooks, version } = await readHooks(root);
  const { original } = options;
  if (options.expectedVersion !== undefined && version !== options.expectedVersion) throw new HooksChangedError();
  // The hook being edited was removed or renamed elsewhere.
  if (original !== undefined && !hooks.some((h) => h.name === original)) throw new HooksChangedError();
  if (hook.name !== original && hooks.some((h) => h.name === hook.name)) {
    problems.unshift({ field: 'name', code: 'name-taken', message: `hook "${hook.name}" already exists` });
  }
  let references: FileChange[] = [];
  if (original !== undefined && hook.name !== original && problems.length === 0) {
    const { agents, changes } = await renamedReferences(root, 'hooks', original, hook.name);
    if (agents.length > 0 && !sameSet(agents, options.renameAgents ?? [])) {
      problems.unshift({
        field: 'name',
        code: 'rename-in-use',
        agents,
        message: `hook "${original}" is used by ${agents.map((a) => `/${a}`).join(', ')}; confirm renaming it there too`,
      });
    }
    references = changes;
  }
  if (problems.length > 0) throw new HookInvalidError(problems);
  const next = original === undefined ? [...hooks, hook] : hooks.map((h) => (h.name === original ? hook : h));
  await mkdir(warbandDir(root), { recursive: true });
  await commitFiles([{ path: hooksFile(root), text: hooksText(next) }, ...references]);
  return { ...(await readHooks(root)), hook };
}

/** Removes one hook. Refused while an agent uses it, or when the file changed since `expectedVersion`. */
export async function deleteHook(root: string, name: string, expectedVersion?: string): Promise<HooksSnapshot> {
  const { hooks, version } = await readHooks(root);
  if (expectedVersion !== undefined && version !== expectedVersion) throw new HooksChangedError();
  if (!hooks.some((h) => h.name === name)) throw new HooksChangedError();
  const agents = await hookUsers(root, name);
  if (agents.length > 0) throw new HookInUseError(name, agents);
  await saveHooks(root, hooks.filter((h) => h.name !== name));
  return readHooks(root);
}

/** Reads `name` and `description` from simple `key: value` front matter. */
export function parseFrontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields: Record<string, string> = {};
  if (!match?.[1]) return fields;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (pair?.[1]) fields[pair[1]] = (pair[2] ?? '').trim();
  }
  return fields;
}

export async function listSkills(root: string): Promise<Skill[]> {
  let files: string[];
  try {
    files = await readdir(skillsDir(root));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const skills: Skill[] = [];
  for (const file of files.filter((f) => f.endsWith('.md')).sort()) {
    const path = join(skillsDir(root), file);
    const fields = parseFrontMatter(await readFile(path, 'utf8'));
    skills.push({ name: fields['name'] ?? file.slice(0, -3), description: fields['description'] ?? '', path });
  }
  return skills;
}

/** Creates a skill file with a placeholder body for the person to fill in. */
export async function createSkill(root: string, name: string, description: string): Promise<Skill> {
  await mkdir(skillsDir(root), { recursive: true });
  const path = join(skillsDir(root), `${name}.md`);
  const body = `---\nname: ${name}\ndescription: ${description.replace(/\r?\n/g, ' ')}\n---\n\n<!-- Write the rules this skill stands for. The whole file is given to the agent. -->\n`;
  await writeFile(path, body, { flag: 'wx' });
  return { name, description, path };
}
