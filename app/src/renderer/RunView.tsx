import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { PlanInfo, ProjectInfo, RunSummary, TimedEvent } from '../shared/api.ts';
import { DiffReview } from './DiffReview.tsx';
import { Markdown } from './Markdown.tsx';
import { clock, duration, GATE_STAGES, openGate, protectedLine, ROLE_LABEL, STAGE_LABEL, STATUS_LABEL, timeline } from './model.ts';
import type { OpenGate } from './model.ts';

type Tab = 'timeline' | 'log' | 'checks' | 'plans';

export function RunView({ root, runId, project, onChanged }: { root: string; runId: string; project: ProjectInfo | undefined; onChanged(): void }): ReactNode {
  const [summary, setSummary] = useState<RunSummary>();
  const [events, setEvents] = useState<TimedEvent[]>([]);
  const [tab, setTab] = useState<Tab>('timeline');
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const run = await window.warband.run(root, runId);
    if (run) {
      setSummary(run.summary);
      setEvents(run.events);
    }
  }, [root, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      window.warband.onEvent((id, event) => {
        if (id !== runId) return;
        setEvents((list) => [...list, event]);
        if (event.type === 'gate_open' || event.type === 'gate' || event.type === 'run_finished' || event.type === 'stage') void load();
      }),
    [runId, load],
  );

  const live = summary?.status === 'running' || summary?.status === 'waiting';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const gate = useMemo(() => (summary?.status === 'waiting' ? openGate(events) : undefined), [events, summary?.status]);
  const finished = events.find((e) => e.type === 'run_finished');
  const started = events.find((e) => e.type === 'run_started');

  if (!summary) return <div className="page muted">Загрузка прогона…</div>;
  const last = events.at(-1);
  const total = (finished ? Date.parse(finished.time) : live || !last ? now : Date.parse(last.time)) - Date.parse(summary.started);

  return (
    <div className="run">
      <header className="run-header">
        <div className="run-title">
          <span className={`chip ${summary.status}`}>{STATUS_LABEL[summary.status]}</span>
          <h1 title={summary.task}>{summary.task.split('\n')[0]}</h1>
        </div>
        <div className="run-sub muted small">
          /{summary.agent} · {summary.branch} · {duration(total)}
          {summary.haltReason ? ` · ${summary.haltReason}` : ''}
          {summary.commit ? ` · коммит ${summary.commit.slice(0, 10)}` : ''}
        </div>
        <div className="run-actions">
          {live && (
            <button className="button danger" onClick={() => void window.warband.cancel(runId)}>
              Отменить прогон
            </button>
          )}
          {started?.type === 'run_started' && (
            <button className="button" onClick={() => void window.warband.openPath(started.worktree)} title={started.worktree}>
              Папка worktree
            </button>
          )}
          {summary.status === 'done' && <MergeButton root={root} branch={summary.branch} into={project?.branch} onDone={onChanged} />}
        </div>
      </header>

      {gate && <GatePanel root={root} runId={runId} gate={gate} />}

      <div className="tabs" role="tablist">
        {(
          [
            ['timeline', 'Таймлайн'],
            ['log', 'Лог'],
            ['checks', 'Проверки'],
            ['plans', 'Планы ревью'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === 'timeline' && <Timeline events={events} now={now} live={live} />}
        {tab === 'log' && <Log events={events} />}
        {tab === 'checks' && <Checks events={events} />}
        {tab === 'plans' && <Plans root={root} runId={runId} events={events} />}
      </div>
    </div>
  );
}

function MergeButton({ root, branch, into, onDone }: { root: string; branch: string; into: string | undefined; onDone(): void }): ReactNode {
  const [result, setResult] = useState<{ ok: boolean; output: string }>();
  return (
    <>
      <button
        className="button primary"
        onClick={async () => {
          if (!window.confirm(`Влить ${branch} в ${into ?? 'текущую ветку'} вашей рабочей копии?`)) return;
          setResult(await window.warband.merge(root, branch));
          onDone();
        }}
      >
        Влить в {into ?? 'текущую ветку'}
      </button>
      {result && <pre className={`merge-output${result.ok ? '' : ' error'}`}>{result.output || (result.ok ? 'Готово.' : 'Не получилось.')}</pre>}
    </>
  );
}

function GatePanel({ root, runId, gate }: { root: string; runId: string; gate: OpenGate }): ReactNode {
  if (gate.stage === 'clarify') return <QuestionsGate runId={runId} questions={gate.questions} />;
  if (gate.stage === 'approve') return <PlanGate runId={runId} plan={gate.plan} />;
  return <DiffReview root={root} runId={runId} gate={gate} />;
}

function QuestionsGate({ runId, questions }: { runId: string; questions: string[] }): ReactNode {
  const [answers, setAnswers] = useState('');
  return (
    <section className="gate" aria-label="Вопросы планировщика">
      <h2>Планировщик спрашивает</h2>
      <ol>
        {questions.map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ol>
      <textarea rows={5} value={answers} onChange={(e) => setAnswers(e.target.value)} placeholder="Ответы. Пустой ответ: пусть планировщик решит сам." />
      <div className="row">
        <button className="button primary" onClick={() => void window.warband.answer(runId, answers)}>
          Ответить
        </button>
      </div>
    </section>
  );
}

function PlanGate({ runId, plan }: { runId: string; plan: string }): ReactNode {
  const [comment, setComment] = useState('');
  const [returning, setReturning] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !returning) void window.warband.decide(runId, { outcome: 'ok' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runId, returning]);
  return (
    <section className="gate" aria-label="Утверждение плана">
      <div className="gate-head">
        <h2>Утверждение плана</h2>
        <span className="muted small">Код ещё не писался. Ctrl+Enter — принять.</span>
      </div>
      <div className="plan-box">
        <Markdown text={plan} />
      </div>
      {returning && (
        <textarea autoFocus rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Что поменять в плане" />
      )}
      <div className="row">
        <button className="button primary" onClick={() => void window.warband.decide(runId, { outcome: 'ok' })}>
          Принять
        </button>
        {returning ? (
          <button className="button" disabled={comment.trim() === ''} onClick={() => void window.warband.decide(runId, { outcome: 'changes_requested', comment })}>
            Отправить на переплан
          </button>
        ) : (
          <button className="button" onClick={() => setReturning(true)}>
            Вернуть с комментарием
          </button>
        )}
        <button className="button danger" onClick={() => void window.warband.decide(runId, { outcome: 'rejected' })}>
          Отменить задачу
        </button>
      </div>
    </section>
  );
}

const OUTCOME_LABEL: Record<string, string> = { ok: 'успешно', failed: 'не прошло', changes: 'вернули на доработку', rejected: 'отклонено' };

function Timeline({ events, now, live }: { events: TimedEvent[]; now: number; live: boolean }): ReactNode {
  const segments = timeline(events, now, live);
  if (segments.length === 0) return <p className="muted pad">Стадий пока нет.</p>;
  const start = segments[0]?.start ?? now;
  const end = Math.max(...segments.map((s) => s.end), start + 1);
  const span = end - start;
  return (
    <div className="timeline">
      <div className="axis muted small">
        <span>{clock(new Date(start).toISOString())}</span>
        <span>{duration(span)}</span>
      </div>
      {segments.map((s, i) => {
        const left = ((s.start - start) / span) * 100;
        const width = Math.max(((s.end - s.start) / span) * 100, 0.6);
        const kind = GATE_STAGES.has(s.stage) ? 'gate' : s.stage === 'checks' || s.stage === 'setup' || s.stage === 'finish' ? 'hook' : 'agent';
        return (
          <div key={i} className="tl-row">
            <div className="tl-label">
              <span>{STAGE_LABEL[s.stage] ?? s.stage}</span>
              {s.rework > 0 && <span className="muted small"> · переделка {s.rework}</span>}
            </div>
            <div className="tl-track">
              <div
                className={`tl-bar k-${kind} ${s.open ? 'open' : `o-${s.outcome ?? 'ok'}`}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${STAGE_LABEL[s.stage] ?? s.stage}: ${duration(s.end - s.start)}`}
              />
            </div>
            <div className="tl-info small">
              <span>{duration(s.end - s.start)}</span>
              <span className="muted">{s.open ? (kind === 'gate' ? 'ждёт вас' : 'идёт…') : OUTCOME_LABEL[s.outcome ?? 'ok']}</span>
              {s.detail.length > 0 && <span className="muted">{s.detail.join(' · ')}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Log({ events }: { events: TimedEvent[] }): ReactNode {
  const [follow, setFollow] = useState(true);
  const lines = events.flatMap((e, i): ReactNode[] => {
    const at = <span className="log-time">{clock(e.time)}</span>;
    switch (e.type) {
      case 'run_started':
        return [<div key={i} className="log-line">{at} Прогон {e.runId}, ветка {e.branch}</div>];
      case 'warning':
        return [<div key={i} className="log-line warn">{at} ! {e.message}</div>];
      case 'stage':
        return [<div key={i} className="log-line stage">{at} == {STAGE_LABEL[e.stage] ?? e.stage}{e.reworks > 0 ? ` (переделка ${e.reworks})` : ''}</div>];
      case 'agent_started':
        return [<div key={i} className="log-line">{at} {ROLE_LABEL[e.role]}: {e.runner}{e.model ? ` / ${e.model}` : ''}, {e.access === 'edit' ? 'может править файлы' : 'только чтение'}</div>];
      case 'agent': {
        const a = e.event;
        if (a.kind === 'tool_call') return a.name === 'StructuredOutput' ? [] : [<div key={i} className="log-line tool">{at} › {a.name} {target(a.input)}</div>];
        if (a.kind === 'assistant_text') return [<div key={i} className="log-line text">{at} <span>{a.text}</span></div>];
        if (a.kind === 'result' && a.deniedTools.length > 0) return [<div key={i} className="log-line warn">{at} отклонено: {a.deniedTools.join(', ')}</div>];
        if (a.kind === 'error') return [<div key={i} className="log-line error">{at} ошибка: {a.message}</div>];
        return [];
      }
      case 'agent_finished':
        return [<div key={i} className={`log-line${e.ok ? '' : ' error'}`}>{at} {e.ok ? 'готово' : 'не удалось'} за {e.seconds} с</div>];
      case 'hook_started':
        return [<div key={i} className="log-line">{at} хук {e.name}: {e.run}</div>];
      case 'hook':
        return [<div key={i} className={`log-line${e.result.ok ? '' : ' error'}`}>{at} {e.result.name}: {e.result.ok ? 'прошёл' : 'упал'}{e.result.reduced ? ' (отчёт reslop)' : ''}</div>];
      case 'review':
        return [<div key={i} className="log-line">{at} ревью: {e.verdict === 'approve' ? 'одобрено' : 'нужны правки'}, замечаний {e.findings.length}</div>];
      case 'protected_changes':
        return e.changes.length === 0 ? [] : [<div key={i} className="log-line warn">{at} защищённые файлы: {e.changes.map(protectedLine).join('; ')}</div>];
      case 'plan_written':
        return [<div key={i} className="log-line">{at} план .plan/{e.name}: {e.findings} пункт(ов) от {e.source === 'reviewer' ? 'ревьюера' : 'вас'}</div>];
      case 'gate':
        return [<div key={i} className="log-line">{at} решение: {OUTCOME_LABEL[e.outcome === 'changes_requested' ? 'changes' : e.outcome === 'ok' ? 'ok' : e.outcome] ?? e.outcome}</div>];
      case 'run_finished':
        return [<div key={i} className="log-line stage">{at} {e.state.status === 'done' ? `Готово, коммит ${e.commit?.slice(0, 10) ?? ''}` : `Остановлен: ${e.state.haltReason ?? ''}`}</div>];
      default:
        return [];
    }
  });
  return (
    <div className="log">
      <label className="follow small muted">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Прокручивать к новым
      </label>
      <div
        className="log-lines"
        ref={(el) => {
          if (el && follow) el.scrollTop = el.scrollHeight;
        }}
      >
        {lines}
      </div>
    </div>
  );
}

function target(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const f = input as Record<string, unknown>;
  const t = f['file_path'] ?? f['path'] ?? f['pattern'] ?? f['command'];
  return typeof t === 'string' ? t : '';
}

function Checks({ events }: { events: TimedEvent[] }): ReactNode {
  const hooks = events.filter((e) => e.type === 'hook');
  if (hooks.length === 0) return <p className="muted pad">Хуки ещё не запускались.</p>;
  return (
    <div className="checks">
      {hooks.map((e, i) =>
        e.type === 'hook' ? (
          <details key={i} open={!e.result.ok}>
            <summary>
              <span className={`status-dot ${e.result.ok ? 'done' : 'halted'}`} aria-hidden="true" /> {STAGE_LABEL[e.stage] ?? e.stage}: {e.result.name} —{' '}
              {e.result.ok ? 'прошёл' : e.result.timedOut ? 'таймаут' : `код ${e.result.exitCode}`}
              {e.result.reduced ? <span className="muted"> · отчёт reslop</span> : null} <span className="muted small">{clock(e.time)}</span>
            </summary>
            <pre>{e.result.output.join('\n') || '(нет вывода)'}</pre>
          </details>
        ) : null,
      )}
    </div>
  );
}

function Plans({ root, runId, events }: { root: string; runId: string; events: TimedEvent[] }): ReactNode {
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const written = events.filter((e) => e.type === 'plan_written').length;
  useEffect(() => {
    void window.warband.plans(root, runId).then(setPlans);
  }, [root, runId, written]);
  if (plans.length === 0) return <p className="muted pad">Планов ревью нет: ревьюер ничего не вернул на доработку.</p>;
  return (
    <div className="plans">
      {plans.map((p) => (
        <article key={p.name} className="card">
          <h3>
            .plan/{p.name} <span className="muted small">· {p.status ?? 'без статуса'} · открытых пунктов: {p.open}</span>
          </h3>
          <Markdown text={p.text} />
        </article>
      ))}
    </div>
  );
}
