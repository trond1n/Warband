# Warband: where the project stands

What was asked for, what is built, how it was checked, and what comes next. Last updated 2026-11-15.

## The idea

One workflow for a coding task, whichever agent CLIs the team has: clarify, plan, a person approves, implement, deterministic checks, review, a person accepts, commit. Warband does not have its own agent loop. It launches the official CLIs (Claude Code, Codex, Antigravity `agy`, Kimi Code) on their subscriptions and never touches credentials ([ADR-0001](adr/0001-orchestrate-official-clis.md)).

## What was asked for, in order

1. **Verify the CLIs headless.** Run `npm run doctor` and `npm run spike`. Check output, format, exit code and hangs for each CLI, taking flags only from `--help`. Add a second probe that creates a file in an empty folder. Record versions and findings in `docs/runners.md`, and mark an adapter verified only when every field is checked. Add a common event layer (assistant text, tool call, question, result, error) with one mapper per CLI, built on fields seen in real logs and tested on sanitized fixtures. Never read credentials, run agents only in empty temporary folders, use no runtime dependencies, and don't commit.
2. **Restore the repository.** Its files had been shuffled under wrong names. They were moved back with `git mv` and the missing ones were rebuilt.
3. **Run `agy` through the `withproxy` wrapper.**
4. **Make it usable.** A wizard in the terminal that creates an **agent** (for example `/test`): what it does, the **skills** it follows (Markdown rules such as a coding canon), the **hooks** that check its work (commands run by code, not a model, so they cost no tokens, like a pre-commit check), and which models write and review it, for example a cheap model writes and Opus reviews.
5. **Put `warband` on PATH at install time.**
6. **Build the engine**, so that `warband run` takes a task through every stage.
7. **Try it on a real project, Teamer.** Write `dev` and `test` agents there and run them.
8. **A desktop window like PurpleFlow's**, built with Electron and React, and **integrate [reslop](https://github.com/tshemsedinov/reslop)**: its short check reports, its review plans, and reviewing in reslop at acceptance.

## What is built

| Area | What it does | Where |
| --- | --- | --- |
| Runner contract and probes | Headless launch, process tree kill, timeouts. Probes `pong`, `write`, `read`, `edit` and `verdict` in temporary folders, with logs in `spike-output/` | `src/core/runner.ts`, `src/core/proc.ts`, `scripts/spike/` |
| Claude Code adapter | Verified on 2.1.325. The prompt goes on stdin. Permissions are pinned (`manual` to read, `acceptEdits` to edit, `--permission-prompts none`), and structured answers use `--json-schema` | `src/runners/registry.ts`, `docs/runners.md` |
| Other adapters | `agy` emits stream-json, but every call is refused ("User location is not supported"). Codex and Kimi are not installed on the probe machine. None of them is verified | `docs/runners.md` |
| Common events | `assistant_text`, `tool_call`, `question`, `result`, `error`, with one mapper per CLI and fixture tests | `src/core/events.ts`, `src/runners/events/` |
| Agents, skills, hooks | Plain files in `<project>/.warband/`. Hooks run at `setup`, `checks` or `finish` and accept `env`, `reduce` (reslop) and `{warband}` in the command | `src/core/agents.ts`, `src/core/hooks.ts`, `src/core/workspace.ts` |
| Wizard | `warband agent new` | `src/wizard/` |
| Engine | `warband run`: a worktree and branch per run, two human gates, reworks capped at 3, cancellation, an event log in `.warband/runs/<run>/events.jsonl`, and a commit on `warband/<run>` | `src/engine/` |
| reslop | Hooks marked `reduce` run through `reslop t`. Reviewer findings and line comments become `.plan/*.md` in reslop's format. Acceptance can open reslop, and its plans go back to the implementer. `.plan/` and `.log/` are archived, never committed | `src/engine/plan-file.ts`, `src/engine/run.ts` |
| Window | `warband ui`: the run list with runs waiting for you, a timeline, the log, checks, review plans, gates with a Monaco diff and line comments, merge, notifications | `app/`, [ADR-0002](adr/0002-desktop-window.md) |
| PATH | `npm install` runs `npm link` | `scripts/link.ts` |

## How it was checked

- 82 tests on `node:test`. The engine and the window's run manager run against real git repositories with scripted agents. `tsc` is clean for the core and the app.
- Real runs on Teamer, a pnpm and Nx monorepo:
  - `/test` added 142 lines of tests to `timer-core`; check, review and commit all passed. It also found a real bug: a paused timer adjusted down to zero never finishes.
  - `/dev` fixed that bug through the window, driven over the DevTools protocol. A line comment went back as a reslop plan, which the implementer ticked off. Prettier failed at checks and the work went back for a fix, then review, acceptance and commit followed.
- Problems that only real runs exposed, all fixed:
  - worktrees had no `node_modules` (fixed by the `setup` hooks);
  - git failed on pnpm's long paths when removing a worktree;
  - an Nx daemon held the worktree open;
  - colour codes leaked into hook output;
  - two runs started in the same second got the same branch;
  - a project hook picked up reslop's `.log/`.

## Known limits

- Claude's read mode still lets through shell commands it considers read-only (`ls`, `cat`). Warband sees tool calls only after they have run, so the worktree decides where the work lands but is not a sandbox.
- Runs live in the process that started them. Closing the window stops them, after a confirmation.
- Agents, skills and hooks are created in the terminal; the window only shows them.
- Opening reslop in an external terminal from the window was not tried by hand, and launching a terminal on macOS or Linux is untested.

## Next

1. **Agent and hook editor in the window.** Create and edit agents (description, skills, hooks, implementer and reviewer models), skills (a Markdown editor) and hooks (command, stage, `env`, `reduce`, a test run with output), with the same validation as the wizard.
2. **Providers in the window, with a proxy per provider.** A screen per CLI shows whether it is installed, its version and whether its adapter is verified, and lets you choose a proxy per provider: none, the system proxy, or address, port, user and password.
   - Login state comes only from asking the CLI itself (ADR-0001).
   - The proxy password is kept in the OS keychain (Electron `safeStorage` or Windows Credential Manager), never in `.warband/`.
   - The CLI gets the proxy as `HTTP(S)_PROXY` in its environment. A local forwarding proxy can carry the authentication, so that no password appears in a child's environment.
   - The first user of this is `agy`, which today needs the `withproxy` wrapper.
3. **[Harbor](https://github.com/harbor-framework/harbor) integration.** Harbor is a Python framework, from the authors of Terminal-Bench, for evaluating agents. A task is a directory with `instruction.md`, `task.toml`, an `environment/` (a Dockerfile) and `tests/test.sh`, which writes a reward. Harbor runs trials in parallel in Docker or cloud sandboxes and already ships `claude-code`, `codex`, `kimi-code` and `antigravity-cli` agents. Two uses for Warband:
   - **Measure Warband's agents.** Run a dataset with a Warband agent as a Harbor custom agent (`BaseAgent`, whose loop runs outside the sandbox and acts through `environment.exec`). This compares role setups such as sonnet+opus against opus alone, or skills against no skills, on the same tasks, by reward.
   - **Turn Teamer tasks into Harbor tasks.** A finished run already has the instruction, the repository at its base commit and the checks, which together make a regression set for agents.

   Open question: Harbor's agents usually authenticate with an API key inside the sandbox. A subscription login would have to reach the container without Warband handling the token, and that has to be solved within ADR-0001 before anything is built.
4. **Finish the adapters.** Verify `agy` once its region error is resolved (the proxy screen helps here), then Codex and Kimi on machines that have them.
5. Smaller items:
   - an in-window terminal for reslop instead of an external one;
   - keep runs alive when the window closes, through a background process;
   - per-agent usage and limits;
   - a timeline that shows what each review returned.
