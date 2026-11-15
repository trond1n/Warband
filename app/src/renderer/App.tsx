import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { AppState, ProjectInfo, RunSummary } from '../shared/api.ts';
import { useConfirm } from './Dialog.tsx';
import { dayLabel, STAGE_LABEL, STATUS_LABEL } from './model.ts';
import { HooksView } from './Hooks.tsx';
import { ProvidersView } from './Providers.tsx';
import type { LeaveGuard } from './Providers.tsx';
import { RunView } from './RunView.tsx';

type View = { kind: 'new' } | { kind: 'run'; runId: string } | { kind: 'project' } | { kind: 'providers' } | { kind: 'hooks' };

/** Events that change what the run list shows. */
const LIST_EVENTS = new Set(['run_started', 'stage', 'gate_open', 'gate', 'run_finished']);

export function App(): ReactNode {
  const [state, setState] = useState<AppState>();
  const [project, setProject] = useState<ProjectInfo>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [view, setView] = useState<View>(() => {
    const run = /^#run=(.+)$/.exec(window.location.hash)?.[1];
    if (run) return { kind: 'run', runId: decodeURIComponent(run) };
    if (window.location.hash === '#view=providers') return { kind: 'providers' };
    return window.location.hash === '#view=hooks' ? { kind: 'hooks' } : { kind: 'new' };
  });
  const [collapsed, setCollapsed] = useState(false);
  const root = state?.current;

  // A settings form registers a guard; leaving it with unsaved edits asks first.
  const guard = useRef<LeaveGuard | null>(null);
  const setGuard = useCallback((g: LeaveGuard | null) => {
    guard.current = g;
  }, []);
  const [dialog, ask] = useConfirm();
  const navigate = useCallback(
    async (next: View): Promise<boolean> => {
      if (guard.current?.dirty()) {
        const leave = await ask({ title: 'Несохранённые правки', body: 'Изменения на этом экране не сохранены. Уйти без сохранения?', confirm: 'Уйти', danger: true });
        if (!leave) return false;
      }
      setView(next);
      return true;
    },
    [ask],
  );

  useEffect(() => {
    void window.warband.state().then(setState);
  }, []);

  const refresh = useCallback(async () => {
    if (!root) return;
    const [info, list] = await Promise.all([window.warband.project(root), window.warband.runs(root)]);
    setProject(info);
    setRuns(list);
  }, [root]);

  useEffect(() => {
    setProject(undefined);
    setRuns([]);
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      window.warband.onEvent((_runId, event) => {
        if (LIST_EVENTS.has(event.type)) void refresh();
      }),
    [refresh],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!state) return <div className="splash">Warband</div>;

  return (
    <div className={`shell${collapsed ? ' collapsed' : ''}`}>
      {dialog}
      <Sidebar
        state={state}
        runs={runs}
        view={view}
        onView={navigate}
        onState={setState}
        onCollapse={() => setCollapsed((c) => !c)}
      />
      <main className="content">
        {view.kind === 'providers' ? (
          <ProvidersView setGuard={setGuard} onSaved={async () => setState(await window.warband.state())} />
        ) : !root ? (
          <Welcome onAdd={async () => setState(await window.warband.addProject())} />
        ) : view.kind === 'hooks' ? (
          <HooksView key={root} root={root} setGuard={setGuard} />
        ) : view.kind === 'run' ? (
          <RunView key={view.runId} root={root} runId={view.runId} project={project} onChanged={refresh} />
        ) : view.kind === 'project' ? (
          <ProjectView project={project} />
        ) : (
          <NewTask
            project={project}
            tools={state.tools}
            onStarted={(runId) => {
              void refresh();
              void navigate({ kind: 'run', runId });
            }}
          />
        )}
      </main>
    </div>
  );
}

function Sidebar(props: {
  state: AppState;
  runs: RunSummary[];
  view: View;
  onView(view: View): Promise<boolean>;
  onState(state: AppState): void;
  onCollapse(): void;
}): ReactNode {
  const { state, runs, view } = props;
  const waiting = runs.filter((r) => r.status === 'waiting');
  const rest = runs.filter((r) => r.status !== 'waiting');
  const groups = useMemo(() => {
    const map = new Map<string, RunSummary[]>();
    for (const r of rest) {
      const label = dayLabel(r.started);
      map.set(label, [...(map.get(label) ?? []), r]);
    }
    return [...map];
  }, [rest]);
  const name = (root: string): string => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          ◆
        </span>
        <span className="brand-name">Warband</span>
        <button className="icon-button" title="Свернуть панель (Ctrl+B)" aria-label="Свернуть панель" onClick={props.onCollapse}>
          ⟨
        </button>
      </div>

      <label className="project-picker">
        <span className="sr-only">Проект</span>
        <select
          value={state.current ?? ''}
          onChange={async (e) => {
            const value = e.target.value;
            if (!(await props.onView({ kind: 'new' }))) return;
            if (value === '__add') props.onState(await window.warband.addProject());
            else props.onState(await window.warband.selectProject(value));
          }}
        >
          {!state.current && <option value="">Выберите проект</option>}
          {state.projects.map((p) => (
            <option key={p} value={p}>
              {name(p)}
            </option>
          ))}
          <option value="__add">+ Добавить проект…</option>
        </select>
      </label>

      <button className={`nav primary${view.kind === 'new' ? ' active' : ''}`} onClick={() => void props.onView({ kind: 'new' })}>
        + Новая задача
      </button>
      <h2 className="group">Настройка</h2>
      <button className={`nav${view.kind === 'providers' ? ' active' : ''}`} onClick={() => void props.onView({ kind: 'providers' })}>
        Провайдеры
      </button>
      <button className={`nav${view.kind === 'hooks' ? ' active' : ''}`} onClick={() => void props.onView({ kind: 'hooks' })} disabled={!state.current}>
        Хуки
      </button>
      <button className={`nav${view.kind === 'project' ? ' active' : ''}`} onClick={() => void props.onView({ kind: 'project' })} disabled={!state.current}>
        Проект: агенты и хуки
      </button>

      <nav className="runs" aria-label="Прогоны">
        {waiting.length > 0 && (
          <section>
            <h2 className="group waiting-title">Ждут вас · {waiting.length}</h2>
            {waiting.map((r) => (
              <RunItem key={r.runId} run={r} active={view.kind === 'run' && view.runId === r.runId} onOpen={() => void props.onView({ kind: 'run', runId: r.runId })} />
            ))}
          </section>
        )}
        {groups.map(([label, list]) => (
          <section key={label}>
            <h2 className="group">{label}</h2>
            {list.map((r) => (
              <RunItem key={r.runId} run={r} active={view.kind === 'run' && view.runId === r.runId} onOpen={() => void props.onView({ kind: 'run', runId: r.runId })} />
            ))}
          </section>
        ))}
        {runs.length === 0 && state.current && <p className="muted small pad">Прогонов пока нет.</p>}
      </nav>

      <footer className="tools" aria-label="Найденные инструменты">
        {state.tools.map((t) => (
          <span key={t.id} className={`tool${t.found ? ' found' : ''}`} title={t.found ? `${t.name} ${t.version ?? ''}${t.verified === false ? ' · адаптер не проверен' : ''}` : `${t.name} не найден`}>
            <span className="dot" aria-hidden="true" />
            {t.name}
          </span>
        ))}
      </footer>
    </aside>
  );
}

function RunItem({ run, active, onOpen }: { run: RunSummary; active: boolean; onOpen(): void }): ReactNode {
  return (
    <button className={`run-item${active ? ' active' : ''}`} onClick={onOpen}>
      <span className={`status-dot ${run.status}`} aria-hidden="true" />
      <span className="run-text">
        <span className="run-task">{run.task.split('\n')[0]}</span>
        <span className="run-meta">
          /{run.agent} · {run.status === 'waiting' || run.status === 'running' ? (STAGE_LABEL[run.stage ?? ''] ?? run.stage) : STATUS_LABEL[run.status]}
        </span>
      </span>
    </button>
  );
}

function Welcome({ onAdd }: { onAdd(): void }): ReactNode {
  return (
    <div className="empty">
      <h1>Warband</h1>
      <p className="muted">Выберите папку проекта: git-репозиторий, в котором есть агенты в <code>.warband/</code>.</p>
      <button className="button primary" onClick={onAdd}>
        Добавить проект
      </button>
    </div>
  );
}

function NewTask({ project, tools, onStarted }: { project: ProjectInfo | undefined; tools: AppState['tools']; onStarted(runId: string): void }): ReactNode {
  const [agent, setAgent] = useState('');
  const [task, setTask] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const agents = project?.agents ?? [];

  useEffect(() => {
    if (agents.length > 0 && !agents.some((a) => a.name === agent)) setAgent(agents[0]?.name ?? '');
  }, [agents, agent]);

  if (!project) return <div className="page muted">Загрузка проекта…</div>;

  const start = async (): Promise<void> => {
    if (!agent || task.trim() === '' || busy) return;
    setBusy(true);
    setError('');
    // Preconditions (worktree, CLIs) are checked before the run starts; this can take a few seconds.
    const result = await window.warband.start(project.root, agent, task);
    setBusy(false);
    if ('error' in result) setError(result.error);
    else {
      setTask('');
      onStarted(result.runId);
    }
  };

  return (
    <div className="page narrow">
      <h1>Новая задача</h1>
      <p className="muted">
        {project.name}
        {project.branch ? ` · ветка ${project.branch}` : ''}. Работа идёт в отдельном worktree, ваша рабочая копия не меняется.
      </p>

      {agents.length === 0 ? (
        <div className="callout">
          В проекте нет агентов. Создайте агента в терминале: <code>warband agent new</code> (в папке проекта), затем вернитесь сюда.
        </div>
      ) : (
        <>
          <fieldset className="agents">
            <legend>Агент</legend>
            {agents.map((a) => (
              <label key={a.name} className={`agent-card${agent === a.name ? ' selected' : ''}`}>
                <input type="radio" name="agent" value={a.name} checked={agent === a.name} onChange={() => setAgent(a.name)} />
                <span className="agent-name">/{a.name}</span>
                <span className="agent-desc">{a.description.split('\n')[0]}</span>
                <span className="agent-roles">
                  пишет {a.roles.implementer.runner}/{a.roles.implementer.model ?? 'по умолчанию'} · проверяет {a.roles.reviewer.runner}/
                  {a.roles.reviewer.model ?? 'по умолчанию'}
                </span>
                <span className="agent-roles">
                  {a.skills.length > 0 ? `скиллы: ${a.skills.join(', ')}` : 'без скиллов'} · {a.hooks.length > 0 ? `хуки: ${a.hooks.join(', ')}` : 'без хуков'}
                </span>
              </label>
            ))}
          </fieldset>

          <label className="field">
            <span>Задача</span>
            <textarea
              value={task}
              rows={8}
              placeholder="Что сделать. Чем конкретнее, тем меньше вопросов от планировщика."
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void start();
              }}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <button className="button primary" disabled={busy || !agent || task.trim() === ''} onClick={() => void start()}>
              {busy ? 'Запускаю…' : 'Запустить'}
            </button>
            <span className="muted small">Ctrl+Enter</span>
          </div>
        </>
      )}
      {project.problems.length > 0 && (
        <div className="callout warn">
          {project.problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      {!tools.some((t) => t.id === 'reslop' && t.found) && (
        <p className="muted small">reslop не найден: хуки с «reduce» дают полный вывод, а ревью в reslop недоступно (npm i -g reslop).</p>
      )}
    </div>
  );
}

function ProjectView({ project }: { project: ProjectInfo | undefined }): ReactNode {
  if (!project) return <div className="page muted">Загрузка проекта…</div>;
  return (
    <div className="page">
      <h1>{project.name}</h1>
      <p className="muted">
        {project.root}
        {project.branch ? ` · ветка ${project.branch}` : ''}
      </p>
      <div className="row">
        <button className="button" onClick={() => void window.warband.openPath(`${project.root}/.warband`)}>
          Открыть .warband
        </button>
        <span className="muted small">Агенты создаются командой warband agent new; файлы можно править руками.</span>
      </div>

      <h2>Агенты</h2>
      <div className="cards">
        {project.agents.map((a) => (
          <article key={a.name} className="card">
            <h3>/{a.name}</h3>
            <p>{a.description}</p>
            <dl>
              <dt>Пишет</dt>
              <dd>
                {a.roles.implementer.runner} / {a.roles.implementer.model ?? 'по умолчанию'}
              </dd>
              <dt>Проверяет</dt>
              <dd>
                {a.roles.reviewer.runner} / {a.roles.reviewer.model ?? 'по умолчанию'}
              </dd>
              <dt>Скиллы</dt>
              <dd>{a.skills.join(', ') || '—'}</dd>
              <dt>Хуки</dt>
              <dd>{a.hooks.join(', ') || '—'}</dd>
            </dl>
          </article>
        ))}
        {project.agents.length === 0 && <p className="muted">Агентов нет.</p>}
      </div>

      <h2>Скиллы</h2>
      <ul className="plain">
        {project.skills.map((s) => (
          <li key={s.name}>
            <strong>{s.name}</strong> <span className="muted">{s.description}</span>
          </li>
        ))}
        {project.skills.length === 0 && <li className="muted">Скиллов нет.</li>}
      </ul>

      <h2>Хуки</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Имя</th>
            <th>Когда</th>
            <th>Команда</th>
            <th>Особенности</th>
          </tr>
        </thead>
        <tbody>
          {project.hooks.map((h) => (
            <tr key={h.name}>
              <td>{h.name}</td>
              <td>{STAGE_LABEL[h.stage] ?? h.stage}</td>
              <td>
                <code>{h.run}</code>
              </td>
              <td className="muted small">
                {[h.reduce ? 'через reslop' : '', ...Object.entries(h.env ?? {}).map(([k, v]) => `${k}=${v}`)].filter(Boolean).join(', ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
