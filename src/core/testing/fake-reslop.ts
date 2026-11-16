import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for reslop, for tests: like `reslop t`, it records the run in
 * .log/ of its folder (a record, its report, the raw output and a record
 * under .log/.runs), drops the oldest record 2026-01-01-old-01.json, prints
 * "reduced report" and passes the exit code through. Returns the folder to
 * put first on PATH; `reslop` there runs it.
 */
export async function fakeReslop(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'warband-fake-reslop-'));
  await writeFile(
    join(dir, 'fake-reslop.mjs'),
    [
      "import { mkdirSync, writeFileSync, rmSync } from 'node:fs';",
      "import { execSync } from 'node:child_process';",
      "const command = process.argv.slice(process.argv.indexOf('--') + 1).join(' ');",
      "mkdirSync('.log/.runs', { recursive: true });",
      "for (const ext of ['json', 'log', 'raw']) writeFileSync('.log/2026-11-16-node-01.' + ext, ext);",
      "writeFileSync('.log/.runs/r.json', '{}');",
      "rmSync('.log/2026-01-01-old-01.json', { force: true });",
      'let code = 0;',
      "try { execSync(command, { stdio: 'ignore' }); } catch (e) { code = e.status ?? 1; }",
      "console.log('reduced report');",
      'process.exit(code);',
      '',
    ].join('\n'),
  );
  await writeFile(join(dir, 'reslop.cmd'), '@node "%~dp0fake-reslop.mjs" %*\r\n');
  await writeFile(join(dir, 'reslop'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-reslop.mjs" "$@"\n', { mode: 0o755 });
  return dir;
}

/** PATH with `dir` first. */
export const pathWith = (dir: string): string => `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH'] ?? ''}`;
