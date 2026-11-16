import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { RUN_ID_PATTERN } from '../../../src/core/names.ts';
import { isInside } from '../../../src/engine/places.ts';

/*
 * Checks the main process makes on what the window sends, kept apart from
 * Electron so node:test can cover them. The window renders text that came
 * from models, so nothing it sends is trusted to name a path or a command.
 */

/** A run id as the engine makes it, checked before it reaches any path or map. */
export function runId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || !RUN_ID_PATTERN.test(value)) throw new Error('run id expected');
  return value;
}

/** Folders whose contents the window may open: run worktrees and the run logs of known projects. */
export const openableRoots = (worktrees: string, projects: readonly string[]): string[] => [worktrees, ...projects.map((p) => join(p, '.warband', 'runs'))];

/**
 * The real path of `target` if it lies strictly inside one of `roots`, after symlinks
 * on both sides are resolved; undefined otherwise, or if it does not exist.
 */
export async function openablePath(target: string, roots: readonly string[]): Promise<string | undefined> {
  const real = await realpath(target).catch(() => undefined);
  if (real === undefined) return undefined;
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => undefined);
    // Strictly inside: the folder of all worktrees or of all runs is not one run's.
    if (realRoot !== undefined && relative(realRoot, real) !== '' && isInside(realRoot, real)) return real;
  }
  return undefined;
}

export interface TerminalCommand {
  command: string;
  args: string[];
  /** Windows: pass args as they are; cmd.exe has its own quoting. */
  verbatim: boolean;
}

/**
 * A terminal window running `program` in `cwd`. The folder never becomes part
 * of a command line a shell parses: Windows takes it as the process's working
 * directory, macOS quotes it with AppleScript's `quoted form of`, and other
 * systems hand it to sh as "$1".
 */
export function terminalCommand(platform: NodeJS.Platform, cwd: string, program: string): TerminalCommand {
  if (!/^[\w.-]+$/.test(program)) throw new Error(`program name expected, got ${program}`);
  if (platform === 'win32') {
    // `start` without /D opens the new window in cmd's working directory, which is the spawn cwd.
    return { command: 'cmd.exe', args: ['/d', '/c', `start "${program}" cmd /k ${program}`], verbatim: true };
  }
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: [
        '-e', 'on run argv',
        '-e', `tell application "Terminal" to do script "cd " & quoted form of (item 1 of argv) & " && ${program}"`,
        '-e', 'tell application "Terminal" to activate',
        '-e', 'end run',
        cwd,
      ],
      verbatim: false,
    };
  }
  return { command: 'x-terminal-emulator', args: ['-e', 'sh', '-c', `cd "$1" && ${program}`, 'sh', cwd], verbatim: false };
}

export interface Sender {
  /** event.senderFrame; null once the frame is gone. */
  frame: { url: string; isMain: boolean } | null;
  /** The sender is our window's webContents. */
  ourWindow: boolean;
}

const withoutHash = (url: string): string | undefined => {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
};

/** Only the main frame of our window, showing exactly the page we loaded (any #view or #run). */
export function senderAllowed(sender: Sender, pageUrl: string): boolean {
  if (!sender.ourWindow || !sender.frame || !sender.frame.isMain) return false;
  const got = withoutHash(sender.frame.url);
  return got !== undefined && got === withoutHash(pageUrl);
}
