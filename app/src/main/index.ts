import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';

import { configDir, providersFile } from '../../../src/core/providers.ts';
import type { ProviderSettings } from '../../../src/core/providers.ts';
import { NAME_PATTERN } from '../../../src/core/hooks.ts';
import type { HookInput, SkillInput } from '../../../src/core/workspace.ts';
import type { AgentInput } from '../../../src/core/agents.ts';
import type { RunnerId } from '../../../src/core/runner.ts';
import { which } from '../../../src/core/which.ts';
import { git, repoRoot } from '../../../src/engine/git.ts';
import { worktreesHome } from '../../../src/engine/places.ts';
import { RUNNER_IDS } from '../../../src/runners/registry.ts';
import type { AppState, GateDecision, TimedEvent, ToolInfo } from '../shared/api.ts';
import { openablePath, openableRoots, runId, senderAllowed, terminalCommand } from './guards.ts';
import { HookService } from './hooks.ts';
import { AgentService } from './agents.ts';
import { SkillService } from './skills.ts';
import { ProviderService } from './providers.ts';
import { RunManager } from './runs.ts';

/*
 * The main process: one window, the run manager, and IPC. The window runs
 * sandboxed with no Node access; every call below checks its arguments,
 * since the window renders text that came from models.
 */

app.setName('Warband');
const here = dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | undefined;
let reslop: string | undefined;

/*
 * Settings of this machine live in one folder: projects.json here, and
 * providers.json, which `warband doctor` and `warband run` read as well.
 * configDir() is Electron's userData folder for the app name "Warband".
 */
const machineDir = configDir();
const settingsFile = (): string => join(machineDir, 'projects.json');
interface Settings {
  projects: string[];
  current?: string;
}

async function loadSettings(): Promise<Settings> {
  try {
    const data = JSON.parse(await readFile(settingsFile(), 'utf8')) as Partial<Settings>;
    const projects = Array.isArray(data.projects) ? data.projects.filter((p): p is string => typeof p === 'string') : [];
    return { projects, ...(typeof data.current === 'string' ? { current: data.current } : {}) };
  } catch {
    return { projects: [] };
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(dirname(settingsFile()), { recursive: true });
  await writeFile(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
}

let tools: ToolInfo[] = [];
async function detectTools(): Promise<ToolInfo[]> {
  const runners = await Promise.all(
    RUNNER_IDS.map(async (id): Promise<ToolInfo> => {
      const runner = providers.runners[id];
      const d = await runner.detect();
      return { id, name: runner.displayName, found: d.found, ...(d.version ? { version: d.version } : {}), verified: runner.capabilities.verified };
    }),
  );
  reslop = await which('reslop');
  return [...runners, { id: 'reslop', name: 'reslop', found: reslop !== undefined }];
}

async function state(): Promise<AppState> {
  const settings = await loadSettings();
  return { projects: settings.projects, ...(settings.current ? { current: settings.current } : {}), tools };
}

/** Adds a project by its git root and makes it current. */
async function addProject(path: string): Promise<void> {
  const root = (await repoRoot(path)) ?? resolve(path);
  const settings = await loadSettings();
  if (!settings.projects.includes(root)) settings.projects.push(root);
  settings.current = root;
  await saveSettings(settings);
}

async function knownProject(root: unknown): Promise<string> {
  if (typeof root !== 'string') throw new Error('project expected');
  const settings = await loadSettings();
  if (!settings.projects.includes(root)) throw new Error(`unknown project ${root}`);
  return root;
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new Error(`${what} expected`);
  return value;
};

function runnerId(value: unknown): RunnerId {
  if (typeof value !== 'string' || !(RUNNER_IDS as readonly string[]).includes(value)) throw new Error('runner id expected');
  return value as RunnerId;
}

/** Shape and size only; what the values mean is validated by the core on save. */
function providerInput(value: unknown): ProviderSettings {
  const v = value as { binary?: unknown; models?: unknown } | null;
  if (!v || typeof v !== 'object') throw new Error('provider settings expected');
  if (v.binary !== undefined && (typeof v.binary !== 'string' || v.binary.length > 1024)) throw new Error('binary path expected');
  if (!Array.isArray(v.models) || v.models.length > 200 || !v.models.every((m) => typeof m === 'string' && m.length <= 200)) {
    throw new Error('model ids expected');
  }
  return { ...(v.binary !== undefined ? { binary: v.binary } : {}), models: v.models as string[] };
}

/** A hook name, checked before it is used for anything. */
function hookName(value: unknown): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) throw new Error('hook name expected');
  return value;
}

const short = (value: unknown, max: number, what: string): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${what} expected`);
  return value;
};

/** An agent name, checked before it is used for anything. */
function agentName(value: unknown): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) throw new Error('agent name expected');
  return value;
}

/** Shape and size only; names, roles and references are validated by the core. */
function agentInput(value: unknown): AgentInput {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') throw new Error('agent expected');
  const names = (list: unknown, what: string): string[] => {
    if (!Array.isArray(list) || list.length > 200) throw new Error(`${what} expected`);
    return list.map((n) => short(n, 100, what));
  };
  const role = (r: unknown, what: string): { runner: string; model: string } => {
    const x = r as Record<string, unknown> | null;
    if (!x || typeof x !== 'object') throw new Error(`${what} expected`);
    return { runner: short(x['runner'], 40, `${what} runner`), model: short(x['model'], 200, `${what} model`) };
  };
  return {
    name: short(v['name'], 100, 'agent name'),
    description: short(v['description'], 20_000, 'description'),
    skills: names(v['skills'], 'skill names'),
    hooks: names(v['hooks'], 'hook names'),
    ...(v['planner'] === undefined ? {} : { planner: role(v['planner'], 'planner') }),
    implementer: role(v['implementer'], 'implementer'),
    reviewer: role(v['reviewer'], 'reviewer'),
  };
}

/** A skill name, checked before it is used for anything. */
function skillName(value: unknown): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) throw new Error('skill name expected');
  return value;
}

/** Shape and size only; the name and description are validated by the core. */
function skillInput(value: unknown): SkillInput {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') throw new Error('skill expected');
  return {
    name: short(v['name'], 100, 'skill name'),
    description: short(v['description'], 2000, 'description'),
    body: short(v['body'], 1_000_000, 'skill text'),
  };
}

/** Agent names the person confirmed for a rename; each checked like any name before use. */
function agentNames(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 500) throw new Error('agent names expected');
  return value.map((n: unknown) => {
    if (typeof n !== 'string' || !NAME_PATTERN.test(n)) throw new Error('agent name expected');
    return n;
  });
}

/** Shape and size only; names, policy and variables are validated by the core. */
function hookInput(value: unknown): HookInput {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') throw new Error('hook expected');
  const env = v['env'];
  if (!Array.isArray(env) || env.length > 100) throw new Error('environment rows expected');
  const rows = env.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 2) throw new Error('environment row expected');
    return [short(row[0], 200, 'variable name'), short(row[1], 4000, 'variable value')] as const;
  });
  const stage = short(v['stage'], 20, 'stage');
  if (typeof v['reduce'] !== 'boolean') throw new Error('reduce expected');
  return {
    name: short(v['name'], 100, 'hook name'),
    description: short(v['description'], 2000, 'description'),
    run: short(v['run'], 8000, 'command'),
    // An unknown stage reaches the core, which reports it at the field.
    stage,
    env: rows,
    reduce: v['reduce'],
  };
}

function decision(value: unknown): GateDecision {
  const v = value as Partial<GateDecision> | null;
  if (!v || (v.outcome !== 'ok' && v.outcome !== 'changes_requested' && v.outcome !== 'rejected')) throw new Error('decision expected');
  const findings = Array.isArray(v.findings)
    ? v.findings.flatMap((f) =>
        f && typeof f.problem === 'string' && f.problem.trim() !== ''
          ? [{ problem: f.problem, ...(typeof f.where === 'string' && f.where !== '' ? { where: f.where } : {}) }]
          : [],
      )
    : [];
  return {
    outcome: v.outcome,
    ...(typeof v.comment === 'string' && v.comment.trim() !== '' ? { comment: v.comment } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  };
}

/** reslop is full-screen, so it gets its own terminal window. */
function openTerminal(cwd: string, program: string): void {
  const { command, args, verbatim } = terminalCommand(process.platform, cwd, program);
  spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim }).unref();
}

const providers = new ProviderService({
  dir: machineDir,
  // app/out/main -> docs/runners.md of this Warband checkout.
  docsFile: join(here, '../../../docs/runners.md'),
  onRunners: (runners) => manager.useRunners(runners),
  onProbe: (id, state) => window?.webContents.send('warband:probe', id, state),
});

const hooks = new HookService({ reslop: () => reslop });
const skills = new SkillService();
const agents = new AgentService({ providers: () => providers.load(), runners: () => providers.runners });

const manager = new RunManager({
  runners: providers.runners,
  emit(runId: string, event: TimedEvent) {
    window?.webContents.send('warband:event', runId, event);
  },
  notify(title: string, body: string) {
    if (window?.isFocused()) return;
    if (Notification.isSupported()) {
      const n = new Notification({ title, body });
      n.on('click', () => window?.show());
      n.show();
    }
    if (process.platform === 'darwin') app.dock?.bounce();
    else window?.flashFrame(true);
  },
});

/** Every call must come from the main frame of our window, showing the page we loaded. */
function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`warband:${channel}`, (event, ...args) => {
    const frame = event.senderFrame;
    const sender = {
      ourWindow: window !== undefined && !window.isDestroyed() && event.sender === window.webContents,
      frame: frame ? { url: frame.url, isMain: frame === event.sender.mainFrame && frame.parent === null } : null,
    };
    if (!senderAllowed(sender, pageUrl())) throw new Error('unexpected sender');
    return fn(...args);
  });
}

/** The page the window loads: the dev server's in development, the built index.html otherwise. */
const pageUrl = (): string => process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(join(here, '../renderer/index.html')).href;

function registerIpc(): void {
  handle('state', () => state());
  handle('addProject', async () => {
    const picked = await dialog.showOpenDialog(window as BrowserWindow, { properties: ['openDirectory'], title: 'Папка проекта' });
    if (!picked.canceled && picked.filePaths[0]) await addProject(picked.filePaths[0]);
    return state();
  });
  handle('selectProject', async (root) => {
    const settings = await loadSettings();
    settings.current = await knownProject(root);
    await saveSettings(settings);
    return state();
  });
  handle('removeProject', async (root) => {
    const settings = await loadSettings();
    const known = await knownProject(root);
    settings.projects = settings.projects.filter((p) => p !== known);
    if (settings.current === known) delete settings.current;
    await saveSettings(settings);
    return state();
  });
  handle('project', async (root) => manager.project(await knownProject(root)));
  handle('runs', async (root) => manager.runs(await knownProject(root)));
  // Run ids are checked before anything else, since they become folder names.
  handle('run', async (root, id) => {
    const run = runId(id);
    return manager.run(await knownProject(root), run);
  });
  handle('start', async (root, agent, task) => manager.start(await knownProject(root), text(agent, 'agent'), text(task, 'task')));
  handle('cancel', (id) => manager.cancel(runId(id)));
  handle('decide', (id, value) => manager.decide(runId(id), decision(value)));
  handle('answer', (id, answers) => manager.answer(runId(id), text(answers, 'answers')));
  handle('diff', async (root, id) => {
    const run = runId(id);
    return manager.diff(await knownProject(root), run);
  });
  handle('plans', async (root, id) => {
    const run = runId(id);
    return manager.plans(await knownProject(root), run);
  });
  handle('openReslop', async (root, id) => {
    const run = runId(id);
    if (!reslop) return { ok: false, message: 'reslop не установлен: npm i -g reslop' };
    const recorded = await manager.worktree(await knownProject(root), run);
    // The path comes from the run's log on disk, so it is held to the same rule as openPath.
    const worktree = recorded === undefined ? undefined : await openablePath(recorded, [worktreesHome()]);
    if (!worktree) return { ok: false, message: 'worktree прогона уже удалён' };
    openTerminal(worktree, 'reslop');
    return { ok: true };
  });
  handle('merge', async (root, branch) => {
    const project = await knownProject(root);
    const name = text(branch, 'branch');
    if (!/^warband\/[\w.-]+$/.test(name)) throw new Error('only warband/* branches are merged from here');
    const result = await git(project, ['merge', '--no-edit', name]);
    return { ok: result.code === 0, output: [...result.stdout, ...result.stderr].join('\n') };
  });
  handle('providers', () => providers.view());
  handle('saveProvider', async (id, settings, version) => {
    const result = await providers.save(runnerId(id), providerInput(settings), text(version, 'version'));
    if (result.ok) tools = await detectTools();
    return result;
  });
  handle('probe', (id) => providers.probe(runnerId(id)));
  handle('cancelProbe', () => providers.cancelProbe());
  handle('runnerDocs', (section) => providers.docs(text(section, 'section')));
  handle('hooks', async (root) => {
    const project = await knownProject(root);
    watchWorkspace(project);
    return hooks.view(project);
  });
  handle('saveHook', async (root, input, original, version, renameAgents) =>
    hooks.save(await knownProject(root), hookInput(input), original === null ? undefined : hookName(original), text(version, 'version'), agentNames(renameAgents)),
  );
  handle('deleteHook', async (root, name, version) => hooks.remove(await knownProject(root), hookName(name), text(version, 'version')));
  handle('trialRequest', async (root, input) => hooks.request(await knownProject(root), hookInput(input)));
  handle('trialHook', async (root, input, confirmed) => hooks.trial(await knownProject(root), hookInput(input), short(confirmed, 9000, 'confirmed command')));
  handle('cancelTrial', () => hooks.cancelTrial());
  handle('agents', async (root) => {
    const project = await knownProject(root);
    watchWorkspace(project);
    return agents.view(project);
  });
  handle('saveAgent', async (root, input, original, version) =>
    agents.save(await knownProject(root), agentInput(input), original === null ? undefined : agentName(original), text(version, 'version')),
  );
  handle('deleteAgent', async (root, name, version) => agents.remove(await knownProject(root), agentName(name), text(version, 'version')));
  handle('skills', async (root) => {
    const project = await knownProject(root);
    watchWorkspace(project);
    return skills.view(project);
  });
  handle('saveSkill', async (root, input, original, version, renameAgents) =>
    skills.save(await knownProject(root), skillInput(input), original === null ? undefined : skillName(original), text(version, 'version'), agentNames(renameAgents)),
  );
  handle('deleteSkill', async (root, name, version) => skills.remove(await knownProject(root), skillName(name), text(version, 'version')));
  // Only run worktrees and the run logs of known projects; anything else, or a symlink out of them, is refused.
  handle('openPath', async (path) => {
    const target = await openablePath(text(path, 'path'), openableRoots(worktreesHome(), (await loadSettings()).projects));
    if (target === undefined) throw new Error('path outside run worktrees and run logs');
    await shell.openPath(target);
  });
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Warband',
    // app/build/icon.png from out/main; on Windows the .ico has every size the taskbar asks for.
    icon: join(here, '../../build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#15161a',
    show: false,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.on('ready-to-show', () => window?.show());
  window.on('close', (event) => {
    if (manager.activeCount === 0 || quitting) return;
    const choice = dialog.showMessageBoxSync(window as BrowserWindow, {
      type: 'question',
      buttons: ['Остановить и выйти', 'Остаться'],
      defaultId: 1,
      cancelId: 1,
      message: `Идёт прогонов: ${manager.activeCount}. При выходе они будут остановлены.`,
    });
    if (choice !== 0) event.preventDefault();
  });
  window.on('focus', () => window?.flashFrame(false));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  // WARBAND_OPEN_RUN=<run id> opens that run's page at start; WARBAND_OPEN_VIEW=providers, hooks, skills or agents opens that screen.
  const openRun = process.env['WARBAND_OPEN_RUN'];
  const openView = process.env['WARBAND_OPEN_VIEW'];
  const hash = openRun ? `run=${openRun}` : openView === 'providers' || openView === 'hooks' || openView === 'skills' || openView === 'agents' ? `view=${openView}` : '';
  if (devUrl) await window.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  else await window.loadFile(join(here, '../renderer/index.html'), hash ? { hash } : {});

  // WARBAND_SCREENSHOT=<file.png>: save what the window shows after it settles, then quit. For checking the UI.
  const shot = process.env['WARBAND_SCREENSHOT'];
  if (shot) {
    setTimeout(async () => {
      const image = await window?.webContents.capturePage();
      if (image) await writeFile(shot, image.toPNG());
      app.quit();
    }, Number(process.env['WARBAND_SCREENSHOT_DELAY'] ?? 2500));
  }
}

/** Tells the window when providers.json changes on disk, by hand or from `warband` elsewhere. */
async function watchProviders(): Promise<void> {
  await mkdir(machineDir, { recursive: true });
  const name = providersFile(machineDir).slice(machineDir.length + 1);
  let timer: NodeJS.Timeout | undefined;
  watch(machineDir, (_event, file) => {
    if (file !== name) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void providers.load().then(() => {
        manager.useRunners(providers.runners);
        window?.webContents.send('warband:providers-changed');
      });
    }, 200);
  });
}

/*
 * Tells the window when the open project's .warband changes on disk: hooks,
 * agents or skills edited by hand, by the wizard, or by another window.
 * Runs and worktrees under .warband are left out; they change all the time.
 */
let workspaceWatch: { root: string; watcher: FSWatcher } | undefined;
function watchWorkspace(root: string): void {
  if (workspaceWatch?.root === root) return;
  workspaceWatch?.watcher.close();
  workspaceWatch = undefined;
  let timer: NodeJS.Timeout | undefined;
  const changed = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => window?.webContents.send('warband:workspace-changed', root), 200);
  };
  const dir = join(root, '.warband');
  try {
    const watcher = existsSync(dir)
      ? watch(dir, { recursive: true }, (_event, file) => {
          const path = String(file ?? '').replaceAll('\\', '/');
          if (path === 'hooks.json' || path.startsWith('agents') || path.startsWith('skills')) changed();
        })
      : // No .warband yet: wait for it to appear, then watch inside it.
        watch(root, (_event, file) => {
          if (file !== '.warband' || !existsSync(dir)) return;
          workspaceWatch?.watcher.close();
          workspaceWatch = undefined;
          watchWorkspace(root);
          changed();
        });
    workspaceWatch = { root, watcher };
  } catch {
    // A folder that cannot be watched only loses the live refresh.
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(join(here, '../../build/icon.png'));
  await providers.load();
  manager.useRunners(providers.runners);
  await watchProviders();
  tools = await detectTools();
  const initial = process.env['WARBAND_PROJECT'];
  if (initial) await addProject(initial);
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => app.quit());

// Runs live in this process: stop their agents and hooks before quitting, so nothing is left running.
let quitting = false;
app.on('before-quit', (event) => {
  providers.cancelProbe();
  hooks.cancelTrial();
  if (quitting || manager.activeCount === 0) return;
  event.preventDefault();
  quitting = true;
  void manager.cancelAll().finally(() => app.quit());
});
