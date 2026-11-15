/*
 * Turns a spike log into a test fixture with nothing personal in it.
 *
 *   node scripts/spike/fixture.ts spike-output/claude.pong.log src/runners/events/fixtures/claude.pong.jsonl
 *
 * Keeps JSON lines only (stderr and plain text are dropped), then:
 *   - ids (session, message, request, tool use, conversation, uuid) become stable placeholders,
 *   - the temporary working directory and the home directory become placeholders,
 *   - per-account lists (tools, skills, MCP servers, slash commands, plugins) are emptied,
 *   - rate-limit details, credential expiry, local paths and thinking signatures are removed.
 * Always read the result before committing it.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const ID_KEYS = new Set([
  'session_id',
  'uuid',
  'id',
  'tool_use_id',
  'request_id',
  'conversation_id',
  'error_id',
  'parent_tool_use_id',
]);
const EMPTIED_KEYS = new Set([
  'tools',
  'mcp_servers',
  'slash_commands',
  'terminal_slash_commands',
  'skills',
  'agents',
  'plugins',
  'commands',
]);
const DROPPED_KEYS = new Set([
  'credential_expires_at',
  'rate_limit_info',
  'resetsAt',
  'timestamp',
  'memory_paths',
  'messaging_socket_path',
  'powershell_path',
]);
/** Whole lines that only describe the local setup. */
const DROPPED_LINES = [(o: Record<string, unknown>) => o['type'] === 'system' && o['subtype'] === 'commands_changed'];

const ids = new Map<string, string>();
const placeholder = (value: string): string => {
  let name = ids.get(value);
  if (!name) {
    name = `<id-${ids.size + 1}>`;
    ids.set(value, name);
  }
  return name;
};

const escape = (text: string): RegExp => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
const TEMP_DIR = /[A-Z]:\\[^"]*?\\Temp\\warband-spike-[a-z]+-[A-Za-z0-9]+/gi;
const HOME = escape(homedir());

const scrubString = (text: string): string => text.replace(TEMP_DIR, '<workdir>').replace(HOME, '<home>');

function scrub(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && ID_KEYS.has(key) && value !== '') return placeholder(value);
    if (key === 'signature') return '<signature>';
    return scrubString(value);
  }
  if (Array.isArray(value)) return key && EMPTIED_KEYS.has(key) ? [] : value.map((item) => scrub(item));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROPPED_KEYS.has(k)) continue;
      out[k] = scrub(v, k);
    }
    return out;
  }
  return value;
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/spike/fixture.ts <spike log> <fixture.jsonl>');
  process.exitCode = 2;
} else {
  const lines = (await readFile(input, 'utf8')).split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    const data = JSON.parse(line) as Record<string, unknown>;
    if (DROPPED_LINES.some((drop) => drop(data))) continue;
    kept.push(JSON.stringify(scrub(data)));
  }
  await writeFile(output, `${kept.join('\n')}\n`);
  console.log(`${output}: ${kept.length} lines`);
}
