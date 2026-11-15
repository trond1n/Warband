/*
 * The contract between the window and the main process. The window has no
 * Node access: everything goes through `window.warband`, set up by the
 * preload script. Engine types are imported as types only, so the renderer
 * bundle does not pull in engine code.
 */
import type { AgentDefinition } from '../../../src/core/agents.ts';
import type { Hook } from '../../../src/core/hooks.ts';
import type { EngineEvent, GateDecision } from '../../../src/engine/run.ts';
import type { Finding } from '../../../src/engine/plan-file.ts';
import type { ProtectedChange } from '../../../src/core/protected.ts';

export type { AgentDefinition, EngineEvent, Finding, GateDecision, Hook, ProtectedChange };

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
  /** Live events of every active run. Returns an unsubscribe function. */
  onEvent(listener: (runId: string, event: TimedEvent) => void): () => void;
}

declare global {
  interface Window {
    warband: WarbandApi;
  }
}
