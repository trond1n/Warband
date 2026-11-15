import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseVersion } from '../core/runner.ts';
import type { RunRequest } from '../core/runner.ts';
import { CLAUDE_TOOLS, claudeArgs, createRunners, parseClaudeLogin, RUNNERS } from './registry.ts';

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

test('a binary set in the machine settings replaces the PATH lookup for that CLI only', () => {
  const runners = createRunners({ claude: { binary: 'D:/tools/claude.exe', models: [] }, kimi: { models: ['k2'] } });
  assert.equal(runners.claude.binary, 'D:/tools/claude.exe');
  assert.equal(runners.kimi.binary, 'kimi');
  assert.equal(runners.antigravity.binary, 'agy');
  assert.equal(RUNNERS.claude.binary, 'claude');
  assert.equal(runners.claude.capabilities.verified, RUNNERS.claude.capabilities.verified);
});

test('only Claude Code reports its login, and only the flag and method are kept', () => {
  assert.ok(RUNNERS.claude.login);
  assert.equal(RUNNERS.codex.login, undefined);
  assert.equal(RUNNERS.antigravity.login, undefined);
  assert.equal(RUNNERS.kimi.login, undefined);
  const status = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.invalid', orgName: 'Org' });
  assert.deepEqual(parseClaudeLogin(status), { state: 'in', method: 'claude.ai' });
  assert.deepEqual(parseClaudeLogin('{"loggedIn": false}'), { state: 'out' });
  assert.deepEqual(parseClaudeLogin('{}'), { state: 'unknown' });
});

test('every verified adapter records the version it was verified on', () => {
  for (const runner of Object.values(RUNNERS)) {
    if (runner.capabilities.verified) assert.ok(parseVersion(runner.capabilities.verifiedOn), runner.id);
  }
});
