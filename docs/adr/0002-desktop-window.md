# ADR-0002. A desktop window on Electron, beside a dependency-free core

Status: accepted · Date: 2026-11-15

## Context

Runs were driven from the terminal: text events, and y/c/n at the gates. Reviewing a diff, leaving comments on lines and following several runs at once is hard there. The person asked for a window like PurpleFlow's: runs on the left, a timeline of stages, a log, and gates with a real diff view. They chose Electron with React over a local web page served by Node, accepting the dependencies that come with it.

The core had a rule: no runtime dependencies, run by Node directly.

## Decision

- The window is a separate workspace package, `app/` (Electron, electron-vite, React, Monaco). Its dependencies stay there.
- The core in `src/` keeps the old rule. `warband` on the command line still needs nothing but Node.
- The window uses the same engine as `warband run`, in Electron's main process (`app/src/main/runs.ts`). It adds no stage logic of its own: it renders `EngineEvent`s and answers the `HumanGate`.
- The window is sandboxed: `contextIsolation`, `sandbox`, no Node. It reaches the main process only through `window.warband` (`app/src/shared/api.ts`). Every IPC call checks its arguments and accepts only known projects, because the window shows text written by models. A call must come from the main frame of the Warband window showing the page it loaded. Run ids must have the engine's shape before they reach a path. The window can open only folders inside run worktrees and the run logs of known projects, after symlinks are resolved. A terminal for reslop gets the worktree as its working directory or as an argument, never inside a command line a shell parses. These checks live in `app/src/main/guards.ts`. Markdown is rendered to React elements, never set as HTML.
- `warband ui` builds the window on first use and opens it for the current project.

## Consequences

- `npm install` downloads Electron (about 100 MB). npm may skip Electron's install script; `warband ui` runs it when the binary is missing.
- Monaco brings DOMPurify, pinned by `overrides` to a version without known advisories.
- Runs live in the window's process. Closing the window stops them, after a confirmation. A run whose process ended without a `run_finished` event shows as interrupted.
