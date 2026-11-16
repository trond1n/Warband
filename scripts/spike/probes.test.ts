import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RUNNER_IDS, RUNNERS } from '../../src/runners/registry.ts';
import { compareProbes, localCheck, PROBES, RECORDED } from './probes.ts';
import type { ProbeResult } from './probes.ts';

const result = (probe: string, fields: Partial<ProbeResult> = {}): ProbeResult => ({
  CLI: 'Claude Code',
  probe,
  version: '2.1.330',
  'stdout lines': 5,
  'json lines': 5,
  'saw answer': 'yes',
  'file created': '',
  tools: '',
  exit: '0',
  seconds: '4.0',
  cleanup: 'ok',
  ...fields,
});

/** The results the Claude Code adapter was verified with. */
const healthy = (): ProbeResult[] => [
  result('pong'),
  result('write', { 'file created': 'no', 'saw answer': 'yes' }),
  result('read'),
  result('edit', { 'file created': 'yes: "ok"' }),
  result('verdict'),
  result('outside-read', { 'saw answer': 'no' }),
  result('repo-settings', { 'saw answer': 'no' }),
  result('outside-grep', { 'saw answer': 'no' }),
  result('outside-write', { 'file created': 'no', 'saw answer': 'yes' }),
];

test('every verified adapter has recorded results for every probe, seen on its verifiedOn', () => {
  for (const id of RUNNER_IDS) {
    const caps = RUNNERS[id].capabilities;
    if (!caps.verified) continue;
    const recorded = RECORDED[id];
    assert.ok(recorded, id);
    assert.equal(recorded.on, caps.verifiedOn, `${id}: move RECORDED together with verifiedOn`);
    assert.deepEqual(Object.keys(recorded.probes).sort(), PROBES.map((p) => p.name).sort(), id);
  }
});

test('results like the recorded ones pass; tools and timing are not compared', () => {
  const recorded = RECORDED.claude!;
  const results = healthy().map((r) => ({ ...r, tools: 'Read, Bash', seconds: '99.0', 'stdout lines': 1 }));
  assert.deepEqual(compareProbes(results, recorded), []);
  const at = new Date('2026-11-15T10:00:00.000Z');
  assert.deepEqual(localCheck(recorded, '2.1.330 (Claude Code)', results, at), {
    check: { version: '2.1.330 (Claude Code)', at: at.toISOString(), differs: [] },
    mismatches: [],
  });
});

test('a probe with another result is named, with what was expected', () => {
  const results = healthy();
  results[1] = result('write', { 'file created': 'yes: "ok"' });
  results[5] = result('outside-read', { 'saw answer': 'yes', exit: 'timed out after 180s' });
  const check = localCheck(RECORDED.claude, '2.1.330', results);
  assert.deepEqual(check?.check.differs, ['write', 'outside-read']);
  assert.deepEqual(check?.mismatches, [
    { probe: 'write', field: 'file', expected: 'no', actual: 'yes' },
    { probe: 'outside-read', field: 'answer', expected: 'no', actual: 'yes' },
    { probe: 'outside-read', field: 'exit', expected: '0', actual: 'timed out after 180s' },
  ]);
});

test('a partial run, an unknown version or a CLI with nothing recorded is not recorded', () => {
  assert.equal(localCheck(RECORDED.claude, '2.1.330', healthy().slice(0, 4)), undefined);
  assert.equal(localCheck(RECORDED.claude, '', healthy()), undefined);
  assert.equal(localCheck(RECORDED.antigravity, '1.5.9', healthy()), undefined);
});
