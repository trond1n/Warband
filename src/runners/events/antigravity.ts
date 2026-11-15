import { isRecord, str } from '../../core/events.ts';
import type { AgentEvent } from '../../core/events.ts';

/*
 * Antigravity (agy) 1.5.9, `-p --output-format stream-json`.
 * Lines are keyed by `event`, not `type`. Seen: init, step_update, result.
 *
 * Only failed runs have been observed so far (see docs/runners.md), so only
 * `result` with status "ERROR" is mapped. The success shape, assistant text
 * and tool calls are unknown and deliberately produce nothing until a real
 * log shows them.
 */
export function mapAntigravityEvent(data: Record<string, unknown>): AgentEvent[] {
  if (data['event'] !== 'result') return [];
  const result = data['result'];
  if (!isRecord(result) || result['status'] !== 'ERROR') return [];

  const message = str(result['error']) ?? 'unknown error';
  return [
    { kind: 'error', message },
    { kind: 'result', ok: false, text: str(result['response']) ?? '', deniedTools: [] },
  ];
}
