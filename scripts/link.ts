/*
 * Runs after `npm install` in the Warband checkout and puts a `warband`
 * command on PATH via `npm link`, which points npm's global bin directory at
 * this checkout. Editing the code needs no reinstall.
 *
 * Skipped when Warband is installed as a dependency of another project, in
 * CI, or with WARBAND_NO_LINK=1. Never fails the install: if linking does
 * not work, it says how to do it by hand.
 *
 * Remove the command with: npm unlink -g warband
 */
import { spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const env = process.env;

const skip = (why: string): void => {
  console.log(`warband: not linking the warband command (${why}).`);
};

function npm(args: string[]): { ok: boolean; stdout: string } {
  // During npm scripts npm_execpath points at npm's own CLI script, which
  // avoids spawning npm.cmd through a shell on Windows.
  const cli = env['npm_execpath'];
  const result = cli
    ? spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd: root, encoding: 'utf8', shell: true });
  if (result.status !== 0 && result.stderr) process.stderr.write(result.stderr);
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

function main(): void {
  if (env['WARBAND_NO_LINK']) return skip('WARBAND_NO_LINK is set');
  if (env['CI']) return skip('CI');
  if (env['npm_config_global'] === 'true') return skip('global install already provides it');
  if (env['INIT_CWD'] && resolve(env['INIT_CWD']) !== root) return skip('installed as a dependency');

  // --ignore-scripts: `npm link` installs this package again, and without it
  // that install would run this script once more.
  if (!npm(['link', '--ignore-scripts']).ok) {
    console.log('warband: could not link the warband command. Run `npm link` in this folder by hand.');
    return;
  }

  const prefix = npm(['prefix', '-g']).stdout.trim();
  const binDir = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  const onPath = (env['PATH'] ?? '')
    .split(delimiter)
    .some((dir) => dir !== '' && resolve(dir).toLowerCase() === resolve(binDir).toLowerCase());

  console.log(`warband: the warband command is installed in ${binDir}.`);
  if (!onPath) console.log(`warband: ${binDir} is not on PATH. Add it, then open a new terminal.`);
  else console.log('warband: open a new terminal and run `warband help`.');
}

main();
