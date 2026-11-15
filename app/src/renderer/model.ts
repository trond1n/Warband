import type { Finding, RunStatus, TimedEvent } from '../shared/api.ts';

/* What the window shows, worked out from a run's events. No DOM here. */

export const STAGE_LABEL: Record<string, string> = {
  setup: 'Подготовка',
  clarify: 'Уточнение',
  plan: 'План',
  approve: 'Утверждение',
  implement: 'Реализация',
  checks: 'Проверки',
  review: 'Ревью',
  accept: 'Приёмка',
  finish: 'Коммит',
};

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'идёт',
  waiting: 'ждёт вас',
  done: 'готово',
  halted: 'остановлен',
  interrupted: 'прерван',
};

export const ROLE_LABEL: Record<string, string> = { planner: 'планировщик', implementer: 'исполнитель', reviewer: 'ревьюер' };

/** Stages where a person decides; drawn differently on the timeline. */
export const GATE_STAGES = new Set(['approve', 'accept']);

export type OpenGate =
  | { stage: 'clarify'; questions: string[] }
  | { stage: 'approve'; plan: string }
  | { stage: 'accept'; findings: readonly Finding[]; summary: string; reviewComments: readonly string[]; branch: string };

/** The gate waiting for an answer: opened and not yet answered or moved past. */
export function openGate(events: readonly TimedEvent[]): OpenGate | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.type === 'gate' || e.type === 'run_finished') return undefined;
    if (e.type === 'stage' && e.stage !== 'clarify') return undefined;
    if (e.type === 'gate_open') {
      if (e.stage === 'clarify') return { stage: 'clarify', questions: e.questions };
      if (e.stage === 'approve') return { stage: 'approve', plan: e.plan };
      return {
        stage: 'accept',
        findings: e.result.findings,
        summary: e.result.summary,
        reviewComments: e.result.reviewComments,
        branch: e.result.branch,
      };
    }
  }
  return undefined;
}

export interface Segment {
  stage: string;
  rework: number;
  start: number;
  end: number;
  /** Still going. */
  open: boolean;
  outcome?: 'ok' | 'failed' | 'changes' | 'rejected';
  detail: string[];
}

/**
 * One bar per stage visit, from the stage event to the next one. A live run
 * runs up to now; one that ended without a record of it (the app was
 * closed) ends at its last event.
 */
export function timeline(events: readonly TimedEvent[], now: number, live = true): Segment[] {
  const segments: Segment[] = [];
  const finished = events.find((e) => e.type === 'run_finished');
  const last = events.at(-1);
  const end = finished ? Date.parse(finished.time) : live || !last ? now : Date.parse(last.time);
  let current: Segment | undefined;
  const close = (at: number): void => {
    if (current) {
      current.end = at;
      current.open = false;
    }
  };
  const started = events.find((e) => e.type === 'run_started');
  for (const e of events) {
    const at = Date.parse(e.time);
    if (e.type === 'hook_started' && e.stage === 'setup' && !current) {
      current = { stage: 'setup', rework: 0, start: started ? Date.parse(started.time) : at, end: at, open: true, detail: [] };
      segments.push(current);
    }
    if (e.type === 'stage') {
      close(at);
      current = { stage: e.stage, rework: e.reworks, start: at, end: at, open: true, detail: [] };
      segments.push(current);
      continue;
    }
    if (!current) continue;
    if (e.type === 'agent_started') current.detail.push(`${ROLE_LABEL[e.role] ?? e.role}: ${e.runner}${e.model ? ` / ${e.model}` : ''}`);
    if (e.type === 'agent_finished' && !e.ok) current.outcome = 'failed';
    if (e.type === 'hook') {
      current.detail.push(`${e.result.name}: ${e.result.ok ? 'прошёл' : 'упал'}`);
      if (!e.result.ok) current.outcome = 'failed';
    }
    if (e.type === 'review') current.outcome = e.verdict === 'approve' ? 'ok' : 'changes';
    if (e.type === 'gate') current.outcome = e.outcome === 'ok' ? 'ok' : e.outcome === 'rejected' ? 'rejected' : 'changes';
  }
  if (current) {
    current.end = end;
    current.open = !finished && live;
  }
  for (const s of segments) if (!s.outcome && !s.open) s.outcome = 'ok';
  return segments;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

export function dayLabel(iso: string, today = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

export const clock = (iso: string): string => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** `path:line` of a finding, when it names one. */
export function findingTarget(where: string | undefined): { path: string; line?: number } | undefined {
  if (!where) return undefined;
  const clean = where.replace(/`/g, '').trim();
  const match = /^(.+?):(\d+)(?:[-:]\d+)?$/.exec(clean);
  if (match?.[1]) return { path: match[1], line: Number(match[2]) };
  const path = clean.split('#')[0]?.trim();
  return path ? { path } : undefined;
}
