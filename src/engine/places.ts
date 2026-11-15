import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

/*
 * Where run worktrees live: outside the project tree, so the project
 * checkout (with its .env and other untracked files) is not an ancestor of
 * any agent's working directory. See docs/adr/0003-worktrees-outside-the-project.md.
 */

/** The folder that holds every project's worktrees. */
export function worktreesHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const override = env['WARBAND_WORKTREES'];
  if (override && override.trim() !== '') return resolve(override);
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'Warband', 'wt');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Warband', 'wt');
  return join(env['XDG_STATE_HOME'] ?? join(home, '.local', 'state'), 'warband', 'wt');
}

/**
 * A short, stable folder name per project: readable, and unique per path.
 * Short on purpose, because pnpm's node_modules paths are long.
 */
export function projectKey(root: string): string {
  const name = basename(root).replace(/[^\w.-]+/g, '-').slice(0, 12) || 'project';
  const hash = createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The worktree of one run. Refuses a place inside the project. */
export function worktreePath(root: string, runId: string, home: string = worktreesHome()): string {
  const path = join(home, projectKey(root), runId);
  if (isInside(root, path)) {
    throw new Error(`worktrees must be outside the project, but ${path} is inside ${root} (check WARBAND_WORKTREES)`);
  }
  return path;
}
