# ADR-0001. Orchestrate official CLIs, never touch credentials

Status: accepted · Date: 2026-11-15

## Context

The team uses different agents on different subscriptions: Claude Code with Antigravity, Claude Code with Codex, Codex alone, Kimi, GLM. Nobody uses API keys. We want one workflow for all of them: plan, implement, check, review, with a person at two gates.

There are two ways to build that:

1. **Own agent loop.** Call model APIs directly and implement tools, permissions and context ourselves.
2. **Orchestrator.** Launch the vendor's CLI as a child process and manage only the order of work.

Vendors draw a line around subscription logins. Launching the official binary, which keeps its own cached login, is the supported path. Extracting OAuth tokens or calling the backend from another client is not, and has led to blocked access.

## Decision

Warband is an orchestrator.

- It launches the official binary of each CLI as a child process and talks to it over stdin and stdout.
- It never reads, copies, stores or forwards credentials. It does not open credential files, even to check that a login exists. Login state is learned only by asking the CLI.
- A person starts every task and decides at both gates. Warband does not run unattended batches.
- Concurrency is bounded and usage per agent is visible, so that a subscription is used the way one person would use it.

## Alternatives

**Own agent loop over APIs.** Gives full control of tools and permissions and a uniform event model. Rejected for this project because it needs API keys the team does not have, and it would replace the agents people already know.

**Driving the interactive terminal UI through a pseudo-terminal as the main channel.** Works the same for every CLI, but means parsing screen output that changes with every release. Kept only as a fallback for a CLI whose structured mode is broken.

## Consequences

- Each CLI needs an adapter, and headless behaviour differs between them: output format, approvals, sandboxing. `docs/runners.md` tracks this and `npm run spike` checks it.
- Warband sees only what a CLI chooses to report. Where a CLI does not expose tool calls before running them, the policy layer cannot veto them, and isolation has to come from the worktree and the CLI's own sandbox.
- How vendors meter headless use on a subscription changes over time. Role assignment is configurable so that work can be moved to whichever agent has room.
- GLM needs no adapter: its coding plan plugs into Claude Code through that CLI's own configuration. Warband does not manage that configuration.
