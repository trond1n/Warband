# Runners

What Warband assumes about each CLI when nobody is at the terminal. A row is **confirmed** only after `npm run spike` has been run against a real install and the result written down here with the version. Everything else comes from public docs and issue trackers and may be wrong for your version.

| CLI | Binary | Headless call | Output | Own sandbox | Approvals when headless | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` | `-p --output-format stream-json --verbose --permission-mode manual|acceptEdits --permission-prompts none [--json-schema]`, prompt on stdin | JSON lines, key `type` | Permission rules (agent level) | Denied at once, run continues | **Verified** on 2.1.325, Windows, subscription login |
| Codex | `codex` | `exec --json <prompt>` | JSON lines | OS-level | Unknown | Unverified, not installed on the probe machine |
| Antigravity | `agy` | `-p <prompt> --output-format stream-json` | JSON lines, key `event` | Unknown, `--sandbox` exists | Unknown | Output confirmed on 1.5.9, no successful run yet |
| Kimi Code | `kimi` | `-p <prompt> --output-format stream-json` | JSON lines | None | Reported to run everything | Unverified, not installed on the probe machine |
| GLM | `claude` | Same as Claude Code | Same | Same | Same | No adapter, see below |

The spike runs two probes per CLI, each in a fresh empty temporary directory:

- **pong**: "Reply with the single word: pong. Do not use any tools."
- **write**: asks the agent to create `warband-probe.txt` containing `ok`. Interactively that tool call would ask for approval. The probe checks the directory afterwards, and that check is the real signal. "saw answer" can be a false positive, because a refusal may contain the word "done".

## Claude Code

Probed 2026-11-15 on **2.1.325**, Windows 11, subscription login (`apiKeySource: "none"`), Node 26.8.1.

Confirmed by running:

- stdout arrives when it is a pipe and stdin is closed. No pseudo-terminal is needed.
- Every stdout line is a JSON object with a `type`. `type` is not the first key, so do not rely on key order.
- Lines seen: `system` with subtype `init`, `commands_changed`, `permission_denied` or `thinking_tokens`; `assistant` (full message, `content[]` of `text`, `tool_use` or `thinking` blocks, with thinking text empty and only a signature); `user` (tool results); `rate_limit_event`; and finally `result`.
- The final line is `{"type":"result","subtype":"success","is_error":false,"result":"...","permission_denials":[...],...}`.
- Exit code 0, about 4–8 s per probe.
- **Approvals depend on the user's settings unless pinned.** With the original args (no permission flags), `init` reported `permissionMode: "auto"`, inherited from the user's own settings, and the write probe **created the file**. Earlier docs said "assumed denied". That was wrong for this setup.
- With `--permission-mode manual`, the write was denied immediately, without a hang. Adding `--permission-prompts none` (from `--help`: "anything that would prompt is denied automatically") gives the same result and states it explicitly. The stream then shows a `tool_use` block, a `system/permission_denied` line, and a `tool_result` with `is_error: true`. The model then explains that it could not do the task.
- **A denied tool does not fail the run.** The result is still `subtype: "success"`, `is_error: false`, with exit code 0. The only machine-readable sign is `result.permission_denials[]` (`tool_name`, `tool_use_id`, `tool_input`). The common `result` event carries it as `deniedTools`.
- The adapter now pins both flags, so a headless Claude run can never write or execute anything that would need approval, whatever the user has configured.

Second round, same version, for the engine:

- **Prompt on stdin.** `claude -p` without a prompt argument reads it from stdin, which is then closed. All five probes ran this way. The adapter needs it because a review prompt carries a diff, and argv is limited to about 32K characters on Windows.
- **read probe** (`manual`): reading a seeded file needed no approval. The `Read` tool ran and the answer was right, so the planner and the reviewer can look at the code.
- **edit probe** (`--permission-mode acceptEdits`): `Write` created the file without approval. The shell command that followed (`PowerShell`, `node --version`) was denied with `system/permission_denied` and listed in `permission_denials`. Exit code 0, no hang. This is the implementer's mode: files yes, commands no. Commands are what hooks are for.
- **Read access still runs read-only shell commands.** In a real `warband run`, the planner in `manual` mode ran `ls -R ... | head -50; cat src/sum.js` through `Bash` with no denial. The reviewer's `node --test` was denied. Claude Code lets commands it considers read-only through without approval, so `read` means "nothing that changes things", not "no shell". Watch for this, as read-only command detection is Claude Code's own judgement.
- **verdict probe** (`--json-schema <schema>`): the model calls a `StructuredOutput` tool, and the `result` line carries the parsed object in `structured_output`, with the same JSON as a string in `result`. The mapper exposes it as `result.structured`.

Not checked:

- How headless runs are metered on a subscription. Each `result` reports `total_cost_usd` and a `rate_limit_event` with window utilisation, but how that maps to subscription quota was not checked.
- The question event. `AskUserQuestion` was never triggered in a headless log, so the mapper emits no `question` events yet.
- Whether `--include-partial-messages` or `--verbose` are needed. Without `--verbose`, stream-json was not tried.
- Whether `acceptEdits` stops writes outside `cwd`. Not tried. The worktree limits where the work lands, but it is not a sandbox: Warband sees tool calls only after they ran, so its policy cannot veto them.

## Codex

Not installed on the probe machine (`codex` not on PATH). Nothing about it is confirmed. Still to check: the exact JSON flag for the installed version, the event schema, and which sandbox and approval settings apply to `exec`.

## Antigravity

Probed 2026-11-15. The binary updated itself during the session, from **1.5.0** to **1.5.9**: `agy.exe` replaced in place, with the old file kept as `agy.exe.<n>.old`. Version pinning matters, and an auto-update can happen between two probes.

Confirmed by running:

- stdout **does** arrive when it is a pipe. The old report that print mode writes to the terminal does not hold on 1.5.9.
- Every stdout line is a JSON object keyed by `event`, not `type`. Lines seen: `init` (`init.cwd`, `init.tools[]`, `init.permission_mode: "request-review"`), `step_update` (`step_index`, `state`, `step_type`), and `result` (`status`, `response`, `error`, `num_turns`, `usage`, `finished_reason`).
- Errors are also written to stderr, once as text and once as `AGY_ERROR: {json}` with `short_error`, `error_code`, `retryable`. The stdout `result` line carries the same message, so stderr is not mapped.
- A failed run exits with code **3**.
- The first probe left a process holding the temporary directory after `agy` exited (`EBUSY` on removal), and later runs did not. The probe now records this as `cleanup: left behind` instead of crashing.

Blocked on the probe machine:

- Plain `agy -p` failed with `plan model not specified; you must specify a valid model`, and `agy models` timed out ("timed out waiting for available models").
- That machine reaches the service only through an HTTP proxy, set by a shell wrapper that exports `HTTP(S)_PROXY`. Run the spike as `<wrapper> npm run spike -- antigravity`. Warband passes the environment through unchanged. With the proxy, `agy models` works in about 2 s, but the model call is still refused: `FAILED_PRECONDITION (code 400): User location is not supported for the API use.` Running `agy` directly from bash, without Warband, gives the same error, so this is account or network state, not the adapter.
- So no successful turn has been seen. Unknown: the shape of assistant text, tool calls and successful results; the write probe; the exit code on success; and whether `--print-timeout` should be set. The mapper handles only `result` with `status: "ERROR"`.

From `--help` (1.5.9), not tried: `--mode` (accept-edits, auto, plan), `--dangerously-skip-permissions`, `--sandbox`, `--print-timeout`, `--model`. From the 1.5.7 changelog: "sessions with no saved mode, including headless `-p` runs, now start in Auto". Expect the approval behaviour to depend on user settings, as it does for Claude Code, until the adapter pins `--mode`.

Only the `agy` CLI can be orchestrated. The Antigravity IDE cannot.

## Kimi Code

Not installed on the probe machine (`kimi` not on PATH). Unconfirmed reports:

- Print mode is reported to request no approvals: tool calls run automatically and only static deny rules apply. Treat every Kimi run as unsandboxed.
- There are two CLIs, an older Python one and a newer TypeScript one, and their flags differ. Record which one the team uses.

## GLM

The GLM coding plan is used through Claude Code by pointing that CLI at a different endpoint in its own configuration. Warband therefore treats GLM as the Claude runner. Open question: how a user selects between an Anthropic login and a GLM configuration for a given role without Warband handling the key.

## Common events

`src/core/events.ts` defines the CLI-independent events: `assistant_text`, `tool_call`, `question`, `result` (`ok`, `text`, `deniedTools`) and `error`. Each CLI has its own mapper in `src/runners/events/<id>.ts`, written only against fields seen in real logs. Anything unrecognised produces nothing. Process outcomes (spawn failure, timeout, non-zero exit) map the same way for every CLI.

Tests run the mappers over fixtures in `src/runners/events/fixtures/`. These are real spike logs passed through `scripts/spike/fixture.ts`, which replaces ids, paths and per-account data.

## Adding a runner

1. Add a spec to `src/runners/registry.ts` with `verified: false`.
2. Run `npm run spike -- <id>` (or `--probe=pong` / `--probe=write`) and read `spike-output/<id>.<probe>.log`. Take flags from `<binary> --help` of the installed version.
3. Record the version and the findings here.
4. Write `src/runners/events/<id>.ts` against what the log shows. Make fixtures with `node scripts/spike/fixture.ts spike-output/<id>.<probe>.log src/runners/events/fixtures/<id>.<probe>.jsonl`, read them, and add tests.
5. Set `verified: true` once every capability field has been checked.
