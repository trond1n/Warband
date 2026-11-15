# Warband

Warband runs a coding task through fixed stages (clarify → plan → approve → implement → checks → review → accept → finish). It does the work by launching agent CLIs that are already installed: Claude Code, Codex, Antigravity (`agy`) and Kimi Code. It has no agent loop of its own and never touches credentials. See [ADR-0001](docs/adr/0001-orchestrate-official-clis.md).

What each CLI does headless, and which of that is verified, is tracked in [docs/runners.md](docs/runners.md). What was asked for, what is built and what comes next: [docs/overview.md](docs/overview.md).

Requires Node 22.18 or later. The core and the `warband` command run the TypeScript directly, with no build step and no runtime dependencies. The desktop window in `app/` is the exception: it has its own dependencies (Electron, React, Monaco).

```sh
npm install        # dev dependencies only, and puts a `warband` command on PATH
warband help       # in a new terminal, from any folder
```

`npm install` runs `npm link`, so `warband` points at this checkout and code changes apply without reinstalling. Set `WARBAND_NO_LINK=1` to skip that step. To remove the command, run `npm unlink -g warband`.

```sh
npm run doctor     # which CLIs are installed
npm run spike      # real headless probes, raw output in spike-output/
npm test
npx tsc
```

## Agents

An agent is a reusable task such as `/test`:

- what it does, which becomes its instructions;
- the **skills** it follows: Markdown rules such as a coding canon, given to the agent in its prompt;
- the **hooks** that check its work: shell commands run by Warband itself, not by a model, so they cost no tokens. A `setup` hook runs once in the new worktree before any agent, for example `pnpm install`: ignored folders such as `node_modules` are not in a fresh worktree, and a failure stops the run. A `checks` hook runs after implement, and a failure sends the work back. A `finish` hook runs right before the commit. `{warband}` in a command is replaced with the absolute path of the project's `.warband` folder, so a script kept there works from the worktree: `node "{warband}/hooks/lint-changed.mjs"`;
- the **implementer** and **reviewer**, each a CLI and a model. They must differ, for example a cheaper model writes and a stronger one reviews.

```sh
# from the project you want to work on
warband agent new     # step-by-step wizard
warband agent list
warband check test    # run /test's checks and finish hooks here, no model involved
warband run test "Write unit tests for src/sum.js"
```

Everything is saved as plain files in `<project>/.warband/`: `agents/<name>.json`, `skills/<name>.md` and `hooks.json`. They can be edited by hand and committed.

## Running a task

`warband run <agent> "<task>"` takes the task through every stage. The project must be a git repository with at least one commit.

0. **setup**: the worktree is created under `.warband/worktrees/` from the last commit, and the agent's `setup` hooks run in it.
1. **clarify** and **plan**: the reviewer's model reads the code without changing it, may ask you questions, and writes a plan.
2. **approve**: you accept the plan, ask for changes (it is re-planned), or reject it.
3. **implement**: the implementer's model works in its own git worktree under `.warband/worktrees/`, on a new branch `warband/<run>`. It may edit files but cannot run commands.
4. **checks**: the agent's `checks` hooks run in the worktree. A failure goes back to implement, with the output.
5. **review**: the reviewer's model reads the diff and approves or asks for changes, which go back to implement.
6. **accept**: you see the summary, the changed files and the reviewer's comments. You accept, ask for changes, or reject.
7. **finish**: the `finish` hooks run, then the work is committed on the run's branch. Nothing is merged into your branch: `git merge warband/<run>` when you want it.

After 3 reworks the run stops. Your own checkout is never touched, and uncommitted changes in it are not part of the run. A stopped run with changes keeps its worktree so you can look at it. Every event goes to `.warband/runs/<run>/events.jsonl`, and both folders are kept out of `git status` through `.git/info/exclude`.

Only adapters marked verified in `docs/runners.md` may implement. `--allow-unverified` overrides that.

## The window

```sh
warband ui     # from the project folder; builds the window on first use
```

The same runs, in a desktop window (Electron, see [ADR-0002](docs/adr/0002-desktop-window.md)):

- On the left: the project, **New task**, runs waiting for you at a gate, and the history by day. Ctrl+B hides the panel.
- A run has a header with its status, branch and actions (cancel, open the worktree, merge into your branch when it is done), and four tabs: **Timeline** (a bar per stage visit, reworks included), **Log** (agent tool calls and text, hooks, decisions), **Checks** (hook output) and **Review plans**.
- At a gate the run shows the plan, the questions or the change. At acceptance there is a side-by-side diff (Monaco), the reviewer's findings pinned to their lines, and your own comments: click a line number. Comments go back to the implementer as a review plan.
- A notification appears when a gate opens and the window is not in focus.

`npm run dev -w @warband/app` runs the window with hot reload. `WARBAND_SCREENSHOT=<file.png>` saves what the window shows after start and quits, and `WARBAND_OPEN_RUN=<run id>` opens a run's page.

## reslop

[reslop](https://github.com/tshemsedinov/reslop) (`npm i -g reslop`) is used when it is on PATH, in three places:

- **Short check output.** A hook with `"reduce": true` runs as `reslop t -- <command>`. The exit code is the same, and the output that goes back to the implementer is reslop's report of failures instead of the raw log.
- **Review plans.** The reviewer answers with findings in reslop's fields (where, problem, expected, check). When it asks for changes, they are written to `.plan/YYYY-MM-DD-NN.md` in the worktree, in reslop's format, and the implementer is told to work through it and tick it off. Line comments at acceptance become a plan the same way.
- **Review in reslop.** At acceptance, `r` in the terminal (or **Open in reslop** in the window) opens reslop on the change. A plan you write there is picked up when you send the work back.

`.plan/` and `.log/` are never committed by Warband. When the run ends they are copied to `.warband/runs/<run>/plan` and `.warband/runs/<run>/log`.

Layout: `app/` holds the window (main process, preload, React renderer). `src/core/` holds stages, policy, roles, the runner contract, child processes and common events. `src/engine/` holds the run itself, git, prompts, the event log and the terminal view. `src/runners/` holds one adapter per CLI and its event mapper. `src/wizard/` holds the agent wizard. `scripts/` holds the probe, the fixture sanitizer and the install link.
