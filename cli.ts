# Runners

What Warband assumes about each CLI when nobody is at the terminal. A row is **confirmed** only after `npm run spike` has been run against a real install and the result written down here with the version. Everything else comes from public docs and issue trackers and may be wrong for your version.

| CLI | Binary | Headless call | Output | Own sandbox | Approvals when headless | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` | `-p <prompt> --output-format stream-json --verbose` | JSON lines | Permission rules and hooks | Assumed denied | Call and output confirmed on 2.1.325 |
| Codex | `codex` | `exec --json <prompt>` | JSON lines | OS-level | Unknown | Unverified |
| Antigravity | `agy` | `-p <prompt> --output-format stream-json` | JSON lines | None assumed | Reported to hang | Unverified |
| Kimi Code | `kimi` | `-p <prompt> --output-format stream-json` | JSON lines | None | Reported to run everything | Unverified |
| GLM | `claude` | Same as Claude Code | Same | Same | Same | No adapter, see below |

## Claude Code

Confirmed on 2.1.325 in a cloud sandbox, not under a subscription login:

- stdout arrives when it is a pipe and stdin is closed.
- Every line is a JSON object with a `type`.
- The final line is `{"type":"result","subtype":"success","result":"...","is_error":false,...}`. `result` holds the final answer.
- `assistant` lines carry a full message. `stream_event` lines carry partial output. `system` lines carry session metadata, including the permission mode.
- Exit code 0 on success.

Still to check: what a tool call that needs approval does in this mode, and how the run is billed under a subscription.

## Codex

Still to check: the exact JSON flag for the installed version, the event schema, and which sandbox and approval settings apply to `exec`.

## Antigravity

Reported problems, to be checked on the installed version before anything else:

- Print mode wrote its answer to the terminal instead of stdout, so a pipe received nothing. Later releases reportedly fixed this.
- A tool call that would ask for approval could stall the run silently instead of failing.

If either still holds, the adapter needs the pseudo-terminal fallback. Only the `agy` CLI can be orchestrated. The Antigravity IDE cannot.

## Kimi Code

- Print mode is reported to request no approvals: tool calls run automatically and only static deny rules apply. Treat every Kimi run as unsandboxed.
- There are two CLIs, an older Python one and a newer TypeScript one, and their flags differ. Record which one the team uses.

## GLM

The GLM coding plan is used through Claude Code by pointing that CLI at a different endpoint in its own configuration. Warband therefore treats GLM as the Claude runner. Open question: how a user selects between an Anthropic login and a GLM configuration for a given role without Warband handling the key.

## Adding a runner

1. Add a spec to `src/runners/registry.ts` with `verified: false`.
2. Run `npm run spike -- <id>` and read `spike-output/<id>.log`.
3. Record the version and the findings here.
4. Map the raw events to common ones.
5. Set `verified: true` once every capability field has been checked.
