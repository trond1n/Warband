import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { runProcess } from '../core/proc.ts';

export interface GitResult {
  code: number | null;
  stdout: string[];
  stderr: string[];
}

export async function git(cwd: string, args: readonly string[], timeoutMs = 120_000): Promise<GitResult> {
  const result: GitResult = { code: null, stdout: [], stderr: [] };
  for await (const event of runProcess('git', args, { cwd, timeoutMs })) {
    if (event.type === 'stdout') result.stdout.push(event.line);
    else if (event.type === 'stderr') result.stderr.push(event.line);
    else if (event.type === 'exit') result.code = event.timedOut ? null : event.code;
    else if (event.type === 'spawn_error') result.stderr.push(event.message);
  }
  return result;
}

/** Runs git and throws with its stderr when it fails. */
export async function gitOk(cwd: string, args: readonly string[]): Promise<string[]> {
  const result = await git(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.join(' ').trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ['rev-parse', '--show-toplevel']);
  return result.code === 0 && result.stdout[0] ? resolve(result.stdout[0]) : undefined;
}

export async function headCommit(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
  return result.code === 0 ? result.stdout[0] : undefined;
}

/** Uncommitted changes in the main checkout, ignoring Warband's own files. */
export async function uncommitted(cwd: string): Promise<string[]> {
  return (await gitOk(cwd, ['status', '--porcelain'])).filter((line) => !/\s"?\.warband\//.test(line));
}

/**
 * Keeps Warband's working files out of `git status` without touching the
 * project's .gitignore: patterns go to the repository's local exclude file.
 */
export async function excludeLocally(cwd: string, patterns: readonly string[]): Promise<void> {
  const [commonDir] = await gitOk(cwd, ['rev-parse', '--git-common-dir']);
  if (!commonDir) return;
  const file = join(isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir), 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    await mkdir(dirname(file), { recursive: true });
  }
  const lines = current.split(/\r?\n/);
  const missing = patterns.filter((p) => !lines.includes(p));
  if (missing.length === 0) return;
  const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${prefix}# Warband working files\n${missing.join('\n')}\n`);
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  return (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

export async function addWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  await gitOk(root, ['worktree', 'add', '-b', branch, path, base]);
}

/**
 * Deletes the folder with Node, not `git worktree remove`: on Windows git
 * fails with "Filename too long" inside a pnpm node_modules, while Node's
 * fs handles long paths. Then git forgets the worktree.
 */
export async function removeWorktree(root: string, path: string, deleteBranch?: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
  await git(root, ['worktree', 'prune']);
  if (deleteBranch) await git(root, ['branch', '-D', deleteBranch]);
}

/**
 * Working folders that are never staged or committed: `.plan/` holds review
 * plans (the reslop format) and `.log/` holds reslop's check logs. The engine
 * archives them with the run instead.
 */
export const UNSTAGED_DIRS = ['.plan', '.log'] as const;
const stageAll = (worktree: string): Promise<string[]> =>
  gitOk(worktree, ['add', '-A', '--', '.', ...UNSTAGED_DIRS.map((dir) => `:(exclude)${dir}`)]);

/** Stages everything in the worktree and returns the diff against `base`. */
export async function stagedDiff(worktree: string, base: string): Promise<{ diff: string; stat: string[] }> {
  await stageAll(worktree);
  const diff = (await gitOk(worktree, ['diff', '--cached', base])).join('\n');
  const stat = await gitOk(worktree, ['diff', '--cached', '--stat', base]);
  return { diff, stat };
}

/**
 * Commits everything staged. When nothing is left to commit, because the
 * person already committed it on the branch (from reslop, say), returns HEAD.
 */
export async function commitAll(worktree: string, message: string): Promise<string> {
  await stageAll(worktree);
  const pending = await git(worktree, ['diff', '--cached', '--quiet']);
  if (pending.code !== 0) await gitOk(worktree, ['commit', '--quiet', '-m', message]);
  const [sha] = await gitOk(worktree, ['rev-parse', 'HEAD']);
  return sha ?? '';
}
