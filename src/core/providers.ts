import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join } from 'node:path';

import { KNOWN_RUNNER_IDS } from './runner.ts';
import type { LocalCheck, RunnerId } from './runner.ts';

/*
 * Per-machine settings for each agent CLI ("provider"), kept outside any
 * project because they describe this computer, not the code:
 *
 *   <config dir>/providers.json   { "providers": { "claude": { "binary": "...", "models": [...], "check": {...} } } }
 *
 * The config dir is the one the desktop window uses for its own settings
 * (Electron's userData for the app name "Warband"), so `warband doctor`,
 * `warband run` and the window read the same file. WARBAND_CONFIG_DIR
 * overrides it, for tests.
 *
 * Nothing secret belongs here: no keys, no logins, no proxies with passwords.
 */

export interface ProviderSettings {
  /** Absolute path of the CLI binary, for a CLI that is not on PATH. */
  binary?: string;
  /** Model ids the person keeps for this CLI, offered when an agent is set up. */
  models: string[];
  /**
   * The last full probe run on this machine. Written by the probes (window or
   * `npm run spike`), never by the settings form; a save keeps it.
   */
  check?: LocalCheck;
}

export type Providers = Partial<Record<RunnerId, ProviderSettings>>;

export const APP_NAME = 'Warband';

/** Folder of the machine settings, the same as the window's userData folder. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env['WARBAND_CONFIG_DIR'];
  if (override) return override;
  const home = env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  if (platform === 'win32') return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_NAME);
  return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), APP_NAME);
}

export const providersFile = (dir: string): string => join(dir, 'providers.json');

/** A model id goes to the CLI as one argv item after --model, so it may not look like a flag. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

export type ProviderProblemCode =
  | 'binary-relative'
  | 'binary-missing'
  | 'binary-not-file'
  | 'binary-script'
  | 'model-invalid'
  | 'model-duplicate';

export interface ProviderProblem {
  field: 'binary' | 'models';
  code: ProviderProblemCode;
  message: string;
  /** The model id the problem is about. */
  model?: string;
}

/** Trims what a person typed: an empty path means "use PATH", empty lines are dropped. */
export function normalizeProvider(input: { binary?: string | undefined; models?: readonly string[] | undefined }): ProviderSettings {
  const binary = input.binary?.trim();
  const models = (input.models ?? []).map((m) => m.trim()).filter((m) => m !== '');
  return { ...(binary ? { binary } : {}), models };
}

export async function validateProvider(settings: ProviderSettings, platform: NodeJS.Platform = process.platform): Promise<ProviderProblem[]> {
  const problems: ProviderProblem[] = [];
  const { binary } = settings;
  if (binary !== undefined) {
    if (!isAbsolute(binary)) {
      problems.push({ field: 'binary', code: 'binary-relative', message: 'give the full path to the program, or leave it empty to use PATH' });
    } else if (platform === 'win32' && ['.cmd', '.bat', '.ps1'].includes(extname(binary).toLowerCase())) {
      // Agent CLIs are launched without a shell, and Windows runs scripts only through one.
      problems.push({ field: 'binary', code: 'binary-script', message: 'a script cannot be launched without a shell; point to the .exe' });
    } else {
      const info = await stat(binary).catch(() => undefined);
      if (!info) problems.push({ field: 'binary', code: 'binary-missing', message: `no file at ${binary}` });
      else if (!info.isFile()) problems.push({ field: 'binary', code: 'binary-not-file', message: `${binary} is a folder, not a program` });
    }
  }
  const seen = new Set<string>();
  for (const model of settings.models) {
    if (!MODEL_PATTERN.test(model)) {
      problems.push({ field: 'models', code: 'model-invalid', model, message: `model id "${model}" may use letters, digits and . _ : / @ [ ] -, and must not start with a dash` });
    } else if (seen.has(model)) {
      problems.push({ field: 'models', code: 'model-duplicate', model, message: `model id "${model}" is listed twice` });
    }
    seen.add(model);
  }
  return problems;
}

/**
 * Hash of what a person edits (path and models), so a save can tell that the
 * settings changed under it. A probe run recording its result does not count:
 * it must not make an open form stale.
 */
function versionOf(providers: Providers | undefined): string {
  const editable = KNOWN_RUNNER_IDS.flatMap((id) => {
    const item = providers?.[id];
    return item && (item.binary !== undefined || item.models.length > 0) ? [[id, item.binary ?? null, item.models]] : [];
  });
  if (editable.length === 0) return 'none';
  return createHash('sha256').update(JSON.stringify(editable)).digest('hex').slice(0, 16);
}

function parseCheck(value: unknown, where: string): LocalCheck {
  if (
    !isObject(value) ||
    typeof value['version'] !== 'string' ||
    typeof value['at'] !== 'string' ||
    !(Array.isArray(value['differs']) && value['differs'].every((d) => typeof d === 'string'))
  ) {
    throw new Error(`${where} must be { "version": "...", "at": "...", "differs": [...] }`);
  }
  return { version: value['version'], at: value['at'], differs: [...(value['differs'] as string[])] };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseProviders(text: string, where: string): Providers {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where} is not valid JSON: ${(err as Error).message}`);
  }
  const list = isObject(data) ? data['providers'] : undefined;
  if (!isObject(list)) throw new Error(`${where}: expected { "providers": { ... } }`);
  const providers: Providers = {};
  for (const id of KNOWN_RUNNER_IDS) {
    const item = list[id];
    if (item === undefined) continue;
    if (!isObject(item)) throw new Error(`${where} providers.${id}: expected an object`);
    const { binary, models } = item;
    if (binary !== undefined && typeof binary !== 'string') throw new Error(`${where} providers.${id}.binary must be a string`);
    if (models !== undefined && !(Array.isArray(models) && models.every((m) => typeof m === 'string'))) {
      throw new Error(`${where} providers.${id}.models must be a list of model ids`);
    }
    const check = item['check'] === undefined ? undefined : parseCheck(item['check'], `${where} providers.${id}.check`);
    providers[id] = { ...normalizeProvider({ binary, models }), ...(check ? { check } : {}) };
  }
  return providers;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export interface ProvidersSnapshot {
  providers: Providers;
  /** Changes whenever a path or model list does; pass it back to `saveProvider`. */
  version: string;
}

export async function readProviders(dir: string): Promise<ProvidersSnapshot> {
  const path = providersFile(dir);
  const text = await readText(path);
  const providers = text === undefined ? undefined : parseProviders(text, path);
  return { providers: providers ?? {}, version: versionOf(providers) };
}

export async function loadProviders(dir: string): Promise<Providers> {
  return (await readProviders(dir)).providers;
}

/** The file changed on disk after the caller read it. */
export class ProvidersChangedError extends Error {
  readonly code = 'changed';
  constructor() {
    super('providers.json changed on disk since it was read');
  }
}

/** Thrown with the problems when the settings are not valid; nothing is written. */
export class ProviderInvalidError extends Error {
  readonly code = 'invalid';
  readonly problems: ProviderProblem[];
  constructor(problems: ProviderProblem[]) {
    super(problems.map((p) => p.message).join('; '));
    this.problems = problems;
  }
}

/**
 * Validates and saves one provider's settings, keeping the others. With
 * `expectedVersion`, refuses to write over a file that changed since then.
 */
export async function saveProvider(
  dir: string,
  id: RunnerId,
  input: ProviderSettings,
  expectedVersion?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ProvidersSnapshot> {
  const settings = normalizeProvider(input);
  const problems = await validateProvider(settings, platform);
  if (problems.length > 0) throw new ProviderInvalidError(problems);

  const path = providersFile(dir);
  const text = await readText(path);
  // A broken file is reported as broken, even when it also changed: it has to be fixed by hand.
  const found = text === undefined ? undefined : parseProviders(text, path);
  if (expectedVersion !== undefined && versionOf(found) !== expectedVersion) throw new ProvidersChangedError();
  const providers = found ?? {};
  const check = providers[id]?.check;
  if (settings.binary === undefined && settings.models.length === 0 && !check) delete providers[id];
  else providers[id] = { ...settings, ...(check ? { check } : {}) };
  return writeProviders(path, providers);
}

async function writeProviders(path: string, providers: Providers): Promise<ProvidersSnapshot> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ providers }, null, 2)}\n`);
  return { providers, version: versionOf(providers) };
}

/**
 * Records a full probe run for one CLI, replacing the previous one and
 * keeping its path and models. Not a form save, so there is no version
 * check, and the version (which covers only path and models) stays the same.
 */
export async function recordCheck(dir: string, id: RunnerId, check: LocalCheck): Promise<ProvidersSnapshot> {
  const path = providersFile(dir);
  const text = await readText(path);
  const providers = text === undefined ? {} : parseProviders(text, path);
  providers[id] = { ...(providers[id] ?? { models: [] }), check: parseCheck(check, 'check') };
  return writeProviders(path, providers);
}
