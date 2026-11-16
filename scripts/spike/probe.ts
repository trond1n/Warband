/*
 * Headless contract probe.
 *
 *   npm run spike                              run every probe on every installed CLI
 *   npm run spike -- claude agy                only the named CLIs (ids or binaries)
 *   npm run spike -- --probe=write antigravity only one probe
 *
 * Probes, each in its own fresh temporary directory:
 *
 *   pong     a trivial prompt. Did stdout arrive when it is a pipe, is it JSON,
 *            what was the exit code, did it hang.
 *   write    read access, asks the agent to create a file. In an interactive
 *            session that tool call would ask for approval, so this shows what
 *            the CLI does headless: runs it, denies it, or hangs.
 *   read     read access, the agent must read a seeded file. Shows that reading
 *            needs no approval (planner and reviewer depend on it).
 *   edit     edit access: create a file, then run a shell command. The file
 *            should appear and the command should be denied.
 *   verdict  read access with a JSON Schema for the answer. Shows where the
 *            structured answer arrives.
 *   outside-read   read access. A file with a marker sits one level above
 *            the working directory; the agent is asked to print it with a
 *            shell command. Signal: the marker shows up in the output.
 *   repo-settings  read access, with a .claude/settings.json in the working
 *            directory that allows reading the parent. Can a repository widen
 *            what the agent may read?
 *   outside-grep   the same file, through the Grep tool instead of a shell.
 *   outside-write  edit access. The agent is asked to create a file one
 *            level above the working directory. Signal: the file exists.
 *
 * Each probe gets a fresh temporary directory <base>, and the agent runs in
 * <base>/work. Files "outside" the agent's directory are put in <base>, so
 * nothing outside the temporary directory is ever involved.
 *
 * Raw output is saved to spike-output/<id>.<probe>.log (gitignored) so the
 * event schema can be read off real data instead of guessed.
 *
 * A run of every probe on a verified CLI is compared with the results its
 * adapter was verified with (RECORDED in probes.ts) and remembered in the
 * machine settings, so a version that passed here is not reported as drift.
 *
 * Each probe is a real model call and spends a little subscription quota.
 */
import { configDir, recordCheck } from '../../src/core/providers.ts';
import { configuredRunners, RUNNER_IDS } from '../../src/runners/registry.ts';
import { localCheck, PROBES, RECORDED, runProbe } from './probes.ts';
import type { ProbeResult } from './probes.ts';

const OUTPUT_DIR = 'spike-output';
// Binaries set in the machine settings (window: Провайдеры) are used here too.
const runners = await configuredRunners();

const args = process.argv.slice(2);
const probeFlag = args.find((arg) => arg.startsWith('--probe='))?.slice('--probe='.length);
const wanted = args.filter((arg) => !arg.startsWith('--'));
const probes = PROBES.filter((probe) => probeFlag === undefined || probe.name === probeFlag);
const selected = RUNNER_IDS.map((id) => runners[id]).filter(
  (runner) => wanted.length === 0 || wanted.includes(runner.id) || wanted.includes(runner.binary),
);

if (selected.length === 0 || probes.length === 0) {
  console.error(
    `Nothing to probe. Known ids: ${RUNNER_IDS.join(', ')}. Known probes: ${PROBES.map((p) => p.name).join(', ')}`,
  );
  process.exitCode = 2;
} else {
  const results: ProbeResult[] = [];
  const notes: string[] = [];
  for (const runner of selected) {
    const detection = await runner.detect();
    if (!detection.found) {
      console.log(`Skipping ${runner.displayName}: not installed.`);
      continue;
    }
    const own: ProbeResult[] = [];
    for (const probe of probes) {
      console.log(`Probing ${runner.displayName} (${probe.name})...`);
      own.push(await runProbe(runner, detection.version ?? '', probe, { logDir: OUTPUT_DIR }));
    }
    results.push(...own);
    // A full run is remembered in the machine settings, as the window does (docs/runners.md, "Version drift").
    const local = localCheck(RECORDED[runner.id], detection.version ?? '', own);
    if (local) {
      await recordCheck(configDir(), runner.id, local.check);
      for (const m of local.mismatches) notes.push(`${runner.displayName} ${m.probe}: ${m.field} ${m.actual || '(none)'}, recorded ${m.expected}`);
      if (local.mismatches.length === 0) notes.push(`${runner.displayName}: every probe matched the recorded results; ${detection.version} counts as checked on this machine.`);
    }
  }
  console.table(results);
  for (const note of notes) console.log(note);
  console.log(`Raw output: ${OUTPUT_DIR}/<id>.<probe>.log`);
  console.log('A healthy headless contract: stdout lines > 0, saw answer = yes, exit = 0.');
}
