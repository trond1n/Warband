import { cliRunner } from '../core/runner.ts';
import type { Runner, RunnerId, RunRequest } from '../core/runner.ts';
import { mapAntigravityEvent } from './events/antigravity.ts';
import { mapClaudeEvent } from './events/claude.ts';

const withModel = (model: string | undefined): string[] => (model ? ['--model', model] : []);

/**
 * Claude Code tools per access level, passed as `--tools` ("the list of
 * available tools from the built-in set", 2.1.325 --help). No shell in
 * either: read-only shell commands such as `cat` ran without approval in
 * read mode, and no role needs a shell, because hooks run the commands.
 * Leaving out WebSearch, WebFetch, Task and the rest also closes ways to
 * send data elsewhere. See docs/runners.md.
 */
export const CLAUDE_TOOLS = {
  read: ['Read', 'Glob', 'Grep'],
  edit: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
} as const;

/** The Claude Code command line for a request. Exported so tests can pin it. */
export function claudeArgs(request: RunRequest): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // Pinned so the user's own settings (e.g. auto mode) cannot change what
    // a headless run is allowed to do. read: anything that would prompt is
    // denied. edit: file edits in cwd are accepted, everything else that
    // would prompt (edits outside cwd) is still denied.
    '--permission-mode',
    request.access === 'edit' ? 'acceptEdits' : 'manual',
    '--permission-prompts',
    'none',
    '--tools',
    CLAUDE_TOOLS[request.access ?? 'read'].join(','),
    // No MCP servers: without --mcp-config this loads none, which also
    // keeps the account's connectors (mail, drive...) away from the agent.
    '--strict-mcp-config',
    ...(request.jsonSchema ? ['--json-schema', JSON.stringify(request.jsonSchema)] : []),
    ...withModel(request.model),
  ];
}

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
    buildArgs: claudeArgs,
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
