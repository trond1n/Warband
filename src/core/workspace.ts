import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeName } from './agents.ts';
import type { AgentDefinition, Skill } from './agents.ts';
import { HOOK_STAGES } from './hooks.ts';
import type { Hook } from './hooks.ts';
import { KNOWN_RUNNER_IDS as RUNNER_IDS } from './runner.ts';

/*
 * Per-project configuration, kept as plain files a person can read, edit and
 * commit:
 *
 *   .warband/agents/<name>.json   agent definitions
 *   .warband/skills/<name>.md     skills: front matter (name, description) + rules
 *   .warband/hooks.json           { "hooks": [ { name, description, run, stage } ] }
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
  let data: unknown;
  try {
    data = await readJson(hooksFile(root));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
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

export async function saveHooks(root: string, hooks: readonly Hook[]): Promise<void> {
  await mkdir(warbandDir(root), { recursive: true });
  await writeFile(hooksFile(root), `${JSON.stringify({ hooks }, null, 2)}\n`);
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
