import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { warbandDir } from '../core/workspace.ts';
import type { EngineEvent } from './run.ts';

/**
 * Appends every engine event to .warband/runs/<run id>/events.jsonl, one
 * JSON object per line with a timestamp. This file is the run's record and
 * what any UI reads. Events before the run has an id are held until it does.
 */
export function eventLog(root: string): { write(event: EngineEvent): void; path(): string | undefined } {
  let file: string | undefined;
  const pending: string[] = [];

  return {
    write(event) {
      const line = `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`;
      if (event.type === 'run_started') {
        const dir = join(warbandDir(root), 'runs', event.runId);
        mkdirSync(dir, { recursive: true });
        file = join(dir, 'events.jsonl');
        appendFileSync(file, pending.join('') + line);
        pending.length = 0;
        return;
      }
      if (file) appendFileSync(file, line);
      else pending.push(line);
    },
    path: () => file,
  };
}
