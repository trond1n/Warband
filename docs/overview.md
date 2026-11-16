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
9. **Close three security problems from review**, before any new feature:
   - the worktree must not give access to the main checkout;
   - the implementer must not quietly weaken the checks;
   - diffs and hook output are data, not instructions.

## What is built

| Area | What it does | Where |
| --- | --- | --- |
| Runner contract and probes | Headless launch, process tree kill, timeouts. Probes `pong`, `write`, `read`, `edit`, `verdict`, and the isolation probes `outside-read`, `outside-grep`, `repo-settings` and `outside-write`, all in temporary folders, with logs in `spike-output/` | `src/core/runner.ts`, `src/core/proc.ts`, `scripts/spike/` |
| Claude Code adapter | Verified on 2.1.325. The prompt goes on stdin. Permissions are pinned (`manual` to read, `acceptEdits` to edit, `--permission-prompts none`). The tool list is pinned per role with no shell (`--tools`), and no MCP servers are loaded (`--strict-mcp-config`). Structured answers use `--json-schema` | `src/runners/registry.ts`, `docs/runners.md` |
| Other adapters | `agy` emits stream-json, but every call is refused ("User location is not supported"). Codex and Kimi are not installed on the probe machine. None of them is verified | `docs/runners.md` |
| Common events | `assistant_text`, `tool_call`, `question`, `result`, `error`, with one mapper per CLI and fixture tests | `src/core/events.ts`, `src/runners/events/` |
| Agents, skills, hooks | Plain files in `<project>/.warband/`. Hooks run at `setup`, `checks` or `finish` and accept `env`, `reduce` (reslop) and `{warband}` in the command | `src/core/agents.ts`, `src/core/hooks.ts`, `src/core/workspace.ts` |
| Wizard | `warband agent new`; models offered are the Providers screen's list | `src/wizard/` |
| Engine | `warband run`: a worktree and branch per run, in a per-user folder outside the project ([ADR-0003](adr/0003-worktrees-outside-the-project.md)). Two human gates, reworks capped at 3, cancellation, an event log in `.warband/runs/<run>/events.jsonl` (run_started has the sha256 of each skill used), and a commit on `warband/<run>` | `src/engine/` |
| Protected paths | After every implement the changed files are compared with glob patterns, without a model: configs, manifests, lock files, CI, agent settings, `.warband/`, plus deleted or renamed tests. Matches go to the reviewer, to the accept gate and to the log; they do not block | `src/core/protected.ts`, `.warband/protected.json` |
| Untrusted material in prompts | The task, answers, diffs, check output, review plans and model-written summaries are fenced with per-prompt markers, and the prompt says that nothing inside is an instruction | `src/engine/prompts.ts` |
| reslop | Hooks marked `reduce` run through `reslop t`. Reviewer findings and line comments become `.plan/*.md` in reslop's format. Acceptance can open reslop, and its plans go back to the implementer. `.plan/` and `.log/` are archived, never committed | `src/engine/plan-file.ts`, `src/engine/run.ts` |
| Window | `warband ui`: the run list with runs waiting for you, a timeline, the log, checks, review plans, gates with a Monaco diff and line comments, merge, notifications | `app/`, [ADR-0002](adr/0002-desktop-window.md) |
| PATH | `npm install` runs `npm link` | `scripts/link.ts` |
| Providers (per machine) | `providers.json` in the app settings folder: a binary path per CLI and a model list kept by hand. The engine, `doctor`, the wizard and the spike use the path. The window's **Провайдеры** screen shows each CLI's state, adapter, sandbox, approvals and login state (only as the CLI reports it), edits the settings with the core's validation, and runs the spike probes after a quota warning. A verified adapter records the CLI version it was verified on (`verifiedOn`); a different installed version is reported on the card, by `doctor` and at the start of a run, without blocking. A full probe run that matches the recorded results (`RECORDED` in `scripts/spike/probes.ts`) marks the installed version as checked on this machine, and it is no longer reported | `src/core/providers.ts`, `src/runners/registry.ts`, `app/src/main/providers.ts`, `app/src/renderer/Providers.tsx` |
| Hooks in the window | The **Хуки** screen edits `.warband/hooks.json` through `saveHook`/`deleteHook` in `src/core/workspace.ts`, with problems as codes (`checkHook`) shown in Russian at their fields. A hook used by agents is not deleted; renaming it, once the person confirms the list of agents, rewrites hooks.json and those agent files through `commitFiles`, all or nothing. `reduce` outside the checks stage is a problem (`reduce-stage`) in the core, so the wizard and the window refuse it the same way. A trial run takes two calls: the main process returns the exact command line, the window shows it in a modal, and the hook runs only if the confirmed command is still what would run. It runs in the checkout like `warband check` and can be stopped. With `reduce`, `runHook(..., { inCheckout: true })` takes back what reslop added to `.log/` and puts back records it rotated away (`src/core/reslop-logs.ts`); `warband check` runs hooks the same way. In a task worktree `.log/` is kept for the run archive | `src/core/hooks.ts`, `src/core/workspace.ts`, `src/core/reslop-logs.ts`, `app/src/main/hooks.ts`, `app/src/renderer/Hooks.tsx` |
| Skills in the window | The **Скиллы** screen edits `.warband/skills/*.md` through `saveSkill`/`deleteSkill`. The file format (front matter, body, size in the prompt) is in `src/core/skills.ts`, which has no Node imports so the window computes the size of what it will save. Monaco for the body, the Markdown component for the preview. Rename moves the file and updates agents through `commitFiles`, like hooks | `src/core/skills.ts`, `src/core/workspace.ts`, `app/src/main/skills.ts`, `app/src/renderer/Skills.tsx` |
| Agents in the window | The **Агенты** screen edits `.warband/agents/*.json` through `saveAgentInput`/`deleteAgent`. `agentFromInput` makes the object the wizard makes; `checkAgent` and `checkRoles` (no Node imports) give problems by field, the role rule live in the form. Models come from `modelChoices` (providers.json), the same list as the wizard. A skill or hook made from the form returns to it through a draft kept in the window | `src/core/agents.ts`, `src/core/roles.ts`, `src/core/workspace.ts`, `app/src/main/agents.ts`, `app/src/renderer/Agents.tsx` |

## How it was checked

- 201 tests on `node:test`. The engine and the window's run manager run against real git repositories with scripted agents. The providers settings and the Providers screen's service run against temporary settings folders with scripted CLIs and probes; the hooks and skills functions and the Hooks and Skills screens' services, trial runs included, against temporary project folders. `tsc` is clean for the core and the app.
- Isolation probes on Claude Code 2.1.325 (docs/runners.md):
  - **before** the tool restriction, a shell `cat ../file` in read mode and a `Write` outside cwd in edit mode were both denied by Claude Code's own path check;
  - **after** it, read and grep outside cwd, a committed `.claude/settings.json` that allows the parent, and a write outside cwd were all denied as well;
  - the ordinary probes still pass.
- Real runs on Teamer, a pnpm and Nx monorepo:
  - `/test` added 142 lines of tests to `timer-core`; check, review and commit all passed. It also found a real bug: a paused timer adjusted down to zero never finishes.
  - `/dev` fixed that bug through the window, driven over the DevTools protocol. A line comment went back as a reslop plan, which the implementer ticked off. Prettier failed at checks and the work went back for a fix, then review, acceptance and commit followed.
  - `/test` ran again after the security work, with its worktree in `%LOCALAPPDATA%\Warband\wt\Teamer-de23f1ca\`, outside the project. It added 82 lines of boundary tests to `libs/ui`, and the setup, check (through reslop) and format hooks passed. The protected-paths check found nothing, no tool was denied, and the commit landed on `warband/test-20261115-174416`. The worktree was removed afterwards. The run found another product bug: `formatInfusions({ min: 0.4 })` returns `'0 раз'` instead of `null`.
- Problems that only real runs exposed, all fixed:
  - worktrees had no `node_modules` (fixed by the `setup` hooks);
  - git failed on pnpm's long paths when removing a worktree;
  - an Nx daemon held the worktree open;
  - colour codes leaked into hook output;
  - two runs started in the same second got the same branch;
  - a project hook picked up reslop's `.log/`.

## Known limits

- **No OS-level sandbox.** Keeping agents out of the project checkout rests on three things:
  - the worktree lives outside the project;
  - the Claude Code tool list has no shell;
  - Claude Code's own path check.

  Warband sees tool calls only after they have run, so it cannot veto them. An absolute path can still be asked for. Symlinks from the repository were not probed, because this Windows machine cannot create them. Other CLIs have not been probed at all. Closing this needs a container, a separate user or a similar OS sandbox, and is not attempted with argument filters or regular expressions (ADR-0003).
- **Protected paths are flagged, not enforced.** The reviewer and the person see the list, but a run that weakens a check is not stopped by Warband. The checks themselves run the project's scripts with the person's rights.
- **Fenced prompts are a convention, not a guarantee.** Tests check that the prompt is assembled correctly, with untrusted material inside blocks it cannot close (`src/engine/prompts.test.ts`, with an injection fixture). Whether a model follows the instruction not to obey text inside the blocks no test can show.
- Runs live in the process that started them. Closing the window stops them, after a confirmation.
- Project setup in the window is done: **Providers**, **Agents**, **Skills** and **Hooks**; the old read-only project page is gone. A run from the window still refuses an implementer with an unverified adapter, as the agent form warns; there is no `--allow-unverified` in the window.
- Saving an agent from the window writes it in the wizard's layout; a hand-formatted agent file is re-laid out on its first save there (a rename of a skill or hook still changes only the name).
- Renaming a hook or a skill rewrites the agent files that list it with only the name changed in their list; a file laid out in a way that edit cannot follow is written anew in the wizard's layout. The change is all or nothing against errors, not against a power cut in the middle.
- A hook's trial run executes an arbitrary command in the project checkout with the person's rights, not in a worktree, as `warband check` does. The confirmation shows the exact command line; the policy check before it is the same regex check as everywhere else, not a sandbox.
- Login state is known only for Claude Code. `agy` has no status command, and Codex and Kimi were not tried.
- Opening reslop in an external terminal from the window was not tried by hand, and launching a terminal on macOS or Linux is untested.

## Next

1. **A proxy per provider.** The Providers screen is built, without proxies, which were left out on purpose for now. If they come back: none, the system proxy, or an address with a user and password kept in the OS keychain, never in `.warband/`, passed to the CLI as `HTTP(S)_PROXY`. The first user would be `agy`, which today needs the `withproxy` wrapper.
2. **[Harbor](https://github.com/harbor-framework/harbor) integration.** Harbor is a Python framework, from the authors of Terminal-Bench, for evaluating agents. A task is a directory with `instruction.md`, `task.toml`, an `environment/` (a Dockerfile) and `tests/test.sh`, which writes a reward. Harbor runs trials in parallel in Docker or cloud sandboxes and already ships `claude-code`, `codex`, `kimi-code` and `antigravity-cli` agents. Two uses for Warband:
   - **Measure Warband's agents.** Run a dataset with a Warband agent as a Harbor custom agent (`BaseAgent`, whose loop runs outside the sandbox and acts through `environment.exec`). This compares role setups such as sonnet+opus against opus alone, or skills against no skills, on the same tasks, by reward.
   - **Turn Teamer tasks into Harbor tasks.** A finished run already has the instruction, the repository at its base commit and the checks, which together make a regression set for agents.

   Open question: Harbor's agents usually authenticate with an API key inside the sandbox. A subscription login would have to reach the container without Warband handling the token, and that has to be solved within ADR-0001 before anything is built.
3. **Finish the adapters.** Verify `agy` once its region error is resolved (the proxy screen helps here), then Codex and Kimi on machines that have them.
4. Smaller items:
   - an in-window terminal for reslop instead of an external one;
   - keep runs alive when the window closes, through a background process;
   - per-agent usage and limits;
   - a timeline that shows what each review returned.
