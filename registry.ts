import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRESETS, validateRoles } from './roles.ts';
import type { Roles } from './roles.ts';

test('every preset passes validation', () => {
  for (const [name, roles] of Object.entries(PRESETS)) {
    assert.deepEqual(validateRoles(roles), [], name);
  }
});

test('one CLI for both roles is fine when the models differ', () => {
  const roles: Roles = {
    planner: { runner: 'codex' },
    implementer: { runner: 'codex', model: 'model-a' },
    reviewer: { runner: 'codex', model: 'model-b' },
  };
  assert.deepEqual(validateRoles(roles), []);
});

test('the same CLI and model for implementer and reviewer is rejected', () => {
  const roles: Roles = {
    planner: { runner: 'claude' },
    implementer: { runner: 'claude', model: 'model-a' },
    reviewer: { runner: 'claude', model: 'model-a' },
  };
  assert.equal(validateRoles(roles).length, 1);
});

test('the same CLI without explicit models is rejected, because the difference cannot be shown', () => {
  const roles: Roles = {
    planner: { runner: 'kimi' },
    implementer: { runner: 'kimi' },
    reviewer: { runner: 'kimi', model: 'model-b' },
  };
  assert.match(validateRoles(roles)[0] ?? '', /explicit model/);
});
