import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkSkill, composeSkill, promptSize, splitSkill } from './skills.ts';
import { parseFrontMatter } from './workspace.ts';

test('a skill file splits into front matter and body, and composes back to the same text', () => {
  // What createSkill writes for the wizard.
  const wizard = '---\nname: canon\ndescription: How we write code\n---\n\n<!-- Write the rules this skill stands for. The whole file is given to the agent. -->\n';
  const parts = splitSkill(wizard);
  assert.deepEqual(parts, { name: 'canon', description: 'How we write code', extra: [], body: '<!-- Write the rules this skill stands for. The whole file is given to the agent. -->\n' });
  assert.equal(composeSkill('canon', 'How we write code', parts.body), wizard);
});

test('front matter lines Warband does not know are kept, and parseFrontMatter reads what compose writes', () => {
  const text = composeSkill('style', 'Naming: short and plain', '# Rules\n\n- one', ['tags: go', 'owner: platform']);
  assert.equal(text, '---\nname: style\ndescription: Naming: short and plain\ntags: go\nowner: platform\n---\n\n# Rules\n\n- one\n');
  assert.deepEqual(parseFrontMatter(text), { name: 'style', description: 'Naming: short and plain', tags: 'go', owner: 'platform' });
  assert.deepEqual(splitSkill(text).extra, ['tags: go', 'owner: platform']);
});

test('a file without front matter is all body; an empty body leaves only the front matter', () => {
  assert.deepEqual(splitSkill('# Just rules\n'), { extra: [], body: '# Just rules\n' });
  assert.equal(composeSkill('x', 'y', '  \n'), '---\nname: x\ndescription: y\n---\n');
  assert.deepEqual(splitSkill('---\r\nname: x\r\ndescription: y\r\n---\r\n\r\nbody\r\n'), { name: 'x', description: 'y', extra: [], body: 'body\r\n' });
});

test('size counts characters of the trimmed text, as the prompt gets it', () => {
  assert.equal(promptSize('  ёлка 🎄\n\n'), 6);
});

test('name and description are checked as the front matter can hold them', () => {
  assert.deepEqual(checkSkill('canon', 'rules'), []);
  assert.deepEqual(checkSkill('Canon!', '').map((p) => [p.field, p.code]), [
    ['name', 'name-invalid'],
    ['description', 'description-empty'],
  ]);
  assert.deepEqual(checkSkill('canon', 'two\nlines').map((p) => p.code), ['description-multiline']);
});
