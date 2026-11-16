import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SkillProblemCode } from '../../../src/core/skills.ts';
import { composeSkill } from '../../../src/core/skills.ts';
import type { SkillInfo } from '../shared/api.ts';
import { blankForm, charsText, formOf, isDirty, problemText, promptNote, sizeOf, textOf } from './skills-model.ts';

const info = (fields: Partial<SkillInfo> = {}): SkillInfo => ({
  name: 'canon',
  description: 'How we write code',
  body: '# Rules\n',
  extra: [],
  file: '.warband/skills/canon.md',
  version: 'v',
  size: 0,
  usedBy: [],
  ...fields,
});

test('the form makes the same file the core writes', () => {
  const form = formOf(info());
  assert.equal(textOf(form), composeSkill('canon', 'How we write code', '# Rules\n'));
  assert.equal(textOf({ ...form, name: ' /Canon ', description: ' How we write code ' }), textOf(form));
  assert.equal(sizeOf(form), textOf(form).trim().length);
  assert.equal(sizeOf(form, ['tags: go']), sizeOf(form) + 'tags: go\n'.length);
});

test('unsaved edits: what the file would be, not keystrokes', () => {
  const saved = info();
  assert.equal(isDirty(formOf(saved), saved), false);
  assert.equal(isDirty({ ...formOf(saved), body: '# Rules' }, saved), false);
  assert.equal(isDirty({ ...formOf(saved), body: '# Rules\n\n- one\n' }, saved), true);
  assert.equal(isDirty({ ...formOf(saved), name: 'style' }, saved), true);
  assert.equal(isDirty(blankForm(), undefined), false);
});

test('sizes and agents read naturally', () => {
  assert.equal(charsText(1), '1 символ');
  assert.equal(charsText(3), '3 символа');
  assert.equal(charsText(11), '11 символов');
  assert.equal(charsText(12345), '12 345 символов');
  assert.match(promptNote(['dev', 'test']), /каждого прогона агентов \/dev, \/test/);
  assert.match(promptNote([]), /не попадает/);
  assert.match(promptNote(undefined), /Не удалось/);
});

test('every problem code from the core has a message', () => {
  const codes: SkillProblemCode[] = ['name-invalid', 'name-taken', 'rename-in-use', 'description-empty', 'description-multiline'];
  for (const code of codes) assert.ok(problemText({ field: 'name', code, message: '' }).length > 0, code);
  assert.match(problemText({ field: 'name', code: 'rename-in-use', agents: ['dev'], message: '' }, 'canon'), /«canon».*\/dev.*обновит ссылки/);
});
