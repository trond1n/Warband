# ADR-0003. Run worktrees live outside the project

Status: accepted · Date: 2026-11-15

## Context

Every run works in its own git worktree. Until now that worktree was `<project>/.warband/worktrees/<run>`, so the person's real checkout, with `.env` and other untracked files that never go to git, sat three levels above the agent's working directory.

That mattered because of what the agents can do:

- In read mode Claude Code ran shell commands it considers read-only (`ls`, `cat`) without approval (docs/runners.md).
- Whatever an agent reads goes to the model provider.
- Tools that walk up from their working directory (Claude Code's own instruction and settings lookup, package managers, build tools) found the outer project as a parent.

The isolation probes (docs/runners.md, "Isolation probes") showed that on Claude Code 2.1.325 reads and writes outside the working directory are denied, before and after the tool restriction. That is Claude Code's own check. Warband cannot see it before the call, other CLIs have not been probed, and Kimi is reported to have no sandbox at all.

## Decision

Run worktrees live in a per-user data folder, outside every project:

| OS | Folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Warband\wt\<project>-<hash>\<run>` |
| macOS | `~/Library/Application Support/Warband/wt/<project>-<hash>/<run>` |
| Linux and others | `${XDG_STATE_HOME:-~/.local/state}/warband/wt/<project>-<hash>/<run>` |

- `WARBAND_WORKTREES` overrides the folder, for example to put worktrees on a fast disk. A folder inside the project is refused before anything starts.
- `<project>-<hash>` is at most 12 characters of the folder name plus 8 hex characters of a hash of its path. Two projects with the same name do not collide, and the name stays readable.
- The run's record stays in the project: `.warband/runs/<run>/` with `events.jsonl`, archived review plans and check logs. The branch `warband/<run>` is in the project's repository as before; a worktree is only a second checkout of it.
- The engine also pins the Claude Code tool list per role, with no shell and no MCP servers (docs/runners.md). That makes "the agent reads what it can reach through file tools" the whole surface to think about.

### Why this folder

- **Not the system temp folder.** Temp is cleaned by the OS and by disk cleanup tools, and a stopped run keeps its worktree on purpose so the person can look at it.
- **Not a sibling of the project** (`../.warband-worktrees`). The parent of the project usually holds other projects, which would then be one `..` away.
- **Short enough for pnpm on Windows.** On this machine the old place was about 58 characters before `node_modules`, and the new one is about 75. `pnpm install` had already worked in a worktree with a 110-character prefix during the Teamer work. What broke on long paths was `git worktree remove`, and the engine already deletes worktrees with Node's `fs.rm`, which handles long paths, followed by `git worktree prune`.
- **A different drive is fine.** git worktrees can live on another drive than the repository. On Windows the per-user folder is usually on the same drive as the pnpm store, so pnpm can hard-link instead of copy.
- **Per-user, not per-project.** Nothing is written into the project for the worktree, and `.git/info/exclude` now only needs `.warband/runs/`.

## What is not closed

Moving the worktree removes the project from the agent's parent folders. It does not make the project unreachable.

- **Absolute paths still exist.** An agent that knows or guesses the project path, for example from text in the task or the diff, can ask for it. On Claude Code 2.1.325 that read is denied by Claude Code's path check, as the probes show. For other CLIs it is unverified, and for Kimi it is reported to be allowed.
- **Symlinks were not probed.** A repository can commit a symlink that points outside, and the worktree checks it out. On this Windows machine symlinks cannot be created without developer mode (`EPERM`), so the probe could not run here. On Linux and macOS it is open.
- **Hooks run with the person's full rights.** They are the person's own commands from `.warband/hooks.json`, but they run the project's scripts, which the implementer may have changed. Changed protected files are flagged for the reviewer and the person (see docs/overview.md), but not blocked.
- **The probes are single samples** of what a model tried, not proof that no route exists.

A guarantee would need an OS-level sandbox around the CLI process: a container, a separate user, or a seccomp or AppContainer profile. Warband cannot get that from argument parsing or regular expressions, and does not try.
