// Helpers for the tasks' verify.mjs scripts. A verify script runs with the
// run's result as its working directory and exits 0 when the task passed.
// It may read the run's events from WARBAND_BENCH_EVENTS (events.jsonl).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The task folder of a verify script: taskDir(import.meta.url). */
export const taskDir = (url) => dirname(fileURLToPath(url));

export function fail(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}

export function pass(message = 'ok') {
  console.log(`PASS: ${message}`);
  process.exit(0);
}

/** The file in the result is byte for byte the one in the task's setup/. */
export function sameAsSetup(task, file) {
  if (!existsSync(file)) return false;
  return readFileSync(file).equals(readFileSync(join(task, 'setup', file)));
}

/** Runs node with the args in the result folder. */
export function node(args, timeout = 60_000) {
  const out = spawnSync(process.execPath, args, { encoding: 'utf8', timeout });
  return { code: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() };
}

/** Files of the result, without the folders git, Warband and reslop keep. */
export function files(dir = '.') {
  const skip = new Set(['.git', '.warband', '.plan', '.log', 'node_modules']);
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(dir, path).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** The run's engine events. */
export function events() {
  const file = process.env.WARBAND_BENCH_EVENTS;
  if (!file || !existsSync(file)) fail('no events (WARBAND_BENCH_EVENTS is not set)');
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** The reviewer's verdicts, in order. */
export const reviews = (all) => all.filter((e) => e.type === 'review');

/** All the text of a finding, to search for what it points at. */
export const findingText = (f) => [f.problem, f.where, f.expected, ...(f.check ?? [])].filter(Boolean).join(' ');
