/*
 * The contract between the window and the main process. The window has no
 * Node access: everything goes through `window.warband`, set up by the
 * preload script. Engine types are imported as types only, so the renderer
 * bundle does not pull in engine code.
 */
import type { AgentDefinition } from '../../../src/core/agents.ts';
import type { Hook, HookProblem } from '../../../src/core/hooks.ts';
import type { HookInput } from '../../../src/core/workspace.ts';
import type { EngineEvent, GateDecision } from '../../../src/engine/run.ts';
import type { Finding } from '../../../src/engine/plan-file.ts';
import type { ProtectedChange } from '../../../src/core/protected.ts';
import type { ProviderProblem, ProviderSettings } from '../../../src/core/providers.ts';
import type { Capabilities, LocalCheck, LoginState, RunnerId, VersionDrift } from '../../../src/core/runner.ts';
import type { Mismatch, ProbeResult } from '../../../scripts/spike/probes.ts';

export type {
  AgentDefinition,
  Capabilities,
  EngineEvent,
  Finding,
  GateDecision,
  Hook,
  HookInput,
  HookProblem,
  LocalCheck,
  LoginState,
  Mismatch,
  ProbeResult,
  ProtectedChange,
  ProviderProblem,
  ProviderSettings,
  RunnerId,
  VersionDrift,
};

/** An engine event with the time it was reported. */
export type TimedEvent = EngineEvent & { time: string };

export type RunStatus = 'running' | 'waiting' | 'done' | 'halted' | 'interrupted';

export interface RunSummary {
  runId: string;
  agent: string;
  task: string;
  branch: string;
  status: RunStatus;
  /** Stage of the open gate, or the stage the run is in. */
  stage?: string;
  started: string;
  finished?: string;
  haltReason?: string;
  commit?: string;
}

export interface ToolInfo {
  id: string;
  name: string;
  found: boolean;
  version?: string;
  verified?: boolean;
}

export interface ProjectInfo {
  root: string;
  name: string;
  /** Current branch of the person's checkout, where "merge" lands. */
  branch?: string;
  agents: AgentDefinition[];
  skills: { name: string; description: string }[];
  hooks: Hook[];
  problems: string[];
}

export interface DiffFile {
  path: string;
  /** git name-status letter: A, M, D or R */
  status: string;
  original: string;
  modified: string;
}

export interface PlanInfo {
  name: string;
  status?: string;
  open: number;
  text: string;
}

/** The spike probes run from the window on one CLI. */
export interface ProbeState {
  running: boolean;
  total: number;
  /** Probe running now. */
  current?: string;
  results: ProbeResult[];
  finished?: string;
  error?: string;
  /** A full run on a verified CLI: what was remembered on this machine. */
  check?: LocalCheck;
  /** Where that run differed from the results the adapter was verified with. */
  mismatches?: Mismatch[];
}

/** One agent CLI on this machine, for the "Провайдеры" screen. */
export interface ProviderInfo {
  id: RunnerId;
  name: string;
  /** The command name looked up on PATH when no path is set, e.g. "agy". */
  command: string;
  /** What is launched: the set path, or the name looked up on PATH. */
  binary: string;
  /** Saved settings, from providers.json. */
  settings: ProviderSettings;
  found: boolean;
  version?: string;
  problem?: string;
  login: LoginState;
  capabilities: Capabilities;
  /** Installed version against the one the adapter was verified on. */
  drift: VersionDrift;
  probe: ProbeState;
}

export interface ProvidersView {
  providers: ProviderInfo[];
  /** Version of providers.json, passed back on save. */
  version: string;
  file: string;
  /** providers.json could not be read. */
  error?: string;
}

export type SaveProviderResult =
  | { ok: true; version: string }
  | { ok: false; problems: ProviderProblem[] }
  | { ok: false; changed: true }
  | { ok: false; error: string };

/** One hook of the project, with the agents that use it. */
export interface HookInfo {
  hook: Hook;
  /** Agents whose hook list has this hook; absent when the agent files could not be read. */
  usedBy?: string[];
}

export interface HooksView {
  hooks: HookInfo[];
  /** Version of hooks.json, passed back on save and delete. */
  version: string;
  /** The project's .warband folder, which {warband} in a command stands for. */
  warbandDir: string;
  /** Path of reslop when it is on PATH. */
  reslop?: string;
  /** hooks.json could not be read. */
  error?: string;
  /** The agent files could not be read, so "used by" is unknown. */
  agentsError?: string;
}

export type SaveHookResult =
  | { ok: true; version: string; name: string }
  | { ok: false; problems: HookProblem[] }
  | { ok: false; changed: true }
  | { ok: false; error: string };

export type DeleteHookResult =
  | { ok: true; version: string }
  | { ok: false; usedBy: string[] }
  | { ok: false; changed: true }
  | { ok: false; error: string };

/** What a trial run would execute, shown to the person before it runs. */
export interface TrialRequest {
  /** The exact command line given to the shell. */
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** Run through reslop for a short report. */
  reduced: boolean;
}

export type TrialResult =
  | { status: 'invalid'; problems: HookProblem[] }
  | { status: 'refused'; error: string }
  | {
      status: 'finished' | 'cancelled';
      command: string;
      cwd: string;
      ok: boolean;
      exitCode: number | null;
      timedOut: boolean;
      reduced: boolean;
      seconds: number;
      /** Last lines of stdout and stderr together. */
      output: string[];
    };

export interface AppState {
  projects: string[];
  current?: string;
  tools: ToolInfo[];
}

export interface WarbandApi {
  state(): Promise<AppState>;
  addProject(): Promise<AppState>;
  selectProject(root: string): Promise<AppState>;
  removeProject(root: string): Promise<AppState>;
  project(root: string): Promise<ProjectInfo>;
  runs(root: string): Promise<RunSummary[]>;
  run(root: string, runId: string): Promise<{ summary: RunSummary; events: TimedEvent[] } | undefined>;
  start(root: string, agent: string, task: string): Promise<{ runId: string } | { error: string }>;
  cancel(runId: string): Promise<void>;
  decide(runId: string, decision: GateDecision): Promise<void>;
  answer(runId: string, answers: string): Promise<void>;
  diff(root: string, runId: string): Promise<DiffFile[]>;
  plans(root: string, runId: string): Promise<PlanInfo[]>;
  openReslop(root: string, runId: string): Promise<{ ok: boolean; message?: string }>;
  merge(root: string, branch: string): Promise<{ ok: boolean; output: string }>;
  openPath(path: string): Promise<void>;
  providers(): Promise<ProvidersView>;
  saveProvider(id: RunnerId, settings: ProviderSettings, version: string): Promise<SaveProviderResult>;
  /** Runs the spike probes on one CLI. Resolves when they end; progress comes through onProbe. */
  probe(id: RunnerId): Promise<ProbeState>;
  cancelProbe(): Promise<void>;
  /** A section of docs/runners.md: claude, codex, antigravity, kimi, glm or adding. */
  runnerDocs(section: string): Promise<string>;
  onProbe(listener: (id: RunnerId, state: ProbeState) => void): () => void;
  /** providers.json changed on disk. */
  onProvidersChanged(listener: () => void): () => void;
  hooks(root: string): Promise<HooksView>;
  /** `original`: the name the hook had when the form opened; null for a new hook. */
  saveHook(root: string, input: HookInput, original: string | null, version: string): Promise<SaveHookResult>;
  deleteHook(root: string, name: string, version: string): Promise<DeleteHookResult>;
  /** The exact command line, folder and variables a trial run of the form would use, or why it cannot run. */
  trialRequest(root: string, input: HookInput): Promise<TrialRequest | { problems: HookProblem[] }>;
  /** Runs the hook as the form has it in the project checkout; `confirmed` is the command the person accepted. */
  trialHook(root: string, input: HookInput, confirmed: string): Promise<TrialResult>;
  cancelTrial(): Promise<void>;
  /** Something in the project's .warband changed on disk (hooks.json, agents, skills). */
  onWorkspaceChanged(listener: (root: string) => void): () => void;
  /** Live events of every active run. Returns an unsubscribe function. */
  onEvent(listener: (runId: string, event: TimedEvent) => void): () => void;
}

declare global {
  interface Window {
    warband: WarbandApi;
  }
}
