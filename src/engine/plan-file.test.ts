import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { findingLine, parsePlan, pendingPlans, readPlans, renderPlan, writePlan } from './plan-file.ts';

test('a plan renders in the reslop layout and parses back', () => {
  const text = renderPlan('Review', [
    { severity: 'high', where: 'a.ts:3', problem: 'Wrong sum. It adds twice.', expected: 'Adds once.', check: ['sum(1,2) is 3'] },
    { problem: 'Name is\nunclear' },
  ]);
  assert.equal(
    text,
    [
      '---',
      'status: editing',
      '---',
      '',
      '# Review',
      '',
      '## Improvements',
      '',
      '- [ ] high: Wrong sum.',
      '  - where: `a.ts:3`',
      '  - problem: Wrong sum. It adds twice.',
      '  - expected: Adds once.',
      '  - check:',
      '    - [ ] sum(1,2) is 3',
      '- [ ] Name is unclear',
      '  - problem: Name is unclear',
      '',
    ].join('\n'),
  );
  const plan = parsePlan('2026-11-15-01.md', text);
  assert.equal(plan.status, 'editing');
  assert.equal(plan.open, 2, 'nested check boxes are not counted as items');
  assert.equal(findingLine({ severity: 'low', where: 'b.ts', problem: 'x' }), 'low: b.ts: x');
});

test('plans are numbered per day; done or empty plans are not pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'warband-plan-'));
  try {
    const day = new Date(2026, 10, 15);
    const first = await writePlan(dir, renderPlan('A', [{ problem: 'p' }]), day);
    const second = await writePlan(dir, renderPlan('B', [{ problem: 'q' }]), day);
    assert.deepEqual([first, second], ['2026-11-15-01.md', '2026-11-15-02.md']);
    const done = (await readFile(join(dir, '.plan', first), 'utf8')).replace('status: editing', 'status: done');
    await writePlan(dir, done, new Date(2026, 10, 16));
    const plans = await readPlans(dir);
    assert.deepEqual(plans.map((p) => p.name), ['2026-11-15-01.md', '2026-11-15-02.md', '2026-11-16-01.md']);
    assert.deepEqual(pendingPlans(plans).map((p) => p.name), ['2026-11-15-01.md', '2026-11-15-02.md']);
    assert.deepEqual(await readPlans(join(dir, 'missing')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
