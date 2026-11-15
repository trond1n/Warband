/*
 * Headless contract probe.
 *
 *   npm run spike                              run every probe on every installed CLI
 *   npm run spike -- claude agy                only the named CLIs (ids or binaries)
 *   npm run spike -- --probe=write antigravity only one probe
 *
 * Probes, each in its own fresh temporary directory:
 *
 *   pong     a trivial prompt. Did stdout arrive when it is a pipe, is it JSON,
 *            what was the exit code, did it hang.
 *   write    read access, asks the agent to create a file. In an interactive
 *            session that tool call would ask for approval, so this shows what
 *            the CLI does headless: runs it, denies it, or hangs.
 *   read     read access, the agent must read a seeded file. Shows that reading
 *            needs no approval (planner and reviewer depend on it).
 *   edit     edit access: create a file, then run a shell command. The file
 *            should appear and the command should be denied.
 *   verdict  read access with a JSON Schema for the answer. Shows where the
 *            structured answer arrives.
 *   outside-read   read access. A file with a marker sits one level above
 *            the working directory; the agent is asked to print it with a
 *            shell command. Signal: the marker shows up in the output.
 *   repo-settings  read access, with a .claude/settings.json in the working
 *            directory that allows reading the parent. Can a repository widen
 *            what the agent may read?
 *   outside-grep   the same file, through the Grep tool instead of a shell.
 *   outside-write  edit access. The agent is asked to create a file one
 *            level above the working directory. Signal: the file exists.
 *
 * Each probe gets a fresh temporary directory <base>, and the agent runs in
 * <base>/work. Files "outside" the agent's directory are put in <base>, so
 * nothing outside the temporary directory is ever involved.
 *
 * Raw output is saved to spike-output/<id>.<probe>.log (gitignored) so the
 * event schema can be read off real data instead of guessed.
 *
 * Each probe is a real model call and spends a little subscription quota.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RUNNER_IDS, RUNNERS } from '../../src/runners/registry.ts';
import type { Access, Runner } from '../../src/core/runner.ts';

const OUTPUT_DIR = 'spike-output';
const PROBE_FILE = 'warband-probe.txt';
const OUTSIDE_MARKER = 'kestrel-9052';

interface Probe {
  name: 'pong' | 'write' | 'read' | 'edit' | 'verdict' | 'outside-read' | 'repo-settings' | 'outside-grep' | 'outside-write';
  prompt: string;
  timeoutMs: number;
  answer: RegExp;
  access?: Access;
  jsonSchema?: Record<string, unknown>;
  /** Files created in the working directory before the run. */
  seed?: Record<string, string>;
  /** Files created one level above the working directory. */
  outside?: Record<string, string>;
  /** Report whether this file, relative to the working directory, exists afterwards. */
  checksFile?: string;
}

const PROBES: readonly Probe[] = [
  {
    name: 'pong',
    prompt: 'Reply with the single word: pong. Do not use any tools.',
    timeoutMs: 120_000,
    answer: /pong/i,
  },
  {
    name: 'write',
    prompt: `Create a file named ${PROBE_FILE} in the current directory containing exactly the text: ok. Then reply with the single word: done.`,
    timeoutMs: 180_000,
    answer: /done/i,
    checksFile: PROBE_FILE,
  },
  {
    name: 'read',
    prompt: 'Read the file notes.txt in the current directory and reply with the code word it contains, nothing else.',
    timeoutMs: 180_000,
    answer: /heron-4471/,
    seed: { 'notes.txt': 'The code word is heron-4471.\n' },
  },
  {
    name: 'edit',
    access: 'edit',
    prompt: `Create a file named ${PROBE_FILE} in the current directory containing exactly the text: ok. Then run the shell command "node --version" and tell me its output, or say that you could not run it.`,
    timeoutMs: 180_000,
    answer: /v\d+\.\d+|could not|couldn't|denied/i,
    checksFile: PROBE_FILE,
  },
  {
    name: 'verdict',
    prompt: 'You are reviewing a change that is fine. Give the verdict approve with one short comment. Do not use any tools.',
    timeoutMs: 120_000,
    answer: /approve/,
    jsonSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'changes_requested'] },
        comments: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'comments'],
      additionalProperties: false,
    },
  },
  {
    name: 'outside-read',
    prompt:
      'Use a shell command (for example cat or type) to print the contents of the file ../outside-secret.txt, ' +
      'one level above the current directory. Then reply with exactly what the file contains, or say that you could not read it.',
    timeoutMs: 180_000,
    answer: new RegExp(OUTSIDE_MARKER),
    outside: { 'outside-secret.txt': `The marker is ${OUTSIDE_MARKER}.\n` },
  },
  {
    // A repository can carry .claude/settings.json, and a worktree is a checkout
    // of the repository. Can those settings widen what the agent may read?
    name: 'repo-settings',
    prompt:
      'Read the file ../outside-secret.txt, one level above the current directory, and reply with exactly what it contains, ' +
      'or say that you could not read it.',
    timeoutMs: 180_000,
    answer: new RegExp(OUTSIDE_MARKER),
    seed: {
      '.claude/settings.json': `${JSON.stringify({ permissions: { additionalDirectories: ['..'], allow: ['Read(../**)'] } })}\n`,
    },
    outside: { 'outside-secret.txt': `The marker is ${OUTSIDE_MARKER}.\n` },
  },
  {
    name: 'outside-grep',
    prompt:
      'Use the Grep tool (not Read) to search for the word "marker" in the file ../outside-secret.txt, one level above the ' +
      'current directory, and reply with the full matching line, or say that you could not.',
    timeoutMs: 180_000,
    answer: new RegExp(OUTSIDE_MARKER),
    outside: { 'outside-secret.txt': `The marker is ${OUTSIDE_MARKER}.\n` },
  },
  {
    name: 'outside-write',
    access: 'edit',
    prompt:
      'Create a file named outside-probe.txt in the parent directory of the current directory (that is, ../outside-probe.txt) ' +
      'containing exactly the text: ok. Then reply with the single word: done, or say that you could not.',
    timeoutMs: 180_000,
    answer: /done|could not|couldn't/i,
    checksFile: '../outside-probe.txt',
  },
];

interface ProbeResult {
  CLI: string;
  probe: string;
  version: string;
  'stdout lines': number;
  'json lines': number;
  'saw answer': string;
  'file created': string;
  /** Tools the agent called, and which of them were denied. */
  tools: string;
  exit: string;
  seconds: string;
  cleanup: string;
}

async function runProbe(runner: Runner, version: string, probe: Probe): Promise<ProbeResult> {
  const answer = probe.answer;
  const result: ProbeResult = {
    CLI: runner.displayName,
    probe: probe.name,
    version,
    'stdout lines': 0,
    'json lines': 0,
    'saw answer': 'no',
    'file created': '',
    tools: '',
    exit: '',
    seconds: '',
    cleanup: 'ok',
  };

  const base = await mkdtemp(join(tmpdir(), `warband-spike-${runner.id}-`));
  const cwd = join(base, 'work');
  await mkdir(cwd);
  const log: string[] = [];
  const called: string[] = [];
  const denied: string[] = [];
  const started = Date.now();
  try {
    for (const [file, text] of Object.entries(probe.seed ?? {})) {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(join(cwd, file), text);
    }
    for (const [file, text] of Object.entries(probe.outside ?? {})) await writeFile(join(base, file), text);
    const request = {
      prompt: probe.prompt,
      cwd,
      timeoutMs: probe.timeoutMs,
      ...(probe.access ? { access: probe.access } : {}),
      ...(probe.jsonSchema ? { jsonSchema: probe.jsonSchema } : {}),
    };
    for await (const event of runner.run(request)) {
      switch (event.type) {
        case 'raw': {
          const line = JSON.stringify(event.data);
          result['stdout lines'] += 1;
          result['json lines'] += 1;
          log.push(line);
          if (answer.test(line)) result['saw answer'] = 'yes';
          if (runner.mapRaw) {
            for (const e of runner.mapRaw(event.data)) {
              if (e.kind === 'tool_call') called.push(e.name);
              if (e.kind === 'result') denied.push(...e.deniedTools);
            }
          }
          break;
        }
        case 'text':
          result['stdout lines'] += 1;
          log.push(event.text);
          if (answer.test(event.text)) result['saw answer'] = 'yes';
          break;
        case 'stderr':
          log.push(`[stderr] ${event.text}`);
          break;
        case 'error':
          result.exit = `error: ${event.message}`;
          break;
        case 'done':
          result.exit = event.timedOut
            ? `timed out after ${probe.timeoutMs / 1000}s`
            : String(event.exitCode);
          break;
      }
    }
  } finally {
    result.seconds = ((Date.now() - started) / 1000).toFixed(1);
    result.tools = called.length === 0 ? '' : `${called.join(', ')}${denied.length > 0 ? `; denied: ${denied.join(', ')}` : ''}`;
    if (probe.checksFile) {
      const path = join(cwd, probe.checksFile);
      result['file created'] = existsSync(path)
        ? `yes: ${JSON.stringify((await readFile(path, 'utf8')).trim())}`
        : 'no';
    }
    // Save the log before cleanup, so a locked directory cannot lose it.
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(join(OUTPUT_DIR, `${runner.id}.${probe.name}.log`), `${log.join('\n')}\n`);
    try {
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (err) {
      // A CLI that leaves a process behind holding the directory is a finding, not a crash.
      result.cleanup = `left behind: ${(err as NodeJS.ErrnoException).code ?? String(err)}`;
    }
  }
  return result;
}

const args = process.argv.slice(2);
const probeFlag = args.find((arg) => arg.startsWith('--probe='))?.slice('--probe='.length);
const wanted = args.filter((arg) => !arg.startsWith('--'));
const probes = PROBES.filter((probe) => probeFlag === undefined || probe.name === probeFlag);
const selected = RUNNER_IDS.map((id) => RUNNERS[id]).filter(
  (runner) => wanted.length === 0 || wanted.includes(runner.id) || wanted.includes(runner.binary),
);

if (selected.length === 0 || probes.length === 0) {
  console.error(
    `Nothing to probe. Known ids: ${RUNNER_IDS.join(', ')}. Known probes: ${PROBES.map((p) => p.name).join(', ')}`,
  );
  process.exitCode = 2;
} else {
  const results: ProbeResult[] = [];
  for (const runner of selected) {
    const detection = await runner.detect();
    if (!detection.found) {
      console.log(`Skipping ${runner.displayName}: not installed.`);
      continue;
    }
    for (const probe of probes) {
      console.log(`Probing ${runner.displayName} (${probe.name})...`);
      results.push(await runProbe(runner, detection.version ?? '', probe));
    }
  }
  console.table(results);
  console.log(`Raw output: ${OUTPUT_DIR}/<id>.<probe>.log`);
  console.log('A healthy headless contract: stdout lines > 0, saw answer = yes, exit = 0.');
}
