import type { Stage } from '../core/stages.ts';
import type { EngineEvent, Role, RoleInfo } from '../engine/run.ts';

/*
 * What one run did, read from its events.jsonl: the run's own record, the
 * same file the window shows. Nothing here asks a model.
 */

export type TimedEvent = EngineEvent & { time: string };

export interface RunMetrics {
  status: 'done' | 'halted' | 'unknown';
  haltReason?: string;
  /** How many times the work went back to implement. */
  reworks: number;
  seconds: number;
  /** Wall time per stage, summed over reworks. */
  stages: Partial<Record<Stage, number>>;
  /** Calls to a model; stand-ins are not counted. */
  modelCalls: number;
  scriptedCalls: number;
  deniedTools: string[];
  /** Protected paths changed, from every protected_changes event. */
  protectedPaths: string[];
  /** The reviewer's verdicts in order, with the number of findings each, also by severity. */
  reviews: { verdict: 'approve' | 'changes_requested'; findings: number; severity?: Severities }[];
  checks: { name: string; ok: boolean }[];
  skills: { name: string; sha256: string }[];
  roles: Partial<Record<Role, RoleInfo>>;
}

/** Findings by severity; a finding without one counts as medium. Absent in reports made before it was recorded. */
export interface Severities {
  high: number;
  medium: number;
  low: number;
}

export function severities(findings: readonly { severity?: string }[]): Severities {
  const out: Severities = { high: 0, medium: 0, low: 0 };
  for (const f of findings) out[f.severity === 'high' || f.severity === 'low' ? f.severity : 'medium']++;
  return out;
}

export function parseEvents(text: string): TimedEvent[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TimedEvent);
}

const at = (e: TimedEvent): number => Date.parse(e.time);

export function runMetrics(events: readonly TimedEvent[]): RunMetrics {
  const m: RunMetrics = {
    status: 'unknown',
    reworks: 0,
    seconds: 0,
    stages: {},
    modelCalls: 0,
    scriptedCalls: 0,
    deniedTools: [],
    protectedPaths: [],
    reviews: [],
    checks: [],
    skills: [],
    roles: {},
  };
  const first = events[0];
  const last = events.at(-1);
  if (first && last) m.seconds = Math.round((at(last) - at(first)) / 1000);
  let stage: { name: Stage; since: number } | undefined;
  const closeStage = (now: number): void => {
    if (stage) m.stages[stage.name] = Math.round(((m.stages[stage.name] ?? 0) * 1000 + now - stage.since) / 100) / 10;
  };
  for (const e of events) {
    switch (e.type) {
      case 'run_started':
        m.skills = e.skills ?? [];
        m.roles = e.roles ?? {};
        break;
      case 'stage':
        closeStage(at(e));
        stage = { name: e.stage, since: at(e) };
        m.reworks = Math.max(m.reworks, e.reworks);
        break;
      case 'agent_started':
        if (e.scripted) m.scriptedCalls++;
        else m.modelCalls++;
        break;
      case 'agent':
        if (e.event.kind === 'result') m.deniedTools.push(...e.event.deniedTools);
        break;
      case 'hook':
        if (e.stage === 'checks') m.checks.push({ name: e.result.name, ok: e.result.ok });
        break;
      case 'protected_changes':
        for (const c of e.changes) if (!m.protectedPaths.includes(c.path)) m.protectedPaths.push(c.path);
        break;
      case 'review':
        m.reviews.push({ verdict: e.verdict, findings: e.findings.length, severity: severities(e.findings) });
        break;
      case 'run_finished':
        closeStage(at(e));
        stage = undefined;
        m.status = e.state.status === 'done' ? 'done' : 'halted';
        m.reworks = e.state.reworks;
        if (e.state.haltReason) m.haltReason = e.state.haltReason;
        break;
      default:
        break;
    }
  }
  return m;
}
