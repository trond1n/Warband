import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { providersFile } from '../../../src/core/providers.ts';
import type { Providers } from '../../../src/core/providers.ts';
import type { Runner, RunnerEvent, RunnerId, RunRequest } from '../../../src/core/runner.ts';
import { RUNNER_IDS, RUNNERS } from '../../../src/runners/registry.ts';
import type { Probe, Recorded } from '../../../scripts/spike/probes.ts';
import type { ProbeState } from '../shared/api.ts';
import { docSection, ProviderService } from './providers.ts';

/* The "Провайдеры" service against a temporary settings folder, with scripted CLIs. */

const dirs: string[] = [];
const folder = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'warband-app-providers-'));
  dirs.push(dir);
  return dir;
};
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

interface Script {
  installed?: readonly RunnerId[];
  /** Version every installed CLI reports; "<id> 1.0" by default. */
  version?: string;
  /** Text each probe run answers with. */
  answer?: string;
  /** Waits before each run, so a test can look at a probe in progress. */
  gate?: () => Promise<void>;
  requests?: RunRequest[];
}

/** Runners that answer from a script instead of launching a CLI. */
function scripted(script: Script): (providers: Providers) => Record<RunnerId, Runner> {
  return (providers) => {
    const entries = RUNNER_IDS.map((id): [RunnerId, Runner] => {
      const real = RUNNERS[id];
      const found = (script.installed ?? ['claude']).includes(id);
      return [
        id,
        {
          id,
          displayName: real.displayName,
          binary: providers[id]?.binary ?? real.binary,
          capabilities: real.capabilities,
          ...(providers[id]?.check ? { localCheck: providers[id]?.check } : {}),
          detect: async () => (found ? { found: true, version: script.version ?? `${id} 1.0` } : { found: false }),
          ...(id === 'claude' ? { login: async () => ({ state: 'in' as const, method: 'claude.ai' }) } : {}),
          async *run(request: RunRequest): AsyncGenerator<RunnerEvent> {
            script.requests?.push(request);
            await script.gate?.();
            yield { type: 'text', text: script.answer ?? 'pong' };
            yield { type: 'done', exitCode: 0, timedOut: false };
          },
        },
      ];
    });
    return Object.fromEntries(entries) as Record<RunnerId, Runner>;
  };
}

const PROBES: readonly Probe[] = [
  { name: 'pong', prompt: 'say pong', timeoutMs: 5_000, answer: /pong/ },
  { name: 'read', prompt: 'read', timeoutMs: 5_000, answer: /heron/, seed: { 'notes.txt': 'heron' } },
];

async function service(script: Script = {}, extra: Partial<ConstructorParameters<typeof ProviderService>[0]> = {}): Promise<{ svc: ProviderService; dir: string }> {
  const dir = await folder();
  const docsFile = join(dir, 'runners.md');
  await writeFile(docsFile, '# Runners\n\n## Claude Code\n\nVerified.\n\n## Adding a runner\n\n1. Add a spec.\n');
  const svc = new ProviderService({ dir, docsFile, makeRunners: scripted(script), probes: PROBES, ...extra });
  return { svc, dir };
}

test('the view lists every CLI with its state; login is unknown unless the CLI reports it', async () => {
  const { svc } = await service({ installed: ['claude', 'antigravity'] });
  const view = await svc.view();
  assert.deepEqual(
    view.providers.map((p) => [p.id, p.found, p.version, p.login.state, p.capabilities.verified]),
    [
      ['claude', true, 'claude 1.0', 'in', true],
      ['codex', false, undefined, 'unknown', false],
      ['antigravity', true, 'antigravity 1.0', 'unknown', false],
      ['kimi', false, undefined, 'unknown', false],
    ],
  );
  assert.equal(view.providers[0]?.command, 'claude');
  // The scripted Claude reports 1.0, not the 2.1.325 its adapter was verified on.
  assert.deepEqual(view.providers[0]?.drift, { kind: 'differs', verifiedOn: '2.1.325', installed: '1.0', newer: false });
  assert.deepEqual(view.providers[2]?.drift, { kind: 'none' }, 'unverified adapters have nothing to compare');
  assert.equal(view.version, 'none');
  assert.equal(view.error, undefined);
});

test('a saved path and model list are used by the runners and survive a new service', async () => {
  let swapped: Record<RunnerId, Runner> | undefined;
  const { svc, dir } = await service({}, { onRunners: (r) => (swapped = r) });
  const binary = join(dir, 'agy.exe');
  await writeFile(binary, '');
  const before = await svc.view();

  const result = await svc.save('antigravity', { binary, models: ['gemini-3-pro', ''] }, before.version);
  assert.equal(result.ok, true);
  assert.equal(swapped?.antigravity.binary, binary);

  // A restart: a new service reads the same folder.
  const again = new ProviderService({ dir, docsFile: join(dir, 'runners.md'), makeRunners: scripted({}) });
  const view = await again.view();
  const agy = view.providers.find((p) => p.id === 'antigravity');
  assert.deepEqual(agy?.settings, { binary, models: ['gemini-3-pro'] });
  assert.equal(agy?.binary, binary);
});

test('invalid settings come back as problems and are not saved', async () => {
  const { svc, dir } = await service();
  const result = await svc.save('claude', { binary: join(dir, 'nothing-here.exe'), models: ['ok', 'ok'] }, 'none');
  assert.equal(result.ok, false);
  assert.ok(!result.ok && 'problems' in result);
  assert.deepEqual(
    result.problems.map((p) => p.code),
    ['binary-missing', 'model-duplicate'],
  );
  assert.equal((await svc.view()).version, 'none');
});

test('a file changed on disk since the form read it is reported, not overwritten', async () => {
  const { svc, dir } = await service();
  const { version } = await svc.view();
  await writeFile(providersFile(dir), '{"providers":{"claude":{"models":["by-hand"]}}}\n');
  assert.deepEqual(await svc.save('claude', { models: ['opus'] }, version), { ok: false, changed: true });
  assert.deepEqual((await svc.view()).providers[0]?.settings, { models: ['by-hand'] });
});

test('a broken settings file is shown as an error, with the CLIs still listed', async () => {
  const { svc, dir } = await service();
  await writeFile(providersFile(dir), '{ nope');
  const view = await svc.view();
  assert.match(view.error ?? '', /not valid JSON/);
  assert.equal(view.providers.length, 4);
  const saved = await svc.save('claude', { models: [] }, view.version);
  assert.ok(!saved.ok && 'error' in saved);
});

test('probes run one after another on the chosen CLI and report progress', async () => {
  const requests: RunRequest[] = [];
  const progress: ProbeState[] = [];
  const { svc } = await service({ requests }, { onProbe: (_id, state) => progress.push(state) });

  const final = await svc.probe('claude');
  assert.equal(final.running, false);
  assert.equal(final.error, undefined);
  assert.deepEqual(
    final.results.map((r) => [r.probe, r['saw answer'], r.exit]),
    [
      ['pong', 'yes', '0'],
      ['read', 'no', '0'],
    ],
  );
  assert.equal(requests.length, 2);
  assert.ok(progress.some((s) => s.running && s.current === 'read' && s.results.length === 1));
  assert.deepEqual(svc.probeState('claude'), final, 'the last results are kept for the screen');
  assert.equal(RUNNERS.claude.capabilities.verified, true, 'probing does not touch verified');
});

test('a CLI that is not installed is not probed', async () => {
  const requests: RunRequest[] = [];
  const { svc } = await service({ requests });
  const state = await svc.probe('kimi');
  assert.match(state.error ?? '', /не найден/);
  assert.equal(requests.length, 0);
});

test('only one probe run at a time, and it can be stopped', async () => {
  let release: () => void = () => {};
  const { svc } = await service({ installed: ['claude', 'antigravity'], gate: () => new Promise<void>((r) => (release = r)) });
  const running = svc.probe('claude');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(svc.probing, true);
  assert.match((await svc.probe('antigravity')).error ?? '', /Уже идёт/);

  svc.cancelProbe();
  release();
  const final = await running;
  assert.equal(final.running, false);
  assert.match(final.error ?? '', /остановлена/);
  assert.equal(final.results.length, 1, 'the probe in progress finishes, the rest are skipped');
  assert.equal(svc.probing, false);
});

test('docs sections are read by name; anything else is refused', async () => {
  const { svc } = await service();
  assert.equal(await svc.docs('claude'), 'Verified.');
  assert.equal(await svc.docs('adding'), '1. Add a spec.');
  assert.equal(await svc.docs('kimi'), '', 'a missing heading gives an empty section');
  await assert.rejects(svc.docs('../secrets'), /unknown docs section/);
});

test('docSection stops at the next second-level heading', () => {
  const md = '## A\r\ntext\r\n### Sub\r\nmore\r\n## B\r\nother';
  assert.equal(docSection(md, 'A'), 'text\n### Sub\nmore');
  assert.equal(docSection(md, 'B'), 'other');
  assert.equal(docSection(md, 'C'), undefined);
});

/** Recorded results for the two test probes: pong answers, read does not find its word. */
const RECORDED_TEST: Partial<Record<RunnerId, Recorded>> = {
  claude: { on: '2.1.325', probes: { pong: { answer: 'yes', exit: '0' }, read: { answer: 'no', exit: '0' } } as Recorded['probes'] },
};

test('a full run that matches the recorded results makes the installed version count as checked here', async () => {
  let swapped: Record<RunnerId, Runner> | undefined;
  const { svc, dir } = await service({ version: '2.1.330 (Claude Code)' }, { recorded: RECORDED_TEST, onRunners: (r) => (swapped = r) });
  const before = await svc.view();
  assert.equal(before.providers[0]?.drift.kind, 'differs');

  const final = await svc.probe('claude');
  assert.deepEqual(final.mismatches, []);
  assert.deepEqual(final.check?.differs, []);
  assert.equal(swapped?.claude.localCheck?.version, '2.1.330 (Claude Code)', 'runs use the new check');

  const after = await svc.view();
  assert.equal(after.providers[0]?.drift.kind, 'checked');
  assert.equal(after.version, before.version, 'an open form does not go stale');
  const file = JSON.parse(await readFile(providersFile(dir), 'utf8'));
  assert.equal(file.providers.claude.check.version, '2.1.330 (Claude Code)');
  assert.ok(!('check' in (file.providers.antigravity ?? {})), 'only the probed CLI');
});

test('a probe that differs keeps the warning and names the probe', async () => {
  const { svc } = await service({ version: '2.1.330', answer: 'heron' }, { recorded: RECORDED_TEST });
  const final = await svc.probe('claude');
  assert.deepEqual(final.check?.differs, ['pong', 'read']);
  assert.deepEqual(final.mismatches?.map((m) => [m.probe, m.field, m.actual]), [
    ['pong', 'answer', 'no'],
    ['read', 'answer', 'yes'],
  ]);
  const drift = (await svc.view()).providers[0]?.drift;
  assert.deepEqual(drift, { kind: 'differs', verifiedOn: '2.1.325', installed: '2.1.330', newer: true, failed: ['pong', 'read'] });
});

test('a stopped run is not remembered', async () => {
  let release: () => void = () => {};
  const { svc, dir } = await service({ version: '2.1.330', gate: () => new Promise<void>((r) => (release = r)) }, { recorded: RECORDED_TEST });
  const running = svc.probe('claude');
  await new Promise((r) => setTimeout(r, 20));
  svc.cancelProbe();
  release();
  const final = await running;
  assert.equal(final.check, undefined);
  assert.equal((await svc.view()).version, 'none');
  await assert.rejects(readFile(providersFile(dir), 'utf8'), /ENOENT/);
});
