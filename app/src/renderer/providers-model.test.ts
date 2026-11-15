import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProbeResult, ProviderProblem } from '../shared/api.ts';
import { adapterLabel, driftText, formOf, isDirty, loginLabel, PROBE_LABEL, probeRow, problemText, settingsOf } from './providers-model.ts';
import { PROBES } from '../../../scripts/spike/probes.ts';

test('the form maps to settings the way the core will store them', () => {
  assert.deepEqual(formOf({ binary: 'C:/claude.exe', models: ['opus', 'sonnet'] }), { binary: 'C:/claude.exe', models: 'opus\nsonnet' });
  assert.deepEqual(settingsOf({ binary: '  ', models: ' opus \r\n\r\nsonnet\n' }), { models: ['opus', 'sonnet'] });
});

test('blank lines and spaces alone do not count as unsaved edits', () => {
  const saved = { models: ['opus'] };
  assert.equal(isDirty({ binary: '', models: 'opus\n\n' }, saved), false);
  assert.equal(isDirty({ binary: ' ', models: ' opus' }, saved), false);
  assert.equal(isDirty({ binary: 'C:/x.exe', models: 'opus' }, saved), true);
  assert.equal(isDirty({ binary: '', models: 'opus\nsonnet' }, saved), true);
});

test('every problem code from the core has a message in the window', () => {
  const codes: ProviderProblem['code'][] = ['binary-relative', 'binary-missing', 'binary-not-file', 'binary-script', 'model-invalid', 'model-duplicate'];
  for (const code of codes) {
    const text = problemText({ field: code.startsWith('binary') ? 'binary' : 'models', code, message: '', model: 'x' });
    assert.ok(text.length > 0, code);
  }
  assert.match(problemText({ field: 'models', code: 'model-duplicate', message: '', model: 'opus' }), /«opus»/);
});

test('login is shown only as the CLI reports it', () => {
  assert.equal(loginLabel({ state: 'in', method: 'claude.ai' }, true), 'выполнен (claude.ai)');
  assert.equal(loginLabel({ state: 'out' }, true), 'не выполнен');
  assert.match(loginLabel({ state: 'unknown' }, true), /^неизвестно/);
  assert.match(loginLabel({ state: 'in' }, false), /^неизвестно/);
});

test('every spike probe has a description, and results read as a table row', () => {
  for (const probe of PROBES) assert.ok(PROBE_LABEL[probe.name], probe.name);
  const result: ProbeResult = {
    CLI: 'Claude Code',
    probe: 'write',
    version: '2.1.325',
    'stdout lines': 9,
    'json lines': 9,
    'saw answer': 'yes',
    'file created': 'no',
    tools: 'Write; denied: Write',
    exit: '0',
    seconds: '5.1',
    cleanup: 'ok',
  };
  assert.deepEqual(probeRow(result), {
    probe: 'write',
    about: PROBE_LABEL['write'],
    answer: 'да',
    file: 'нет',
    tools: 'Write; denied: Write',
    exit: '0',
    seconds: '5.1',
    cleanup: 'ok',
  });
  assert.equal(probeRow({ ...result, 'file created': 'yes: "ok"' }).file, 'да: "ok"');
  assert.equal(probeRow({ ...result, 'file created': '' }).file, '—');
});

test('the card names the verified version and warns when the installed one differs', () => {
  const caps = { transport: 'stream', structuredOutput: true, sandbox: 'agent', headlessApprovals: 'deny', verified: true, verifiedOn: '2.1.325' } as const;
  assert.equal(adapterLabel(caps), 'подтверждён пробами на версии 2.1.325');
  assert.match(adapterLabel({ ...caps, verified: false }), /^не подтверждён/);
  assert.equal(driftText({ kind: 'same', verifiedOn: '2.1.325' }), undefined);
  assert.equal(driftText({ kind: 'none' }), undefined);
  assert.match(driftText({ kind: 'differs', verifiedOn: '2.1.325', installed: '2.1.330', newer: true }) ?? '', /2\.1\.330.*2\.1\.325.*запустите пробы.*не блокирует/);
  assert.match(driftText({ kind: 'differs', verifiedOn: '2.1.325', installed: '2.1.300', newer: false }) ?? '', /установленная старше/);
  assert.match(driftText({ kind: 'unknown', verifiedOn: '2.1.325' }) ?? '', /не сообщил версию/);
});
