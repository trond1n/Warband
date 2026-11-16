/** The agent CLIs Warband has adapters for. No imports, so the window can use it. */
export const KNOWN_RUNNER_IDS = ['claude', 'codex', 'antigravity', 'kimi'] as const;

export type RunnerId = (typeof KNOWN_RUNNER_IDS)[number];
