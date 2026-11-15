/*
 * Headless contract probe.
 *
 *   npm run spike                 probe every installed CLI
 *   npm run spike -- claude agy   probe only the named ones (ids or binaries)
 *
 * For each CLI it sends one trivial prompt in an empty temporary directory
 * and records what came back: did stdout arrive when it is a pipe, is it
 * JSON, what was the exit code, did it hang. Raw output is saved to
 * spike-output/<id>.log (gitignored) so the event schema can be read off
 * real data instead of guessed.
 *
 * Each probe is a real model call and spends a little subscription quota.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RUNNER_IDS, RUNNERS } from '../../src/runners/registry.ts';
import type { Runner } from '../../src/core/runner.ts';

const PROMPT = 'Reply with the single word: pong. Do not use any tools.';
const TIMEOUT_MS = 120_000;
const OUTPUT_DIR = 'spike-output';

interface ProbeResult {
  CLI: string;
  installed: string;
  version: string;
  'stdout lines': number;
  'json lines': number;
  'saw "pong"': string;
  exit: string;
  seconds: string;
}

async function probe(runner: Runner): Promise<ProbeResult> {
  const result: ProbeResult = {
    CLI: runner.displayName,
    installed: 'no',
    version: '',
    'stdout lines': 0,
    'json lines': 0,
    'saw "pong"': 'no',
    exit: '',
    seconds: '',
  };

  const detection = await runner.detect();
  if (!detection.found) return result;
  result.installed = 'yes';
  result.version = detection.version ?? '';

  const cwd = await mkdtemp(join(tmpdir(), `warband-spike-${runner.id}-`));
  const log: string[] = [];
  const started = Date.now();
  try {
    for await (const event of runner.run({ prompt: PROMPT, cwd, timeoutMs: TIMEOUT_MS })) {
      switch (event.type) {
        case 'raw':
          result['stdout lines'] += 1;
          result['json lines'] += 1;
          log.push(JSON.stringify(event.data));
          if (/pong/i.test(JSON.stringify(event.data))) result['saw "pong"'] = 'yes';
          break;
        case 'text':
          result['stdout lines'] += 1;
          log.push(event.text);
          if (/pong/i.test(event.text)) result['saw "pong"'] = 'yes';
          break;
        case 'stderr':
          log.push(`[stderr] ${event.text}`);
          break;
        case 'error':
          result.exit = `error: ${event.message}`;
          break;
        case 'done':
          result.exit = event.timedOut ? `timed out after ${TIMEOUT_MS / 1000}s` : String(event.exitCode);
          break;
      }
    }
  } finally {
    result.seconds = ((Date.now() - started) / 1000).toFixed(1);
    await rm(cwd, { recursive: true, force: true });
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(join(OUTPUT_DIR, `${runner.id}.log`), `${log.join('\n')}\n`);
  }
  return result;
}

const wanted = process.argv.slice(2);
const selected = RUNNER_IDS.map((id) => RUNNERS[id]).filter(
  (runner) => wanted.length === 0 || wanted.includes(runner.id) || wanted.includes(runner.binary),
);

if (selected.length === 0) {
  console.error(`No runner matches: ${wanted.join(', ')}. Known ids: ${RUNNER_IDS.join(', ')}`);
  process.exitCode = 2;
} else {
  const results: ProbeResult[] = [];
  for (const runner of selected) {
    console.log(`Probing ${runner.displayName}...`);
    results.push(await probe(runner));
  }
  console.table(results);
  console.log(`Raw output: ${OUTPUT_DIR}/<id>.log`);
  console.log('A healthy headless contract: stdout lines > 0, saw "pong" = yes, exit = 0.');
}
