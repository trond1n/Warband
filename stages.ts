import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type ProcEvent =
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }
  | { type: 'spawn_error'; message: string };

export interface ProcOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Runs a child process and yields its output line by line, then one final
 * `exit` or `spawn_error` event.
 *
 * stdin is closed on purpose: several agent CLIs wait forever on an open
 * stdin when they are not attached to a terminal.
 */
export async function* runProcess(
  binary: string,
  args: readonly string[],
  opts: ProcOptions,
): AsyncGenerator<ProcEvent> {
  const queue: ProcEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const push = (event: ProcEvent): void => {
    queue.push(event);
    wake?.();
    wake = null;
  };

  const child = spawn(binary, [...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, opts.timeoutMs);

  const onAbort = (): void => {
    child.kill('SIGTERM');
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  createInterface({ input: child.stdout }).on('line', (line) => push({ type: 'stdout', line }));
  createInterface({ input: child.stderr }).on('line', (line) => push({ type: 'stderr', line }));

  child.on('error', (err) => {
    finished = true;
    push({ type: 'spawn_error', message: err.message });
  });
  child.on('close', (code, signal) => {
    if (finished) return;
    finished = true;
    push({ type: 'exit', code, signal, timedOut });
  });

  try {
    while (true) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (finished) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
