import { realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hook } from '../core/hooks.ts';
import { saveHooks, warbandDir } from '../core/workspace.ts';
import { excludeLocally, gitOk } from '../engine/git.ts';
import { isInside } from '../engine/places.ts';
import type { HumanGate } from '../engine/run.ts';

/*
 * The only place where Warband answers its own gates (ADR-0004). A bench
 * repository is made here, from a task's setup/, in a new temporary
 * folder; autoGate() takes nothing but such a repository. No path, flag or
 * option turns a person's project into one, so `warband run` and the
 * window cannot get an automatic gate by any argument.
 */

const MADE = new WeakSet<BenchRepo>();
const TOKEN = Symbol('bench repo');

export interface RepoContents {
  /** The task's setup/ folder, copied as the first commit. */
  setup: string;
  /** Skills for .warband/skills/, by name. */
  skills: readonly { name: string; text: string }[];
  /** The bench agent's hooks, written to .warband/hooks.json. */
  hooks: readonly Hook[];
  /** Extra protected paths, written to .warband/protected.json. */
  protectedPaths: readonly string[];
}

export class BenchRepo {
  /** The temporary folder that holds the repository and the run worktrees. */
  readonly home: string;
  /** The repository: setup/ as its first commit, with .warband/ beside it, untracked. */
  readonly root: string;
  readonly worktrees: string;

  constructor(token: symbol, home: string) {
    if (token !== TOKEN) throw new Error('a bench repository is made only by BenchRepo.create');
    this.home = home;
    this.root = join(home, 'repo');
    this.worktrees = join(home, 'wt');
  }

  static async create(contents: RepoContents): Promise<BenchRepo> {
    const repo = new BenchRepo(TOKEN, await mkdtemp(join(tmpdir(), 'warband-bench-')));
    const { root } = repo;
    await cp(contents.setup, root, { recursive: true });
    await gitOk(root, ['init', '--quiet']);
    // Byte-for-byte tasks: no line-ending conversion, whatever the user's git config says.
    await gitOk(root, ['config', 'core.autocrlf', 'false']);
    await gitOk(root, ['config', 'user.email', 'bench@warband.invalid']);
    await gitOk(root, ['config', 'user.name', 'Warband Bench']);
    await gitOk(root, ['config', 'commit.gpgsign', 'false']);
    await gitOk(root, ['add', '-A']);
    await gitOk(root, ['commit', '--quiet', '--no-verify', '-m', 'setup']);
    // The agent's configuration lives beside the code, not in its history.
    await excludeLocally(root, ['.warband/']);
    const skillDir = join(warbandDir(root), 'skills');
    await mkdir(skillDir, { recursive: true });
    for (const skill of contents.skills) await writeFile(join(skillDir, `${skill.name}.md`), skill.text);
    await saveHooks(root, contents.hooks);
    if (contents.protectedPaths.length > 0) {
      await writeFile(join(warbandDir(root), 'protected.json'), `${JSON.stringify({ paths: contents.protectedPaths }, null, 2)}\n`);
    }
    MADE.add(repo);
    return repo;
  }

  async dispose(): Promise<void> {
    await rm(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/**
 * Gates answered without a person: no answers to the planner's questions,
 * the plan approved, the result accepted. Refuses anything but a repository
 * BenchRepo.create made in this process, inside the system temp folder.
 */
export function autoGate(repo: BenchRepo): HumanGate {
  if (!MADE.has(repo)) throw new Error('automatic gates are only for bench repositories');
  const temp = realpathSync(tmpdir());
  const home = realpathSync(repo.home);
  if (!isInside(temp, home) || home === temp) throw new Error(`automatic gates are only for repositories in ${temp}`);
  return {
    answerQuestions: async () => '',
    reviewPlan: async () => ({ outcome: 'ok' }),
    acceptResult: async () => ({ outcome: 'ok' }),
  };
}
