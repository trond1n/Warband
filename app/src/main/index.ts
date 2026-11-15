import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';

import { which } from '../../../src/core/which.ts';
import { git, repoRoot } from '../../../src/engine/git.ts';
import { RUNNER_IDS, RUNNERS } from '../../../src/runners/registry.ts';
import type { AppState, GateDecision, TimedEvent, ToolInfo } from '../shared/api.ts';
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

const settingsFile = (): string => join(app.getPath('userData'), 'projects.json');
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
      const runner = RUNNERS[id];
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
  const opts = { cwd, detached: true, stdio: 'ignore' as const };
  let child;
  if (process.platform === 'win32') {
    child = spawn('cmd.exe', ['/d', '/c', `start "reslop" /D "${cwd}" cmd /k ${program}`], { ...opts, windowsVerbatimArguments: true });
  } else if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "cd ${JSON.stringify(cwd).slice(1, -1)} && ${program}"`;
    child = spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], opts);
  } else {
    child = spawn('x-terminal-emulator', ['-e', 'sh', '-c', `cd "$1" && ${program}`, 'sh', cwd], opts);
  }
  child.unref();
}

const manager = new RunManager({
  runners: RUNNERS,
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

function handle(channel: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`warband:${channel}`, (event, ...args) => {
    if (event.senderFrame?.url && !event.senderFrame.url.startsWith(rendererOrigin())) throw new Error('unexpected sender');
    return fn(...args);
  });
}

const rendererOrigin = (): string => (process.env['ELECTRON_RENDERER_URL'] ? new URL(process.env['ELECTRON_RENDERER_URL']).origin : 'file://');

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
  handle('run', async (root, runId) => manager.run(await knownProject(root), text(runId, 'run id')));
  handle('start', async (root, agent, task) => manager.start(await knownProject(root), text(agent, 'agent'), text(task, 'task')));
  handle('cancel', (runId) => manager.cancel(text(runId, 'run id')));
  handle('decide', (runId, value) => manager.decide(text(runId, 'run id'), decision(value)));
  handle('answer', (runId, answers) => manager.answer(text(runId, 'run id'), text(answers, 'answers')));
  handle('diff', async (root, runId) => manager.diff(await knownProject(root), text(runId, 'run id')));
  handle('plans', async (root, runId) => manager.plans(await knownProject(root), text(runId, 'run id')));
  handle('openReslop', async (root, runId) => {
    if (!reslop) return { ok: false, message: 'reslop не установлен: npm i -g reslop' };
    const worktree = await manager.worktree(await knownProject(root), text(runId, 'run id'));
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
  handle('openPath', async (path) => {
    const target = text(path, 'path');
    if (existsSync(target)) await shell.openPath(target);
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
  // WARBAND_OPEN_RUN=<run id> opens that run's page at start.
  const hash = process.env['WARBAND_OPEN_RUN'] ? `run=${process.env['WARBAND_OPEN_RUN']}` : '';
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

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(join(here, '../../build/icon.png'));
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
  if (quitting || manager.activeCount === 0) return;
  event.preventDefault();
  quitting = true;
  void manager.cancelAll().finally(() => app.quit());
});
