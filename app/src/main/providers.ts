import { readFile } from 'node:fs/promises';

import { ProviderInvalidError, ProvidersChangedError, providersFile, readProviders, recordCheck, saveProvider } from '../../../src/core/providers.ts';
import type { ProviderSettings, Providers } from '../../../src/core/providers.ts';
import { versionDrift } from '../../../src/core/runner.ts';
import type { Runner, RunnerId } from '../../../src/core/runner.ts';
import { createRunners, RUNNER_IDS, RUNNER_SPECS } from '../../../src/runners/registry.ts';
import { localCheck, PROBES, RECORDED, runProbe } from '../../../scripts/spike/probes.ts';
import type { Probe, Recorded } from '../../../scripts/spike/probes.ts';
import type { ProbeState, ProviderInfo, ProvidersView, SaveProviderResult } from '../shared/api.ts';

/*
 * The "Провайдеры" screen: the agent CLIs on this machine, their settings
 * in <config dir>/providers.json, and the spike probes run on request. No
 * Electron here, so it is tested with node:test.
 */

/** Sections of docs/runners.md the screen can show, by heading. */
export const DOC_SECTIONS: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  kimi: 'Kimi Code',
  glm: 'GLM',
  adding: 'Adding a runner',
};

/** One `## <heading>` section of a Markdown document, up to the next `## `. */
export function docSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

export interface ProviderServiceOptions {
  /** Folder of providers.json. */
  dir: string;
  /** docs/runners.md of this Warband. */
  docsFile: string;
  /** Builds the runners for given settings. Tests pass scripted ones. */
  makeRunners?: (providers: Providers) => Record<RunnerId, Runner>;
  probes?: readonly Probe[];
  /** Results each verified adapter was verified with. Tests pass their own. */
  recorded?: Partial<Record<RunnerId, Recorded>>;
  /** The runners changed after a save. */
  onRunners?(runners: Record<RunnerId, Runner>): void;
  /** Progress of a probe run. */
  onProbe?(id: RunnerId, state: ProbeState): void;
}

export class ProviderService {
  readonly #options: ProviderServiceOptions;
  readonly #probes = new Map<RunnerId, ProbeState>();
  #controller: AbortController | undefined;
  #runners: Record<RunnerId, Runner>;

  constructor(options: ProviderServiceOptions) {
    this.#options = options;
    this.#runners = this.#make({});
  }

  #make(providers: Providers): Record<RunnerId, Runner> {
    return (this.#options.makeRunners ?? createRunners)(providers);
  }

  get runners(): Record<RunnerId, Runner> {
    return this.#runners;
  }

  /** Reads the settings and rebuilds the runners. A broken file is reported, not thrown. */
  async load(): Promise<{ providers: Providers; version: string; error?: string }> {
    try {
      const snapshot = await readProviders(this.#options.dir);
      this.#runners = this.#make(snapshot.providers);
      return snapshot;
    } catch (err) {
      return { providers: {}, version: 'unreadable', error: (err as Error).message };
    }
  }

  async view(): Promise<ProvidersView> {
    const { providers, version, error } = await this.load();
    const list = await Promise.all(
      RUNNER_IDS.map(async (id): Promise<ProviderInfo> => {
        const runner = this.#runners[id];
        const detection = await runner.detect();
        const login = detection.found && runner.login ? await runner.login() : { state: 'unknown' as const };
        return {
          id,
          name: runner.displayName,
          command: RUNNER_SPECS[id].binary,
          binary: runner.binary,
          settings: providers[id] ?? { models: [] },
          found: detection.found,
          ...(detection.version ? { version: detection.version } : {}),
          ...(detection.problem ? { problem: detection.problem } : {}),
          login,
          capabilities: runner.capabilities,
          drift: versionDrift(runner.capabilities, detection.version, detection.found, runner.localCheck),
          probe: this.probeState(id),
        };
      }),
    );
    return { providers: list, version, file: providersFile(this.#options.dir), ...(error ? { error } : {}) };
  }

  async save(id: RunnerId, settings: ProviderSettings, version: string): Promise<SaveProviderResult> {
    try {
      const snapshot = await saveProvider(this.#options.dir, id, settings, version);
      this.#runners = this.#make(snapshot.providers);
      this.#options.onRunners?.(this.#runners);
      return { ok: true, version: snapshot.version };
    } catch (err) {
      if (err instanceof ProviderInvalidError) return { ok: false, problems: err.problems };
      if (err instanceof ProvidersChangedError) return { ok: false, changed: true };
      return { ok: false, error: (err as Error).message };
    }
  }

  async docs(section: string): Promise<string> {
    const heading = DOC_SECTIONS[section];
    if (!heading) throw new Error(`unknown docs section ${section}`);
    const text = await readFile(this.#options.docsFile, 'utf8');
    return docSection(text, heading) ?? '';
  }

  probeState(id: RunnerId): ProbeState {
    return this.#probes.get(id) ?? { running: false, total: 0, results: [] };
  }

  #setProbe(id: RunnerId, state: ProbeState): void {
    this.#probes.set(id, state);
    this.#options.onProbe?.(id, state);
  }

  /**
   * Runs every probe on one CLI, one after another. One probe run at a time
   * on the machine, since each probe spends subscription quota. Resolves
   * when the run ends. It never changes `verified` or `verifiedOn`, which stay
   * in the code; a full run is remembered in providers.json as a local check.
   */
  async probe(id: RunnerId): Promise<ProbeState> {
    if (this.#controller) return { ...this.probeState(id), error: 'Уже идёт проверка другого CLI.' };
    const runner = this.#runners[id];
    const probes = this.#options.probes ?? PROBES;
    const controller = new AbortController();
    this.#controller = controller;
    let state: ProbeState = { running: true, total: probes.length, results: [] };
    try {
      const detection = await runner.detect();
      if (!detection.found) {
        state = { running: false, total: probes.length, results: [], error: `${runner.displayName} не найден.` };
        this.#setProbe(id, state);
        return state;
      }
      for (const probe of probes) {
        if (controller.signal.aborted) break;
        this.#setProbe(id, { ...state, current: probe.name });
        const result = await runProbe(runner, detection.version ?? '', probe, { signal: controller.signal });
        state = { ...state, results: [...state.results, result] };
        this.#setProbe(id, state);
      }
      const finished = new Date();
      state = { ...state, running: false, finished: finished.toISOString(), ...(controller.signal.aborted ? { error: 'Проверка остановлена.' } : {}) };
      // A full run is compared with the recorded results and remembered on this machine.
      const local = controller.signal.aborted ? undefined : localCheck((this.#options.recorded ?? RECORDED)[id], detection.version ?? '', state.results, finished);
      if (local) {
        await recordCheck(this.#options.dir, id, local.check);
        state = { ...state, check: local.check, mismatches: local.mismatches };
        await this.load();
        this.#options.onRunners?.(this.#runners);
      }
    } catch (err) {
      state = { ...state, running: false, error: (err as Error).message };
    } finally {
      this.#controller = undefined;
    }
    this.#setProbe(id, state);
    return state;
  }

  cancelProbe(): void {
    this.#controller?.abort();
  }

  get probing(): boolean {
    return this.#controller !== undefined;
  }
}
