import { isRecord, str } from '../../core/events.ts';
import type { AgentEvent } from '../../core/events.ts';

/*
 * Claude Code 2.1.325, `-p --output-format stream-json --verbose`.
 * Line types seen: system (init, commands_changed, permission_denied,
 * thinking_tokens), assistant, user, rate_limit_event, result.
 *
 * Mapped:
 *   assistant.message.content[]  text -> assistant_text, tool_use -> tool_call
 *   result                       -> result (subtype, is_error, result, permission_denials,
 *                                   structured_output when --json-schema was given)
 *
 * Not mapped: `user` lines carry tool results, `system/permission_denied`
 * is repeated in result.permission_denials, thinking blocks arrive empty.
 * No question event: AskUserQuestion was never seen in a headless log.
 */
export function mapClaudeEvent(data: Record<string, unknown>): AgentEvent[] {
  if (data['type'] === 'assistant') {
    const message = data['message'];
    const content = isRecord(message) ? message['content'] : undefined;
    if (!Array.isArray(content)) return [];
    const events: AgentEvent[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      const text = str(block['text']);
      const name = str(block['name']);
      if (block['type'] === 'text' && text) {
        events.push({ kind: 'assistant_text', text });
      } else if (block['type'] === 'tool_use' && name) {
        const id = str(block['id']);
        events.push({ kind: 'tool_call', ...(id ? { id } : {}), name, input: block['input'] });
      }
    }
    return events;
  }

  if (data['type'] === 'result') {
    const denials = Array.isArray(data['permission_denials']) ? data['permission_denials'] : [];
    return [
      {
        kind: 'result',
        ok: data['subtype'] === 'success' && data['is_error'] === false,
        text: str(data['result']) ?? '',
        deniedTools: denials.flatMap((denial) =>
          isRecord(denial) && typeof denial['tool_name'] === 'string' ? [denial['tool_name']] : [],
        ),
        ...('structured_output' in data ? { structured: data['structured_output'] } : {}),
      },
    ];
  }

  return [];
}
