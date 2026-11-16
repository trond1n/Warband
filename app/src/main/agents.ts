import { relative } from 'node:path';

import type { AgentInput } from '../../../src/core/agents.ts';
import { modelChoices } from '../../../src/core/providers.ts';
import type { Providers } from '../../../src/core/providers.ts';
import { unverifiedImplementerMessage, versionDrift } from '../../../src/core/runner.ts';
import type { Runner, RunnerId } from '../../../src/core/runner.ts';
import { promptSize } from '../../../src/core/skills.ts';
import { AgentChangedError, AgentInvalidError, deleteAgent, loadHooks, readAgents, readSkills, saveAgentInput } from '../../../src/core/workspace.ts';
import { RUNNER_IDS } from '../../../src/runners/registry.ts';
import type { AgentsView, DeleteAgentResult, ProviderChoice, SaveAgentResult } from '../shared/api.ts';

/*
 * The "Агенты" screen: .warband/agents/*.json edited one at a time through
 * the core, with what the form picks from: the project's skills (with their
 * size in a prompt) and hooks, and the providers of this machine with their
 * model lists, install state, adapter and version. No Electron here, so it
 * is tested with node:test.
 */

export interface AgentServiceOptions {
  /** providers.json of this machine, as the Providers screen keeps it. */
  providers(): Promise<{ providers: Providers; error?: string }>;
  /** The runners built from those settings. */
  runners(): Record<RunnerId, Runner>;
}

export class AgentService {
  readonly #options: AgentServiceOptions;

  constructor(options: AgentServiceOptions) {
    this.#options = options;
  }

  async view(root: string): Promise<AgentsView> {
    const [agents, parts, settings] = await Promise.all([
      readAgents(root).then(
        (list) => ({ list }),
        (err: Error) => ({ list: [], error: err.message }),
      ),
      Promise.all([readSkills(root), loadHooks(root)]).then(
        ([skills, hooks]) => ({ skills, hooks }),
        (err: Error) => ({ skills: [], hooks: [], error: err.message }),
      ),
      this.#options.providers(),
    ]);
    const runners = this.#options.runners();
    const providers = await Promise.all(
      RUNNER_IDS.map(async (id): Promise<ProviderChoice> => {
        const runner = runners[id];
        const detection = await runner.detect();
        return {
          id,
          name: runner.displayName,
          found: detection.found,
          ...(detection.version ? { version: detection.version } : {}),
          verified: runner.capabilities.verified,
          unverifiedMessage: unverifiedImplementerMessage(runner.displayName),
          drift: versionDrift(runner.capabilities, detection.version, detection.found, runner.localCheck),
          models: modelChoices(settings.providers, id),
        };
      }),
    );
    return {
      agents: agents.list.map((a) => ({ agent: a.agent, version: a.version, file: relative(root, a.path).replaceAll('\\', '/') })),
      skills: parts.skills.map((s) => ({ name: s.name, description: s.description, size: promptSize(s.text) })),
      hooks: parts.hooks,
      providers,
      ...('error' in agents && agents.error ? { error: agents.error } : {}),
      ...('error' in parts && parts.error ? { partsError: parts.error } : {}),
      ...(settings.error ? { providersError: settings.error } : {}),
    };
  }

  async save(root: string, input: AgentInput, original: string | undefined, version: string): Promise<SaveAgentResult> {
    try {
      const saved = await saveAgentInput(root, input, original === undefined ? {} : { original, expectedVersion: version });
      return { ok: true, version: saved.version, name: saved.agent.name };
    } catch (err) {
      if (err instanceof AgentInvalidError) return { ok: false, problems: err.problems };
      if (err instanceof AgentChangedError) return { ok: false, changed: true };
      return { ok: false, error: (err as Error).message };
    }
  }

  async remove(root: string, name: string, version: string): Promise<DeleteAgentResult> {
    try {
      await deleteAgent(root, name, version);
      return { ok: true };
    } catch (err) {
      if (err instanceof AgentChangedError) return { ok: false, changed: true };
      return { ok: false, error: (err as Error).message };
    }
  }
}
