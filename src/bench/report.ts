import type { Role } from '../engine/run.ts';
import type { BenchReport, RunRecord } from './bench.ts';

/*
 * The terminal side of a bench report: one table per report, and a
 * comparison of two reports task by task. With repeats a task shows the
 * share of runs that passed, not one outcome: models are not deterministic.
 */

export interface TaskSummary {
  key: string;
  runs: number;
  passed: number;
  /** Runs whose verify outcome is the one task.toml expects. */
  asExpected: number;
  /** Runs that met every expectation. */
  fullyExpected: number;
  /** Expected verify outcome of this task variant, from its first run. */
  expectFail: boolean;
  reworks: number[];
  reviews: string[];
  protectedPaths: string[];
  denied: number;
  seconds: number[];
  modelCalls: number;
  errors: string[];
  misses: string[];
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const verdictWord = (v: { verdict: string; findings: number }): string => `${v.verdict === 'approve' ? 'approve' : 'changes'}${v.findings > 0 ? `(${v.findings})` : ''}`;

export function summarize(report: BenchReport): TaskSummary[] {
  const byKey = new Map<string, RunRecord[]>();
  for (const run of report.runs) byKey.set(run.key, [...(byKey.get(run.key) ?? []), run]);
  return [...byKey.entries()].map(([key, runs]) => {
    return {
      key,
      runs: runs.length,
      passed: runs.filter((r) => r.verify.ok).length,
      asExpected: runs.filter((r) => !r.error && r.verify.ok === (r.expected.verify === 'pass')).length,
      fullyExpected: runs.filter((r) => r.expected.ok).length,
      expectFail: runs[0]?.expected.verify === 'fail',
      reworks: runs.map((r) => r.metrics.reworks),
      reviews: runs.map((r) => r.metrics.reviews.map(verdictWord).join('>') || '-'),
      protectedPaths: [...new Set(runs.flatMap((r) => r.metrics.protectedPaths))],
      denied: runs.reduce((n, r) => n + r.metrics.deniedTools.length, 0),
      seconds: runs.map((r) => r.metrics.seconds),
      modelCalls: runs.reduce((n, r) => n + r.metrics.modelCalls, 0),
      errors: runs.flatMap((r) => (r.error ? [r.error] : [])),
      misses: [...new Set(runs.flatMap((r) => r.expected.misses))],
    };
  });
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

/** Local date and time of an ISO timestamp, to the minute. */
const when = (iso: string): string => {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const share = (n: number, of: number): string => (of === 1 ? (n === 1 ? 'yes' : 'no') : `${n}/${of}`);

const roleLine = (report: BenchReport, role: Role): string => {
  const info = report.roles[role];
  const assigned = role === 'implementer' ? report.agent.roles.implementer : report.agent.roles.reviewer;
  const model = info?.model ?? assigned.model ?? 'default model';
  return `${info?.runner ?? assigned.runner} ${model}${info?.version ? ` (CLI ${info.version})` : ''}`;
};

/** The report as lines for the terminal. */
export function renderReport(report: BenchReport): string[] {
  const summaries = summarize(report);
  const repeat = report.repeat;
  const rows = summaries.map((s) => [
    s.key,
    share(s.passed, s.runs),
    s.expectFail ? 'fail' : 'pass',
    share(s.fullyExpected, s.runs),
    s.reworks.join(','),
    repeat === 1 ? (s.reviews[0] ?? '-') : [...new Set(s.reviews)].join(' / '),
    s.protectedPaths.join(',') || '-',
    String(s.denied),
    `${Math.round(median(s.seconds))}s`,
    String(s.modelCalls),
  ]);
  const passedAll = summaries.reduce((n, s) => n + s.passed, 0);
  const runsAll = summaries.reduce((n, s) => n + s.runs, 0);
  const lines = [
    `Bench of /${report.agent.name}: implementer ${roleLine(report, 'implementer')}, reviewer ${roleLine(report, 'reviewer')}`,
    `Skills: ${report.agent.skills.join(', ') || 'none'}. ${when(report.started)}, ${runsAll} run(s)${repeat > 1 ? `, ${repeat} per task` : ''}.`,
    '',
    ...table(['task', 'verify', 'want', 'as expected', 'reworks', 'review', 'protected', 'denied', 'time', 'calls'], rows),
    '',
    `verify passed in ${passedAll} of ${runsAll} run(s); ${summaries.reduce((n, s) => n + s.modelCalls, 0)} model call(s).`,
  ];
  for (const s of summaries) {
    for (const miss of s.misses) lines.push(`  ${s.key}: ${miss}`);
  }
  return lines;
}

const rate = (s: TaskSummary | undefined): number | undefined => (s ? s.asExpected / s.runs : undefined);
const pct = (r: number | undefined): string => (r === undefined ? '-' : `${Math.round(r * 100)}%`);

/** Task by task: what changed from report a to report b. */
export function compareReports(a: BenchReport, b: BenchReport): string[] {
  const sa = new Map(summarize(a).map((s) => [s.key, s]));
  const sb = new Map(summarize(b).map((s) => [s.key, s]));
  const keys = [...new Set([...sa.keys(), ...sb.keys()])];
  const lines = [`A: ${when(a.started)}, /${a.agent.name}`, `B: ${when(b.started)}, /${b.agent.name}`];
  for (const role of ['implementer', 'reviewer'] as const) {
    const ra = roleLine(a, role);
    const rb = roleLine(b, role);
    if (ra !== rb) lines.push(`${role}: ${ra} -> ${rb}`);
  }
  const hashes = (r: BenchReport): Map<string, string> => new Map(r.runs.flatMap((run) => run.metrics.skills).map((s) => [s.name, s.sha256.slice(0, 8)]));
  const ha = hashes(a);
  const hb = hashes(b);
  for (const name of [...new Set([...ha.keys(), ...hb.keys()])].sort()) {
    if (ha.get(name) !== hb.get(name)) lines.push(`skill ${name}: ${ha.get(name) ?? 'absent'} -> ${hb.get(name) ?? 'absent'}`);
  }
  if (lines.length === 2) lines.push('Same roles, models, CLI versions and skills.');
  lines.push('');
  let better = 0;
  let worse = 0;
  const rows = keys.map((key) => {
    const x = sa.get(key);
    const y = sb.get(key);
    const rx = rate(x);
    const ry = rate(y);
    let change = '';
    if (rx === undefined) change = 'only in B';
    else if (ry === undefined) change = 'only in A';
    else if (ry > rx) {
      change = 'better';
      better++;
    } else if (ry < rx) {
      change = 'worse';
      worse++;
    }
    const pair = (f: (s: TaskSummary) => string): string => `${x ? f(x) : '-'} -> ${y ? f(y) : '-'}`;
    return [
      key,
      `${pct(rx)} -> ${pct(ry)}`,
      change,
      pair((s) => s.reworks.join(',')),
      pair((s) => [...new Set(s.reviews)].join('/')),
      pair((s) => `${Math.round(median(s.seconds))}s`),
      pair((s) => String(s.modelCalls)),
    ];
  });
  lines.push(...table(['task', 'as expected', 'change', 'reworks', 'review', 'time', 'calls'], rows));
  lines.push('', `${better} better, ${worse} worse, ${keys.length - better - worse} unchanged or not comparable.`);
  return lines;
}
