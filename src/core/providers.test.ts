import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  configDir,
  loadProviders,
  normalizeProvider,
  ProviderInvalidError,
  ProvidersChangedError,
  providersFile,
  readProviders,
  recordCheck,
  saveProvider,
  validateProvider,
} from './providers.ts';

const dirs: string[] = [];
const folder = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'warband-providers-'));
  dirs.push(dir);
  return dir;
};
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A file that exists, to stand for a CLI binary. */
async function fakeBinary(dir: string, name = 'claude.exe'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, '');
  return path;
}

test('the config dir is the window settings folder on each OS, or WARBAND_CONFIG_DIR', () => {
  assert.equal(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32'), join('C:\\Users\\a\\AppData\\Roaming', 'Warband'));
  assert.equal(configDir({ HOME: '/home/a' }, 'darwin'), join('/home/a', 'Library', 'Application Support', 'Warband'));
  assert.equal(configDir({ HOME: '/home/a' }, 'linux'), join('/home/a', '.config', 'Warband'));
  assert.equal(configDir({ HOME: '/home/a', XDG_CONFIG_HOME: '/xdg' }, 'linux'), join('/xdg', 'Warband'));
  assert.equal(configDir({ WARBAND_CONFIG_DIR: '/custom', APPDATA: 'x' }, 'win32'), '/custom');
});

test('no settings file means no settings', async () => {
  const dir = await folder();
  assert.deepEqual(await readProviders(dir), { providers: {}, version: 'none' });
});

test('an empty path means PATH, and blank model lines are dropped', () => {
  assert.deepEqual(normalizeProvider({ binary: '  ', models: [' opus ', '', 'sonnet'] }), { models: ['opus', 'sonnet'] });
});

test('settings round-trip, one provider at a time, and survive a new read', async () => {
  const dir = await folder();
  const binary = await fakeBinary(dir);
  const first = await saveProvider(dir, 'claude', { binary, models: ['opus', 'sonnet[1m]'] }, 'none');
  await saveProvider(dir, 'antigravity', { models: ['gemini-3-pro'] }, first.version);

  assert.deepEqual(await loadProviders(dir), {
    claude: { binary, models: ['opus', 'sonnet[1m]'] },
    antigravity: { models: ['gemini-3-pro'] },
  });
  assert.match(await readFile(providersFile(dir), 'utf8'), /^\{\n {2}"providers": \{/);
});

test('clearing every field removes the provider from the file', async () => {
  const dir = await folder();
  const saved = await saveProvider(dir, 'kimi', { models: ['k2'] });
  await saveProvider(dir, 'kimi', { models: [] }, saved.version);
  assert.deepEqual(await loadProviders(dir), {});
});

test('a file changed since it was read is not written over', async () => {
  const dir = await folder();
  const { version } = await saveProvider(dir, 'claude', { models: ['opus'] });
  await writeFile(providersFile(dir), `${JSON.stringify({ providers: { claude: { models: ['by-hand'] } } })}\n`);
  await assert.rejects(saveProvider(dir, 'claude', { models: ['sonnet'] }, version), ProvidersChangedError);
  assert.deepEqual(await loadProviders(dir), { claude: { models: ['by-hand'] } });
});

test('invalid settings are refused with the field and nothing is written', async () => {
  const dir = await folder();
  const err = await saveProvider(dir, 'claude', { binary: 'claude', models: ['--dangerously-skip-permissions'] }).catch((e: unknown) => e);
  assert.ok(err instanceof ProviderInvalidError);
  assert.deepEqual(
    err.problems.map((p) => [p.field, p.code]),
    [
      ['binary', 'binary-relative'],
      ['models', 'model-invalid'],
    ],
  );
  assert.deepEqual(await readProviders(dir), { providers: {}, version: 'none' });
});

test('the binary must be an existing file, and on Windows not a script', async () => {
  const dir = await folder();
  const codes = async (binary: string, platform: NodeJS.Platform = 'linux'): Promise<string[]> =>
    (await validateProvider({ binary, models: [] }, platform)).map((p) => p.code);

  assert.deepEqual(await codes(await fakeBinary(dir)), []);
  assert.deepEqual(await codes(join(dir, 'missing.exe')), ['binary-missing']);
  await mkdir(join(dir, 'folder'));
  assert.deepEqual(await codes(join(dir, 'folder')), ['binary-not-file']);
  assert.deepEqual(await codes(await fakeBinary(dir, 'codex.cmd'), 'win32'), ['binary-script']);
  assert.deepEqual(await codes(await fakeBinary(dir, 'codex.cmd'), 'linux'), []);
});

test('model ids may not repeat or look like flags', async () => {
  const problems = await validateProvider({ models: ['opus', 'opus', '-x', 'a b', 'gpt-5.1-codex', 'org/model:tag@v1'] });
  assert.deepEqual(
    problems.map((p) => [p.code, p.model]),
    [
      ['model-duplicate', 'opus'],
      ['model-invalid', '-x'],
      ['model-invalid', 'a b'],
    ],
  );
});

test('a broken or misshapen file is reported with its path', async () => {
  const dir = await folder();
  await writeFile(providersFile(dir), '{ nope');
  await assert.rejects(loadProviders(dir), /providers\.json is not valid JSON/);
  await writeFile(providersFile(dir), '{"providers": {"claude": {"models": "opus"}}}');
  await assert.rejects(loadProviders(dir), /providers\.claude\.models must be a list/);
  await writeFile(providersFile(dir), '{"providers": {"someday": {"models": []}}}');
  assert.deepEqual(await loadProviders(dir), {}, 'unknown CLIs are ignored');
});

test('a probe run is recorded per CLI, kept by a form save, and does not make an open form stale', async () => {
  const dir = await folder();
  const first = await saveProvider(dir, 'claude', { models: ['opus'] }, 'none');
  const check = { version: '2.1.330', at: '2026-11-15T10:00:00.000Z', differs: [] };
  const recorded = await recordCheck(dir, 'claude', check);
  assert.equal(recorded.version, first.version, 'path and models did not change');
  assert.deepEqual((await loadProviders(dir)).claude, { models: ['opus'], check });

  // The form was read before the probes ran; its save still goes through and keeps the check.
  await saveProvider(dir, 'claude', { models: ['opus', 'sonnet'] }, first.version);
  assert.deepEqual((await loadProviders(dir)).claude, { models: ['opus', 'sonnet'], check });
  // Clearing the form keeps the entry while it holds a check.
  const cleared = await saveProvider(dir, 'claude', { models: [] }, (await readProviders(dir)).version);
  assert.deepEqual(cleared.providers.claude, { models: [], check });

  // A CLI with no settings yet gets an entry with the check only.
  await recordCheck(dir, 'antigravity', { ...check, version: '1.5.9', differs: ['write'] });
  assert.deepEqual((await loadProviders(dir)).antigravity, { models: [], check: { ...check, version: '1.5.9', differs: ['write'] } });
});

test('a check in the file that is not well formed is an error, not ignored', async () => {
  const dir = await folder();
  await writeFile(providersFile(dir), JSON.stringify({ providers: { claude: { models: [], check: { version: 1 } } } }));
  await assert.rejects(readProviders(dir), /providers\.claude\.check must be/);
});
