import { isRecord, str } from '../../core/events.ts';
import type { AgentEvent } from '../../core/events.ts';

export function mapCodexEvent(data: Record<string, unknown>): AgentEvent[] {
  if (data.type === 'error') {
    return [{ kind: 'error', message: str(data.message) ?? 'Codex reported an error' }];
  }
  if (data.type === 'turn.failed') {
    const message = isRecord(data.error) ? str(data.error.message) : undefined;
    return [{ kind: 'error', message: message ?? 'Codex turn failed' }];
  }
  if (data.type !== 'item.completed' || !isRecord(data.item)) return [];
  const { type, text } = data.item;
  if (type !== 'agent_message' || typeof text !== 'string') return [];
  return [
    { kind: 'assistant_text', text },
    { kind: 'result', ok: true, text, deniedTools: [] },
  ];
}
