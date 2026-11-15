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
  /**
   * Run `binary` as a shell command line (for user-defined hooks such as
   * `npm test`). Agent CLIs are never run through a shell.
   */
  shell?: boolean;
  /**
   * Written to stdin, which is then closed. Lets a long prompt bypass the
   * command-line length limit (about 32K characters on Windows).
   */
  input?: string;
}

/** How long to wait for stdout to end after the child itself has exited. */
const EXIT_GRACE_MS = 2_000;

/**
 * Runs a child process and yields its output line by line, then one final
 * `exit` or `spawn_error` event.
 *
 * stdin is closed on purpose: several agent CLIs wait forever on an open
 * stdin when they are not attached to a terminal. With `input` it carries
 * that text and is closed right after.
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

  const shell = opts.shell ?? false;
  // On POSIX a shell command gets its own process group so the whole group
  // can be signalled. On Windows taskkill /T walks the tree instead.
  const detached = shell && process.platform !== 'win32';
  const child = spawn(binary, [...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    shell,
    detached,
  });

  const { stdout, stderr } = child;
  if (!stdout || !stderr) throw new Error('child process has no stdout or stderr pipe');

  if (opts.input !== undefined && child.stdin) {
    // A child that exits without reading stdin must not crash us with EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input);
  }

  /*
   * Killing only the direct child is not enough: a shell or an agent CLI
   * may have started processes that keep running and keep stdout open,
   * so the run never ends. Seen with `cmd.exe /c node ...` on Windows.
   */
  const killTree = (): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill());
    } else if (detached) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree();
  }, opts.timeoutMs);

  const onAbort = (): void => {
    killTree();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  createInterface({ input: stdout }).on('line', (line) => push({ type: 'stdout', line }));
  createInterface({ input: stderr }).on('line', (line) => push({ type: 'stderr', line }));

  child.on('error', (err) => {
    finished = true;
    push({ type: 'spawn_error', message: err.message });
  });
  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (finished) return;
    finished = true;
    clearTimeout(grace);
    push({ type: 'exit', code, signal, timedOut });
  };
  child.on('close', finish);

  /*
   * 'close' waits for stdout and stderr to end. If the child exited but a
   * descendant still holds them, give buffered output a moment to arrive,
   * then finish anyway instead of hanging.
   */
  let grace: NodeJS.Timeout | undefined;
  child.on('exit', (code, signal) => {
    grace = setTimeout(() => {
      stdout.destroy();
      stderr.destroy();
      finish(code, signal);
    }, EXIT_GRACE_MS);
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
    clearTimeout(grace);
    opts.signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null && child.signalCode === null) killTree();
  }
}
