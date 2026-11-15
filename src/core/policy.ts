import { basename, isAbsolute, relative, resolve } from 'node:path';

export type Action =
  | { kind: 'shell'; command: string }
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string };

export type Effect = 'allow' | 'ask' | 'deny';

export interface Decision {
  effect: Effect;
  /** Id of the rule that decided, absent when the fallback applied. */
  rule?: string;
  reason?: string;
}

export interface PolicyContext {
  /** Absolute path of the task worktree. */
  workspace: string;
}

export interface Rule {
  id: string;
  effect: Exclude<Effect, 'allow'>;
  reason: string;
  matches(action: Action, context: PolicyContext): boolean;
}

const SECRET_NAMES = [/^\.env$/, /^\.env\..+$/, /^id_(rsa|ed25519|ecdsa)$/, /\.pem$/, /^\.npmrc$/];
const SECRET_EXCEPTIONS = [/^\.env\.(example|sample|template)$/];

export function isSecretPath(path: string): boolean {
  const name = basename(path);
  if (SECRET_EXCEPTIONS.some((re) => re.test(name))) return false;
  return SECRET_NAMES.some((re) => re.test(name));
}

export function isInsideWorkspace(path: string, workspace: string): boolean {
  const rel = relative(resolve(workspace), resolve(workspace, path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const shell = (action: Action, pattern: RegExp): boolean =>
  action.kind === 'shell' && pattern.test(action.command);

/*
 * Baseline rules. Matching shell text with regular expressions is not a
 * sandbox: it catches the obvious cases and a determined command can get
 * around it. Real isolation comes from the worktree, from the CLI's own
 * sandbox where it has one, and later from an OS-level sandbox.
 */
export const DEFAULT_RULES: readonly Rule[] = [
  {
    id: 'shell.rm-recursive-force',
    effect: 'deny',
    reason: 'recursive forced delete',
    matches: (action) =>
      shell(action, /\brm\s+(-\w*\s+)*-\w*(r\w*f|f\w*r)\w*\b/i) ||
      shell(action, /\brm\s+.*--recursive.*--force|\brm\s+.*--force.*--recursive/),
  },
  {
    id: 'shell.git-force-push',
    effect: 'deny',
    reason: 'force push rewrites remote history',
    matches: (action) => shell(action, /\bgit\s+push\b.*(\s--force(-with-lease)?\b|\s-f\b)/),
  },
  {
    id: 'shell.git-reset-hard',
    effect: 'ask',
    reason: 'discards uncommitted work',
    matches: (action) => shell(action, /\bgit\s+reset\s+.*--hard\b/),
  },
  {
    id: 'shell.pipe-to-shell',
    effect: 'ask',
    reason: 'runs a downloaded script',
    matches: (action) => shell(action, /\b(curl|wget)\b.*\|\s*(sudo\s+)?(ba|z)?sh\b/),
  },
  {
    id: 'fs.secret-file',
    effect: 'deny',
    reason: 'secret file',
    matches: (action) => action.kind !== 'shell' && isSecretPath(action.path),
  },
  {
    id: 'shell.reads-secret-file',
    effect: 'deny',
    reason: 'command references a secret file',
    matches: (action) =>
      action.kind === 'shell' &&
      action.command.split(/[\s;|&<>"'`()]+/).some((token) => token !== '' && isSecretPath(token)),
  },
  {
    id: 'fs.write-outside-workspace',
    effect: 'deny',
    reason: 'write outside the task worktree',
    matches: (action, context) =>
      action.kind === 'write' && !isInsideWorkspace(action.path, context.workspace),
  },
];

const RANK: Record<Exclude<Effect, 'allow'>, number> = { ask: 1, deny: 2 };

/** Deny wins over ask, ask wins over the fallback. */
export function evaluate(
  action: Action,
  context: PolicyContext,
  rules: readonly Rule[] = DEFAULT_RULES,
  fallback: Effect = 'allow',
): Decision {
  let winner: Rule | undefined;
  for (const rule of rules) {
    if (!rule.matches(action, context)) continue;
    if (!winner || RANK[rule.effect] > RANK[winner.effect]) winner = rule;
  }
  return winner
    ? { effect: winner.effect, rule: winner.id, reason: winner.reason }
    : { effect: fallback };
}
