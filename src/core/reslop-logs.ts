import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

/*
 * `reslop t` keeps a record of every command it runs in .log/ of the folder
 * it runs in: <date>-<command>-NN.{json,log,raw} and older records under
 * .log/.runs/. It also drops its oldest records once there are more than 24.
 *
 * A hook's trial run from the window happens in the person's checkout, so
 * these files would land in their working copy. `keepLogsClean` takes back
 * what one run left there: files that appeared are removed, and files that
 * were there before and are gone (reslop's own rotation) are put back from
 * hard links made before the run. Nothing else in .log/ is touched.
 */

export const RESLOP_LOG_DIR = '.log';

async function filesUnder(dir: string): Promise<string[] | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)));
}

async function dirsUnder(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries.filter((e) => e.isDirectory()).map((e) => relative(dir, join(e.parentPath, e.name)));
  } catch {
    return [];
  }
}

export interface LogCleanup {
  /** Files under .log/ that the run created and that were removed, relative to .log/. */
  removed: string[];
  /** Files that were there before, were removed during the run and are back. */
  restored: string[];
}

/**
 * Runs `run` and then, whether it succeeded or threw, leaves `<cwd>/.log` as it was before: what appeared
 * is removed, what disappeared is put back. `holdDir` is where the hard
 * links (or copies, across drives) of the files that were there wait during
 * the run; it must be a folder Warband may write to and is removed after.
 */
export async function keepLogsClean<T>(cwd: string, holdDir: string, run: () => Promise<T>): Promise<{ result: T; cleanup: LogCleanup }> {
  const logDir = join(cwd, RESLOP_LOG_DIR);
  const before = await filesUnder(logDir);
  const dirsBefore = new Set(await dirsUnder(logDir));
  let createdHold: string | undefined;
  const held = new Set<string>();
  try {
    if (before && before.length > 0) {
      // The topmost folder about to be made; mkdir's own answer is a long-path form on Windows and does not compare.
      let top = holdDir;
      while (!existsSync(dirname(top))) top = dirname(top);
      await mkdir(holdDir, { recursive: true });
      createdHold = top;
      for (const file of before) {
        const target = join(holdDir, file);
        await mkdir(dirname(target), { recursive: true });
        try {
          await link(join(logDir, file), target);
        } catch {
          await copyFile(join(logDir, file), target);
        }
        held.add(file);
      }
    }
    // A run that throws (a spawn error, say) still has its files taken back.
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await run() };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const cleanup = await restore(logDir, before, dirsBefore, holdDir, held);
    if (!outcome.ok) throw outcome.error;
    return { result: outcome.value, cleanup };
  } finally {
    if (createdHold) {
      await rm(holdDir, { recursive: true, force: true });
      // Folders made for the hold (.warband itself, in a project without one) go too, unless the run put something there.
      for (let dir = dirname(holdDir); createdHold !== holdDir && dir.length >= createdHold.length; dir = dirname(dir)) {
        await rmdir(dir).catch(() => undefined);
      }
    }
  }
}

async function restore(logDir: string, before: string[] | undefined, dirsBefore: Set<string>, holdDir: string, held: Set<string>): Promise<LogCleanup> {
  const after = (await filesUnder(logDir)) ?? [];
  const had = new Set(before ?? []);
  const removed: string[] = [];
  for (const file of after) {
    if (had.has(file)) continue;
    await rm(join(logDir, file), { force: true });
    removed.push(file);
  }
  const now = new Set(after);
  const restored: string[] = [];
  for (const file of held) {
    if (now.has(file)) continue;
    const target = join(logDir, file);
    await mkdir(dirname(target), { recursive: true });
    try {
      await link(join(holdDir, file), target);
    } catch {
      await copyFile(join(holdDir, file), target);
    }
    restored.push(file);
  }
  // Folders the run made, deepest first; .log itself when it was not there.
  const made = (await dirsUnder(logDir)).filter((d) => !dirsBefore.has(d)).sort((a, b) => b.length - a.length);
  for (const dir of made) await rmdir(join(logDir, dir)).catch(() => undefined);
  if (before === undefined) await rmdir(logDir).catch(() => undefined);
  return { removed: removed.sort(), restored: restored.sort() };
}
