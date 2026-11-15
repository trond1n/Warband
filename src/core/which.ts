import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/** Full path of a program on PATH, or undefined. Runs nothing. */
export async function which(program: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, program + ext.toLowerCase());
      try {
        await access(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}
