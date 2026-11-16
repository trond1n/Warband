<p align="center"><img src="docs/assets/warband-mono.png" width="128" height="128" alt="Warband: a chest with a glowing brain inside"></p>

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

### Providers: settings per machine

A CLI that is not on PATH can be given a full path, and each CLI can have a list of model ids you keep yourself (offered when an agent is set up). These describe the computer, not the project, so they live outside `.warband/`, in `providers.json` in the window's settings folder: `%APPDATA%\Warband` on Windows, `~/Library/Application Support/Warband` on macOS, `$XDG_CONFIG_HOME/Warband` (or `~/.config/Warband`) elsewhere. `WARBAND_CONFIG_DIR` overrides it.

```json
{ "providers": { "antigravity": { "binary": "C:/Users/me/AppData/Local/agy/bin/agy.exe", "models": ["gemini-3-pro"] } } }
```

`warband doctor`, `warband run`, `warband agent new`, `npm run spike` and the window all launch the binary set there. The file holds no keys or logins. Edit it in the window (**Провайдеры**) or by hand. A new CLI cannot be added there: it needs an adapter in code, see [Adding a runner](docs/runners.md#adding-a-runner).

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

0. **setup**: the worktree is created from the last commit in a per-user folder outside the project (`%LOCALAPPDATA%\Warband\wt` on Windows, see [ADR-0003](docs/adr/0003-worktrees-outside-the-project.md); `WARBAND_WORKTREES` overrides it), and the agent's `setup` hooks run in it.
1. **clarify** and **plan**: the reviewer's model reads the code without changing it, may ask you questions, and writes a plan.
2. **approve**: you accept the plan, ask for changes (it is re-planned), or reject it.
3. **implement**: the implementer's model works in that worktree, on a new branch `warband/<run>`. It may edit files but has no shell.
4. **checks**: the agent's `checks` hooks run in the worktree. A failure goes back to implement, with the output.
5. **review**: the reviewer's model reads the diff and approves or asks for changes, which go back to implement.
6. **accept**: you see the summary, the changed files and the reviewer's comments. You accept, ask for changes, or reject.
7. **finish**: the `finish` hooks run, then the work is committed on the run's branch. Nothing is merged into your branch: `git merge warband/<run>` when you want it.

After 3 reworks the run stops. Your own checkout is never touched, and uncommitted changes in it are not part of the run. A stopped run with changes keeps its worktree so you can look at it. Every event goes to `.warband/runs/<run>/events.jsonl`, which is kept out of `git status` through `.git/info/exclude`.

Only adapters marked verified in `docs/runners.md` may implement. `--allow-unverified` overrides that.

A verified adapter records the CLI version it was verified on. CLIs update themselves, so when the installed version is different (any part of it, patch included), the run starts with a warning that suggests running the probes. `warband doctor` and the Providers screen say the same. The run is not blocked.

### Protected paths

The implementer can edit the files that the hooks run: tests, linter config, the scripts in `package.json`, CI. After every implement Warband compares the changed files with a list of protected paths, without a model. Deleted or renamed test files count too. A match does not block the run. It is:

- given to the reviewer as its own section of the prompt;
- shown at acceptance as a separate warning, in the terminal and in the window;
- written to `events.jsonl` as `protected_changes`.

The defaults (`src/core/protected.ts`) cover:

- Warband's own files: `.warband/`;
- package manifests and lock files;
- linter, formatter, TypeScript and test-runner configs;
- Nx and Turbo files;
- CI, git hooks, and agent settings (`.claude/`, `CLAUDE.md`, `AGENTS.md`).

To add patterns, write `.warband/protected.json`:

```json
{ "paths": ["infra/**"], "tests": ["checks/**"], "defaults": true }
```

`"defaults": false` replaces the defaults instead of adding to them. Patterns follow `.gitignore` rules: a pattern without `/` matches at any depth, and a leading `/` anchors it to the root.

## The window

```sh
warband ui     # from the project folder; builds the window on first use
```

The same runs, in a desktop window (Electron, see [ADR-0002](docs/adr/0002-desktop-window.md)):

- On the left: the project, **New task**, the **Setup** section (Настройка), runs waiting for you at a gate, and the history by day. Ctrl+B hides the panel.
- **Providers** (Провайдеры), under Setup, is about this machine rather than the project. There is a card for each CLI Warband has an adapter for. Each card shows whether the CLI is installed, its version, whether the adapter is verified, what is known about its sandbox and headless approvals, and the login state. The login state is shown only when the CLI reports it itself (`claude auth status`); otherwise it reads "unknown". The card's section of `docs/runners.md` opens in place. The path to the binary and the model list are edited there, with the same validation as the core. A settings form warns before you leave with unsaved edits, and if `providers.json` changes on disk while you edit, it says so instead of writing over it. **Проверить** runs the `scripts/spike` probes on that CLI after a warning that they are real model calls and spend subscription quota, and shows their results in a table. The results do not change `verified`, which stays in code. When the installed version differs from the one the adapter was verified on, the card says so and offers to run the probes. A full probe run whose results match the ones the adapter was verified with marks the installed version as checked on this machine (kept in `providers.json`): the card then reads "verified on 2.1.325, probes passed here on X", and neither the card, `doctor` nor a run warn about that version. If any probe differs, the warning stays and names it. Dialogs are modal: while one is open, the rest of the window takes no focus, keys or clicks.
- **Hooks** (Хуки), under Setup, edits the open project's `.warband/hooks.json` one hook at a time: name, description, command, stage (setup, checks, finish), environment variables and `reduce`, with whether reslop is on PATH shown next to it and a note on `{warband}` under the command. The core validates every save with the same rules as `warband agent new`: a command the policy denies is not saved, and the reason is shown at the command field. The file comes out the same as the wizard would write it. Each hook shows the agents that use it. `reduce` works only for the checks stage; on another stage the save is refused with that message at the field, and the person takes the flag off or changes the stage. A used hook cannot be deleted (the dialog lists the agents). Renaming a used hook first lists the agents that use it, then updates the hook and their hook lists as one change: everything is written or nothing is. **Дублировать** makes a copy under a new name. **Пробный запуск** runs the hook as the form has it, in the project checkout, as `warband check` does: a dialog shows the exact command line, folder and variables first, the main process runs only the command that was confirmed, and the run can be stopped. The result shows the exit code, the time and the last lines of output. With `reduce`, reslop records the run in `.log/` of the checkout; after a trial run the files it created there are removed and any old record it rotated away is put back, so the working copy is as before. Other files in `.log/` are not touched.
- A run has a header with its status, branch and actions (cancel, open the worktree, merge into your branch when it is done), and four tabs: **Timeline** (a bar per stage visit, reworks included), **Log** (agent tool calls and text, hooks, decisions), **Checks** (hook output) and **Review plans**.
- At a gate the run shows the plan, the questions or the change. At acceptance there is a side-by-side diff (Monaco), the reviewer's findings pinned to their lines, and your own comments: click a line number. Comments go back to the implementer as a review plan.
- A notification appears when a gate opens and the window is not in focus.

`npm run dev -w @warband/app` runs the window with hot reload. `WARBAND_SCREENSHOT=<file.png>` saves what the window shows after start and quits. `WARBAND_OPEN_RUN=<run id>` opens a run's page, and `WARBAND_OPEN_VIEW=providers` or `hooks` opens that screen.

## reslop

[reslop](https://github.com/tshemsedinov/reslop) (`npm i -g reslop`) is used when it is on PATH, in three places:

- **Short check output.** A hook with `"reduce": true` runs as `reslop t -- <command>`. The exit code is the same, and the output that goes back to the implementer is reslop's report of failures instead of the raw log.
- **Review plans.** The reviewer answers with findings in reslop's fields (where, problem, expected, check). When it asks for changes, they are written to `.plan/YYYY-MM-DD-NN.md` in the worktree, in reslop's format, and the implementer is told to work through it and tick it off. Line comments at acceptance become a plan the same way.
- **Review in reslop.** At acceptance, `r` in the terminal (or **Open in reslop** in the window) opens reslop on the change. A plan you write there is picked up when you send the work back.

`.plan/` and `.log/` are never committed by Warband. When the run ends they are copied to `.warband/runs/<run>/plan` and `.warband/runs/<run>/log`.

Layout: `app/` holds the window (main process, preload, React renderer). `src/core/` holds stages, policy, roles, the runner contract, child processes and common events. `src/engine/` holds the run itself, git, prompts, the event log and the terminal view. `src/runners/` holds one adapter per CLI and its event mapper. `src/wizard/` holds the agent wizard. `scripts/` holds the probe, the fixture sanitizer and the install link.
