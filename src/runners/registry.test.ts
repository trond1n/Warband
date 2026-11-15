import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunRequest } from '../core/runner.ts';
import { CLAUDE_TOOLS, claudeArgs } from './registry.ts';

/*
 * The Claude Code arguments are a security boundary (docs/runners.md,
 * "Isolation probes"), so they are pinned here.
 */

const args = (access: RunRequest['access']): readonly string[] =>
  claudeArgs({ prompt: 'p', cwd: '.', timeoutMs: 1, ...(access ? { access } : {}) });

const after = (list: readonly string[], flag: string): string | undefined => list[list.indexOf(flag) + 1];

test('Claude Code: no shell and no MCP servers for any role', () => {
  for (const access of ['read', 'edit', undefined] as const) {
    const list = args(access);
    const tools = (after(list, '--tools') ?? '').split(',');
    assert.ok(!tools.includes('Bash') && !tools.includes('PowerShell'), `no shell for ${access ?? 'default'}`);
    assert.ok(list.includes('--strict-mcp-config'));
    assert.equal(after(list, '--permission-prompts'), 'none');
  }
  assert.equal(after(args('read'), '--tools'), CLAUDE_TOOLS.read.join(','));
  assert.equal(after(args(undefined), '--tools'), 'Read,Glob,Grep', 'read is the default');
  assert.equal(after(args('edit'), '--tools'), 'Read,Glob,Grep,Edit,Write');
  assert.equal(after(args('read'), '--permission-mode'), 'manual');
  assert.equal(after(args('edit'), '--permission-mode'), 'acceptEdits');
});
