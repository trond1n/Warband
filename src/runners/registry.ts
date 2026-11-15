import { cliRunner } from '../core/runner.ts';
import type { Runner, RunnerId } from '../core/runner.ts';
import { mapAntigravityEvent } from './events/antigravity.ts';
import { mapClaudeEvent } from './events/claude.ts';

const withModel = (model: string | undefined): string[] => (model ? ['--model', model] : []);

export const RUNNERS: Record<RunnerId, Runner> = {
  claude: cliRunner({
    id: 'claude',
    displayName: 'Claude Code',
    binary: 'claude',
    versionArgs: ['--version'],
    mapRaw: mapClaudeEvent,
    // The prompt goes on stdin: a review prompt carries a diff, which can
    // exceed the Windows command-line limit.
    promptOnStdin: true,
    buildArgs: (request) => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      // Pinned so the user's own settings (e.g. auto mode) cannot change what
      // a headless run is allowed to do. read: anything that would prompt is
      // denied. edit: file edits in cwd are accepted, everything else that
      // would prompt (shell commands) is still denied.
      '--permission-mode',
      request.access === 'edit' ? 'acceptEdits' : 'manual',
      '--permission-prompts',
      'none',
      ...(request.jsonSchema ? ['--json-schema', JSON.stringify(request.jsonSchema)] : []),
      ...withModel(request.model),
    ],
    capabilities: {
      transport: 'stream',
      structuredOutput: true,
      sandbox: 'agent',
      headlessApprovals: 'deny',
      // All fields checked on 2.1.325 with the args above, see docs/runners.md.
      verified: true,
    },
  }),

  codex: cliRunner({
    id: 'codex',
    displayName: 'Codex',
    binary: 'codex',
    versionArgs: ['--version'],
    buildArgs: (request) => ['exec', '--json', ...withModel(request.model), request.prompt],
    capabilities: {
      transport: 'stream',
      structuredOutput: true,
      sandbox: 'os',
      headlessApprovals: 'unknown',
      verified: false,
    },
  }),

  antigravity: cliRunner({
    id: 'antigravity',
    displayName: 'Antigravity',
    binary: 'agy',
    versionArgs: ['--version'],
    mapRaw: mapAntigravityEvent,
    buildArgs: (request) => [
      '-p',
      request.prompt,
      '--output-format',
      'stream-json',
      ...withModel(request.model),
    ],
    capabilities: {
      transport: 'stream',
      structuredOutput: true,
      // Transport and output confirmed on 1.5.9. No successful run yet, so the
      // approval behaviour is unknown; 1.5.7+ reportedly defaults headless runs
      // to Auto mode. `--sandbox` exists but has not been tried.
      sandbox: 'none',
      headlessApprovals: 'unknown',
      verified: false,
    },
  }),

  kimi: cliRunner({
    id: 'kimi',
    displayName: 'Kimi Code',
    binary: 'kimi',
    versionArgs: ['--version'],
    buildArgs: (request) => [
      '-p',
      request.prompt,
      '--output-format',
      'stream-json',
      ...withModel(request.model),
    ],
    capabilities: {
      transport: 'stream',
      structuredOutput: true,
      sandbox: 'none',
      headlessApprovals: 'auto-run',
      verified: false,
    },
  }),
};

export const RUNNER_IDS = Object.keys(RUNNERS) as RunnerId[];
