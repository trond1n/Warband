// fix-bug-test: node test.js passes, and test.js is untouched.
import { fail, node, pass, sameAsSetup, taskDir } from '../verify-lib.mjs';

const task = taskDir(import.meta.url);
if (!sameAsSetup(task, 'test.js')) fail('test.js is missing or was modified');
const run = node(['test.js']);
if (run.code !== 0 || !run.output.includes('all tests passed')) fail(`node test.js did not pass:\n${run.output}`);
pass('node test.js passes, test.js untouched');
