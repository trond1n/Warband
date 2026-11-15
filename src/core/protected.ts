import { matchGlob } from './glob.ts';

/*
 * Protected paths: files that decide what the checks check. If the
 * implementer changes a lint config, a test setup, the scripts in
 * package.json or the CI, the hooks can pass while checking less. Such
 * changes are not blocked: they are found without a model, after every
 * implement, and shown to the reviewer and to the person at acceptance.
 *
 * Configured in .warband/protected.json:
 *
 *   { "paths": ["infra/**"], "tests": ["checks/**"], "defaults": true }
 *
 * paths and tests are added to the defaults below; "defaults": false
 * replaces them instead. Patterns are globs, see glob.ts.
 */

export const DEFAULT_PROTECTED: readonly string[] = [
  // Warband's own configuration: agents, skills, hooks, this list.
  '/.warband/**',
  // Package manifests and lock files: scripts, dependencies, versions.
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  '.yarnrc*',
  'bun.lock',
  'bun.lockb',
  '.npmrc',
  // Linters and formatters.
  '.eslintrc*',
  'eslint.config.*',
  '.eslintignore',
  '.prettierrc*',
  'prettier.config.*',
  '.prettierignore',
  'biome.json',
  'biome.jsonc',
  '.stylelintrc*',
  'stylelint.config.*',
  '.editorconfig',
  // Type checking and test runners.
  'tsconfig*.json',
  'jsconfig*.json',
  'vitest.config.*',
  'vitest.workspace.*',
  'vite.config.*',
  'jest.config.*',
  'jest.setup.*',
  'playwright.config.*',
  'cypress.config.*',
  'karma.conf.*',
  '.mocharc*',
  'babel.config.*',
  '.babelrc*',
  // Monorepo task runners: they define the check targets.
  'nx.json',
  'project.json',
  'turbo.json',
  'lerna.json',
  // CI and git hooks.
  '/.github/**',
  '/.gitlab-ci.yml',
  '/.gitlab/**',
  '/.circleci/**',
  '/azure-pipelines.yml',
  'Jenkinsfile',
  '/.husky/**',
  '/.pre-commit-config.yaml',
  'lefthook.yml',
  '.lintstagedrc*',
  // Instructions and settings for agents.
  '/.claude/**',
  'CLAUDE.md',
  'AGENTS.md',
];

/** Where tests live; deleting or renaming one is a signal of its own. */
export const DEFAULT_TESTS: readonly string[] = [
  '*.test.*',
  '*.spec.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
  '**/e2e/**',
  '**/*-e2e/**',
];

export interface ProtectedRules {
  paths: readonly string[];
  tests: readonly string[];
}

export const DEFAULT_RULES: ProtectedRules = { paths: DEFAULT_PROTECTED, tests: DEFAULT_TESTS };

/** One changed file, from `git diff --name-status`. */
export interface FileChange {
  /** A, M, D, R (renamed: path is the new name, from the old one), T or C. */
  status: string;
  path: string;
  from?: string;
}

export interface ProtectedChange extends FileChange {
  reason: 'protected' | 'test_deleted' | 'test_renamed';
  /** The pattern that matched. */
  pattern: string;
}

export function protectedChanges(changes: readonly FileChange[], rules: ProtectedRules = DEFAULT_RULES): ProtectedChange[] {
  const found: ProtectedChange[] = [];
  for (const change of changes) {
    const guarded = matchGlob(change.path, rules.paths) ?? (change.from ? matchGlob(change.from, rules.paths) : undefined);
    if (guarded) {
      found.push({ ...change, reason: 'protected', pattern: guarded });
      continue;
    }
    if (change.status === 'D') {
      const test = matchGlob(change.path, rules.tests);
      if (test) found.push({ ...change, reason: 'test_deleted', pattern: test });
    } else if (change.status === 'R' && change.from) {
      const test = matchGlob(change.from, rules.tests);
      if (test) found.push({ ...change, reason: 'test_renamed', pattern: test });
    }
  }
  return found;
}

/** One line per change, for prompts, the terminal and logs. */
export function describeProtected(change: ProtectedChange): string {
  const what = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'type changed', C: 'copied' }[change.status] ?? change.status;
  const name = change.from ? `${change.from} -> ${change.path}` : change.path;
  if (change.reason === 'test_deleted') return `${name}: test file deleted`;
  if (change.reason === 'test_renamed') return `${name}: test file renamed`;
  return `${name}: ${what} (protected by "${change.pattern}")`;
}
