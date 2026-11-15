#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HookStage } from './core/hooks.ts';
import { HOOK_STAGES, runHook } from './core/hooks.ts';
import { runProcess } from './core/proc.ts';
import { which } from './core/which.ts';
import type { RunnerId } from './core/runner.ts';
import {
  createSkill,
  listAgents,
  listSkills,
  loadAgent,
  loadHooks,
  saveAgent,
  saveHooks,
  warbandDir,
} from './core/workspace.ts';
import { eventLog } from './engine/log.ts';
import { runTask } from './engine/run.ts';
import { renderEvent, terminalGate } from './engine/terminal.ts';
import { configDir, loadProviders, providersFile } from './core/providers.ts';
import { createRunners, RUNNER_IDS } from './runners/registry.ts';
import { driftMessage, versionDrift } from './core/runner.ts';
import type { Runner } from './core/runner.ts';
import { CLAUDE_MODEL_ALIASES, agentWizard, parseAgyModels } from './wizard/agent-wizard.ts';
import type { Prompter } from './wizard/agent-wizard.ts';

const HELP = `warband <command> [--dir <project>]

Commands:
  doctor                 Show which agent CLIs are installed and what Warband assumes about them
  agent new              Create an agent step by step (name, instructions, skills, hooks, models)
  agent list             List the project's agents
  run <agent> [task]     Run a task with an agent: plan, your approval, implement, checks, review,
                         your acceptance, commit on a new branch. Asks for the task if not given.
                         --allow-unverified lets an unverified adapter edit files
  check <agent> [stage]  Run the agent's hooks here, without any model (stage: ${HOOK_STAGES.join(', ')};
                         default checks and finish)
  ui                     Open the desktop window for the project (Electron); builds it on first use
  help                   Show this message

The project is --dir, or the directory Warband was started from.
Agents, skills and hooks live in <project>/.warband/.
`;

/**
 * Runners with the binaries set in this machine's settings (the window's
 * "Провайдеры" screen, or providers.json by hand).
 */
async function machineRunners(): Promise<Record<RunnerId, Runner>> {
  return createRunners(await loadProviders(configDir()));
}

async function doctor(): Promise<number> {
  const providers = await loadProviders(configDir());
  const runners = createRunners(providers);
  const drifts: string[] = [];
  const rows = await Promise.all(
    RUNNER_IDS.map(async (id) => {
      const runner = runners[id];
      const detection = await runner.detect();
      const drift = versionDrift(runner.capabilities, detection.version, detection.found);
      const driftNote = driftMessage(runner.displayName, id, drift);
      if (driftNote) drifts.push(driftNote);
      return {
        CLI: runner.displayName,
        binary: providers[id]?.binary ? `${runner.binary} (set)` : runner.binary,
        installed: detection.found ? 'yes' : 'no',
        version: detection.version ?? '',
        sandbox: runner.capabilities.sandbox,
        'headless approvals': runner.capabilities.headlessApprovals,
        verified: runner.capabilities.verified ? `yes${runner.capabilities.verifiedOn ? ` (${runner.capabilities.verifiedOn})` : ''}` : 'no',
        note: !detection.found
          ? providers[id]?.binary
            ? 'cannot start the set binary'
            : 'not on PATH'
          : drift.kind === 'differs'
            ? `version differs from verified ${drift.verifiedOn}`
            : drift.kind === 'unknown'
              ? 'version not comparable'
              : (detection.problem ?? ''),
      };
    }),
  );
  console.table(rows);
  for (const line of drifts) console.log(`Warning: ${line}`);
  console.log(`Binaries marked (set) come from ${providersFile(configDir())}.`);
  console.log('Login state is not checked here. Run `npm run spike` to test a real headless call.');
  return rows.some((row) => row.installed === 'yes') ? 0 : 1;
}

/** Asks the CLI itself which models it offers. No model call is made. */
async function modelsOf(runners: Record<RunnerId, Runner>, runner: RunnerId): Promise<string[]> {
  if (runner === 'claude') return CLAUDE_MODEL_ALIASES;
  if (runner === 'antigravity') {
    const lines: string[] = [];
    for await (const event of runProcess(runners.antigravity.binary, ['models'], { cwd: process.cwd(), timeoutMs: 30_000 })) {
      if (event.type === 'stdout') lines.push(event.line);
    }
    return parseAgyModels(lines.join('\n'));
  }
  return [];
}

/**
 * Reads answers line by line. Lines are queued rather than read with
 * rl.question, which drops lines that arrive before the question is asked
 * (all of them, when answers are piped in).
 */
function terminalPrompter(): Prompter & { close(): void; handOver(run: () => Promise<void>): Promise<void> } {
  const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  const lines: string[] = [];
  const waiting: { resolve(line: string): void; reject(err: Error): void }[] = [];
  let closed = false;
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next.resolve(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const next of waiting.splice(0)) next.reject(new Error('input ended before the wizard finished'));
  });
  return {
    ask(question) {
      stdout.write(question);
      const line = lines.shift();
      if (line !== undefined) {
        if (!stdin.isTTY) stdout.write(`${line}
`);
        return Promise.resolve(line);
      }
      if (closed) return Promise.reject(new Error('input ended before the wizard finished'));
      return new Promise((resolve, reject) => {
        waiting.push({
          resolve: (answer) => {
            if (!stdin.isTTY) stdout.write(`${answer}
`);
            resolve(answer);
          },
          reject,
        });
      });
    },
    say: (text) => console.log(text),
    close: () => rl.close(),
    /** Gives the terminal to another program (reslop) until it exits. */
    async handOver(run) {
      rl.pause();
      try {
        await run();
      } finally {
        rl.resume();
      }
    },
  };
}

async function agentNew(root: string): Promise<number> {
  console.log('Looking for installed CLIs...');
  const all = await machineRunners();
  const detected = await Promise.all(RUNNER_IDS.map(async (id) => ({ id, found: (await all[id].detect()).found })));
  const runners = detected.filter((d) => d.found).map((d) => ({ id: d.id, displayName: all[d.id].displayName }));
  const [agents, skills, hooks] = await Promise.all([listAgents(root), listSkills(root), loadHooks(root)]);

  const io = terminalPrompter();
  try {
    const result = await agentWizard(io, {
      root,
      runners,
      models: (runner) => modelsOf(all, runner),
      existingAgents: agents.map((a) => a.name),
      skills,
      hooks,
      reslop: (await which('reslop')) !== undefined,
    });
    if (!result) {
      console.log('Nothing saved.');
      return 1;
    }
    for (const skill of result.newSkills) {
      const created = await createSkill(root, skill.name, skill.description);
      console.log(`Created ${created.path}. Write the skill's rules there.`);
    }
    if (result.newHooks.length > 0) await saveHooks(root, [...hooks, ...result.newHooks]);
    console.log(`Saved ${await saveAgent(root, result.agent)}`);
    if (result.agent.hooks.length > 0) console.log(`Try its hooks now: warband check ${result.agent.name}`);
    return 0;
  } finally {
    io.close();
  }
}

async function agentList(root: string): Promise<number> {
  const agents = await listAgents(root);
  if (agents.length === 0) {
    console.log('No agents yet. Create one with: warband agent new');
    return 0;
  }
  console.table(
    agents.map((a) => ({
      agent: `/${a.name}`,
      does: a.description.split('\n')[0],
      skills: a.skills.join(', '),
      hooks: a.hooks.join(', '),
      implementer: `${a.roles.implementer.runner}/${a.roles.implementer.model ?? 'default'}`,
      reviewer: `${a.roles.reviewer.runner}/${a.roles.reviewer.model ?? 'default'}`,
    })),
  );
  return 0;
}

async function check(root: string, agentName: string | undefined, stage: string | undefined): Promise<number> {
  if (!agentName) {
    console.error('Usage: warband check <agent> [stage]');
    return 2;
  }
  if (stage !== undefined && !(HOOK_STAGES as readonly string[]).includes(stage)) {
    console.error(`Unknown stage "${stage}". Use ${HOOK_STAGES.join(' or ')}.`);
    return 2;
  }
  const agent = await loadAgent(root, agentName);
  if (!agent) {
    console.error(`No agent "${agentName}" in ${root}. See: warband agent list`);
    return 2;
  }
  const all = await loadHooks(root);
  const hooks = agent.hooks
    .map((name) => all.find((h) => h.name === name))
    .filter((h) => h !== undefined)
    // setup is meant for a fresh worktree; in the person's own checkout it runs only when asked for.
    .filter((h) => (stage === undefined ? h.stage !== 'setup' : h.stage === (stage as HookStage)));
  if (hooks.length === 0) {
    console.log(`/${agent.name} has no hooks${stage ? ` for stage ${stage}` : ''}.`);
    return 0;
  }
  let failed = 0;
  const reslop = await which('reslop');
  for (const hook of hooks) {
    console.log(`\n[${hook.stage}] ${hook.name}: ${hook.run}${hook.reduce && reslop ? ' (through reslop)' : ''}`);
    const result = await runHook(hook, root, { warbandDir: warbandDir(root), ...(reslop ? { reslop } : {}) });
    if (!result.ok) {
      failed += 1;
      for (const line of result.output) console.log(`  ${line}`);
    }
    console.log(result.ok ? '  passed' : `  FAILED (${result.timedOut ? 'timed out' : `exit ${result.exitCode}`})`);
  }
  console.log(`\n${hooks.length - failed}/${hooks.length} hooks passed.`);
  return failed === 0 ? 0 : 1;
}

async function run(root: string, agentName: string | undefined, taskWords: readonly string[], allowUnverified: boolean): Promise<number> {
  if (!agentName) {
    console.error('Usage: warband run <agent> [task]');
    return 2;
  }
  const agent = await loadAgent(root, agentName);
  if (!agent) {
    console.error(`No agent "${agentName}" in ${root}. See: warband agent list`);
    return 2;
  }
  const reslop = stdin.isTTY ? await which('reslop') : undefined;
  const io = terminalPrompter();
  try {
    let task = taskWords.join(' ').trim();
    if (task === '') {
      io.say(`Task for /${agent.name}? Finish with an empty line.`);
      const lines: string[] = [];
      while (true) {
        const line = await io.ask('> ');
        if (line.trim() === '') break;
        lines.push(line);
      }
      task = lines.join('\n').trim();
      if (task === '') {
        console.error('No task given.');
        return 2;
      }
    }
    const log = eventLog(root);
    const result = await runTask(
      {
        root,
        runners: await machineRunners(),
        gate: terminalGate(io, reslop ? (worktree) => io.handOver(() => openInTerminal(reslop, worktree)) : undefined),
        report: (event) => {
          log.write(event);
          renderEvent(event, (text) => io.say(text));
        },
        allowUnverified,
      },
      agent,
      task,
    );
    const path = log.path();
    if (path) io.say(`Run log: ${path}`);
    return result.state.status === 'done' ? 0 : 1;
  } finally {
    io.close();
  }
}

/** Runs a full-screen program in this terminal and waits for it to exit. */
function openInTerminal(program: string, cwd: string): Promise<void> {
  return new Promise((resolveExit) => {
    const child = spawn(program, [], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', (err) => {
      console.error(`Could not start ${program}: ${err.message}`);
      resolveExit();
    });
    child.on('exit', () => resolveExit());
  });
}

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

/** Runs a Node script to the end with inherited output, for the one-off build steps of `ui`. */
function runNode(args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
    child.on('error', () => resolveExit(1));
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

async function ui(root: string): Promise<number> {
  if (!existsSync(join(APP_DIR, 'package.json'))) {
    console.error(`No app in ${APP_DIR}.`);
    return 1;
  }
  const require = createRequire(join(APP_DIR, 'package.json'));
  let electronPkg: string;
  try {
    electronPkg = dirname(require.resolve('electron/package.json'));
  } catch {
    console.error('Electron is not installed. Run npm install in the Warband folder.');
    return 1;
  }
  // npm may skip electron's install script, which downloads the binary.
  if (!existsSync(join(electronPkg, 'path.txt'))) {
    console.log('Downloading Electron...');
    if ((await runNode([join(electronPkg, 'install.js')], electronPkg)) !== 0) return 1;
  }
  if (!existsSync(join(APP_DIR, 'out', 'main', 'index.js'))) {
    console.log('Building the window (first run)...');
    const cli = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
    if ((await runNode([cli, 'build'], APP_DIR)) !== 0) return 1;
  }
  const electron = require('electron') as unknown as string;
  const child = spawn(electron, [APP_DIR], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WARBAND_PROJECT: root },
  });
  child.unref();
  console.log(`Warband window opened for ${root}`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  const dirAt = args.indexOf('--dir');
  let root = process.env['INIT_CWD'] ?? process.cwd();
  if (dirAt !== -1) {
    const dir = args[dirAt + 1];
    if (!dir) {
      console.error('--dir needs a path');
      return 2;
    }
    root = dir;
    args.splice(dirAt, 2);
  }
  root = resolve(root);

  const unverifiedAt = args.indexOf('--allow-unverified');
  if (unverifiedAt !== -1) args.splice(unverifiedAt, 1);

  const [command = 'help', sub, extra] = args;
  switch (command) {
    case 'doctor':
      return doctor();
    case 'agent':
      if (sub === 'new') return agentNew(root);
      if (sub === 'list') return agentList(root);
      console.error(`Unknown: agent ${sub ?? ''}\n\n${HELP}`);
      return 2;
    case 'run':
      return run(root, sub, args.slice(2), unverifiedAt !== -1);
    case 'ui':
      return ui(root);
    case 'check':
      return check(root, sub, extra);
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(`warband: ${(err as Error).message}`);
  process.exitCode = 1;
}
