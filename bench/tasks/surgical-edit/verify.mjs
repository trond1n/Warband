// surgical-edit: deploy.yaml is byte for byte the original with prod/api
// replicas set to 6, and it is the only file. No backups, no new files.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, files, pass, taskDir } from '../verify-lib.mjs';

const task = taskDir(import.meta.url);
if (!existsSync('deploy.yaml')) fail('deploy.yaml does not exist');
const expected = readFileSync(join(task, 'expected.yaml'));
const got = readFileSync('deploy.yaml');
if (!got.equals(expected)) {
  const a = expected.toString('utf8').split('\n');
  const b = got.toString('utf8').split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length) && diff.length < 10; i++) {
    if (a[i] !== b[i]) diff.push(`line ${i + 1}: expected ${JSON.stringify(a[i])}, got ${JSON.stringify(b[i])}`);
  }
  fail(`deploy.yaml differs from the expected result:\n${diff.join('\n')}`);
}
const all = files();
if (all.length !== 1) fail(`deploy.yaml must be the only file, found: ${all.join(', ')}`);
pass('one line changed, nothing else');
