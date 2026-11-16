import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { HookInfo, HookProblem, HooksView as View, TrialResult } from '../shared/api.ts';
import { useConfirm } from './Dialog.tsx';
import { blankForm, copyName, formOf, inputOf, isDirty, normalName, problemText, secondsText, STAGES, usedByText } from './hooks-model.ts';
import type { HookForm } from './hooks-model.ts';
import type { LeaveGuard } from './Providers.tsx';

/*
 * The project's hooks: the list on the left, one hook's form on the right.
 * Every write goes through the core (saveHook, deleteHook) in the main
 * process. A trial run shows the exact command line in a modal first, and
 * the main process runs only the command that was confirmed.
 */

/** What the form is showing: nothing, a saved hook by its name, or a new one. */
type Mode = { kind: 'none' } | { kind: 'edit'; name: string } | { kind: 'new' };

export function HooksView({ root, setGuard }: { root: string; setGuard(guard: LeaveGuard | null): void }): ReactNode {
  const [view, setView] = useState<View>();
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [form, setForm] = useState<HookForm>(blankForm);
  const [problems, setProblems] = useState<HookProblem[]>([]);
  const [message, setMessage] = useState('');
  /** hooks.json changed on disk while the form had edits. */
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trial, setTrial] = useState<TrialResult | 'running'>();
  const [dialog, ask] = useConfirm();

  const saved: HookInfo | undefined = mode.kind === 'edit' ? view?.hooks.find((h) => h.hook.name === mode.name) : undefined;
  const dirty = mode.kind !== 'none' && isDirty(form, saved?.hook);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    setGuard({ dirty: () => dirtyRef.current });
    return () => setGuard(null);
  }, [setGuard]);

  // Leaving the screen stops a trial run that is still going.
  useEffect(() => () => void window.warband.cancelTrial(), []);

  /** Shows `next` and puts the form on `target`, dropping edits. */
  const apply = useCallback((next: View, target: Mode) => {
    setView(next);
    const info = target.kind === 'edit' ? next.hooks.find((h) => h.hook.name === target.name) : undefined;
    const resolved: Mode = target.kind === 'edit' && !info ? { kind: 'none' } : target;
    setMode(resolved);
    setForm(info ? formOf(info.hook) : blankForm());
    setProblems([]);
    setStale(false);
  }, []);

  useEffect(() => {
    void window.warband.hooks(root).then((next) => apply(next, next.hooks[0] ? { kind: 'edit', name: next.hooks[0].hook.name } : { kind: 'none' }));
  }, [root, apply]);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const versionRef = useRef(view?.version);
  versionRef.current = view?.version;
  const reload = useCallback(async () => {
    apply(await window.warband.hooks(root), modeRef.current);
    setMessage('');
  }, [apply, root]);

  // hooks.json or an agent changed on disk: take it if nothing is being edited, otherwise say so.
  useEffect(
    () =>
      window.warband.onWorkspaceChanged(async (changed) => {
        if (changed !== root) return;
        const next = await window.warband.hooks(root);
        // Only agents changed: "used by" changes, the form does not.
        if (next.version === versionRef.current) return setView(next);
        if (dirtyRef.current) setStale(true);
        else apply(next, modeRef.current);
      }),
    [apply, root],
  );

  const askLeave = (): Promise<boolean> =>
    ask({ title: 'Несохранённые правки', body: 'Хук изменён и не сохранён. Уйти без сохранения?', confirm: 'Уйти', danger: true });

  const open = async (target: Mode, fill?: HookForm): Promise<void> => {
    if (dirty && !(await askLeave())) return;
    setMode(target);
    const info = target.kind === 'edit' ? view?.hooks.find((h) => h.hook.name === target.name) : undefined;
    setForm(fill ?? (info ? formOf(info.hook) : blankForm()));
    setProblems([]);
    setMessage('');
    setTrial(undefined);
  };

  /** Asks before a rename rewrites agent files; true when the person agrees. */
  const confirmRename = (from: string, to: string, agents: string[]): Promise<boolean> =>
    ask({
      title: `Переименовать хук «${from}» в «${to}»?`,
      body: (
        <>
          <p>Хук используют агенты. В их файлах ссылка поменяется на новое имя:</p>
          <ul className="plain">
            {agents.map((a) => (
              <li key={a}>
                <code>/{a}</code> <span className="muted small">.warband/agents/{a}.json</span>
              </li>
            ))}
          </ul>
          <p className="muted">Хук и агенты меняются одной операцией: если что-то не запишется, всё останется как было.</p>
        </>
      ),
      confirm: 'Переименовать',
    });

  const save = async (): Promise<void> => {
    if (!view || busy || mode.kind === 'none') return;
    const original = mode.kind === 'edit' ? mode.name : null;
    const newName = normalName(form.name);
    let renameAgents: string[] | undefined;
    if (original !== null && newName !== original && saved?.usedBy && saved.usedBy.length > 0) {
      if (!(await confirmRename(original, newName, saved.usedBy))) return;
      renameAgents = saved.usedBy;
    }
    setBusy(true);
    setMessage('');
    let result = await window.warband.saveHook(root, inputOf(form), original, view.version, renameAgents);
    // The agents that use the hook changed since the list was shown (or were unknown): ask again with the list of now.
    const again = !result.ok && 'problems' in result && result.problems.length === 1 ? result.problems.find((p) => p.code === 'rename-in-use') : undefined;
    if (again && original !== null) {
      setBusy(false);
      if (!(await confirmRename(original, newName, again.agents ?? []))) return;
      setBusy(true);
      result = await window.warband.saveHook(root, inputOf(form), original, view.version, again.agents ?? []);
    }
    setBusy(false);
    if (result.ok) {
      // Our own write must not look like someone else's change when the watcher reports it.
      versionRef.current = result.version;
      apply(await window.warband.hooks(root), { kind: 'edit', name: result.name });
      setMessage('Сохранено в .warband/hooks.json.');
    } else if ('problems' in result) setProblems(result.problems);
    else if ('changed' in result) setStale(true);
    else setMessage(result.error);
  };

  const duplicate = async (): Promise<void> => {
    if (!view || mode.kind !== 'edit') return;
    const taken = view.hooks.map((h) => h.hook.name);
    await open({ kind: 'new' }, { ...form, name: copyName(mode.name, taken) });
    setMessage('Копия ещё не сохранена: проверьте имя и сохраните.');
  };

  const remove = async (): Promise<void> => {
    if (!view || !saved) return;
    if (saved.usedBy && saved.usedBy.length > 0) {
      await usedDialog(saved.hook.name, saved.usedBy);
      return;
    }
    const ok = await ask({
      title: `Удалить хук «${saved.hook.name}»?`,
      body: (
        <p>
          Он будет удалён из <code>.warband/hooks.json</code>. Агенты его не используют.
        </p>
      ),
      confirm: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    const result = await window.warband.deleteHook(root, saved.hook.name, view.version);
    if (result.ok) {
      versionRef.current = result.version;
      const next = await window.warband.hooks(root);
      apply(next, next.hooks[0] ? { kind: 'edit', name: next.hooks[0].hook.name } : { kind: 'none' });
      setMessage('');
    } else if ('usedBy' in result) await usedDialog(saved.hook.name, result.usedBy);
    else if ('changed' in result) setStale(true);
    else setMessage(result.error);
  };

  const usedDialog = (name: string, agents: string[]): Promise<boolean> =>
    ask({
      title: `Хук «${name}» используется`,
      body: (
        <>
          <p>Его используют агенты:</p>
          <ul className="plain">
            {agents.map((a) => (
              <li key={a}>
                <code>/{a}</code>
              </li>
            ))}
          </ul>
          <p className="muted">Уберите хук из этих агентов, тогда его можно будет удалить. Пока ссылки есть, хук не удаляется.</p>
        </>
      ),
      confirm: 'Понятно',
      single: true,
    });

  const runTrial = async (): Promise<void> => {
    if (trial === 'running') return;
    setProblems([]);
    const input = inputOf(form);
    // The main process works out the exact command line; the person sees it whole before anything runs.
    const request = await window.warband.trialRequest(root, input);
    if ('problems' in request) {
      setProblems(request.problems);
      return;
    }
    const env = Object.entries(request.env);
    const ok = await ask({
      title: 'Выполнить команду в папке проекта?',
      body: (
        <>
          <p className="muted small">Команда</p>
          <pre className="confirm-command">{request.command}</pre>
          <p className="muted small">Папка</p>
          <pre className="confirm-command">{request.cwd}</pre>
          {env.length > 0 && (
            <>
              <p className="muted small">Переменные окружения</p>
              <pre className="confirm-command">{env.map(([k, v]) => `${k}=${v}`).join('\n')}</pre>
            </>
          )}
          <p>
            Это произвольная команда оболочки. Она выполнится с вашими правами прямо в рабочей копии проекта, не в отдельном worktree, как <code>warband check</code>.
          </p>
        </>
      ),
      confirm: 'Выполнить',
      danger: true,
    });
    if (!ok) return;
    setTrial('running');
    const result = await window.warband.trialHook(root, input, request.command);
    if (result.status === 'invalid') {
      setProblems(result.problems);
      setTrial(undefined);
    } else setTrial(result);
  };

  if (!view) return <div className="page muted">Читаю .warband/hooks.json…</div>;

  const reslopNote = view.reslop ? (
    <span className="muted small">
      reslop найден: <code>{view.reslop}</code>
    </span>
  ) : (
    <span className="muted small">reslop не найден на PATH: флажок сохранится, но вывод будет полным (npm i -g reslop).</span>
  );

  return (
    <div className="page split">
      {dialog}
      <section className="split-list" aria-label="Хуки">
        <h1>Хуки</h1>
        <p className="muted small">Проверки кодом, без модели: линтер, тесты, pre-commit. Файл проекта .warband/hooks.json.</p>
        <button className="button primary" onClick={() => void open({ kind: 'new' })}>
          + Создать
        </button>
        {view.hooks.map(({ hook, usedBy }) => (
          <button
            key={hook.name}
            className={`list-item${mode.kind === 'edit' && mode.name === hook.name ? ' active' : ''}`}
            onClick={() => void (mode.kind === 'edit' && mode.name === hook.name ? undefined : open({ kind: 'edit', name: hook.name }))}
          >
            <span className="run-text">
              <span className="run-task">{hook.name}</span>
              <span className="run-meta">
                {hook.stage} · {usedByText(usedBy)}
              </span>
            </span>
          </button>
        ))}
        {mode.kind === 'new' && (
          <div className="list-item active" aria-current="true">
            <span className="run-text">
              <span className="run-task">{form.name.trim() || 'новый хук'}</span>
              <span className="run-meta">не сохранён</span>
            </span>
          </div>
        )}
      </section>

      <section className="split-form" aria-label="Хук">
        {view.error && (
          <div className="callout warn" role="alert">
            Не удалось прочитать .warband/hooks.json: {view.error}
          </div>
        )}
        {view.agentsError && (
          <div className="callout warn" role="alert">
            Не удалось прочитать агентов, поэтому не видно, кто использует хуки: {view.agentsError}
          </div>
        )}
        {stale && (
          <div className="callout warn" role="alert">
            Файл .warband/hooks.json изменился на диске, пока форма была открыта. Ваши правки не сохранены.{' '}
            <button className="link" onClick={() => void reload()}>
              Перечитать
            </button>{' '}
            (правки пропадут)
          </div>
        )}

        {mode.kind === 'none' ? (
          <div className="empty">
            <h2>{view.hooks.length === 0 ? 'В проекте нет хуков' : 'Выберите хук слева'}</h2>
            <p className="muted">Хук запускает команду в worktree задачи на одной из стадий. Его вердикт — код возврата.</p>
            <button className="button primary" onClick={() => void open({ kind: 'new' })}>
              Создать
            </button>
          </div>
        ) : (
          <>
            <h2>{mode.kind === 'new' ? 'Новый хук' : mode.name}</h2>
            {saved && <p className="muted small">{usedByText(saved.usedBy)}</p>}

            <label className="field">
              <span>Имя</span>
              <input
                type="text"
                value={form.name}
                spellCheck={false}
                placeholder="например lint или unit"
                aria-invalid={problems.some((p) => p.field === 'name')}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <FieldProblems problems={problems} field="name" original={mode.kind === 'edit' ? mode.name : undefined} />

            <label className="field">
              <span>Описание</span>
              <input type="text" className="plain-font" value={form.description} placeholder="что проверяет" onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>

            <label className="field">
              <span>Команда</span>
              <textarea
                className="mono"
                rows={2}
                value={form.run}
                spellCheck={false}
                placeholder="npm test"
                aria-invalid={problems.some((p) => p.field === 'run')}
                onChange={(e) => setForm({ ...form, run: e.target.value })}
              />
            </label>
            <FieldProblems problems={problems} field="run" />
            <p className="muted small">
              <code>{'{warband}'}</code> в команде заменяется полным путём к папке .warband этого проекта (<code>{view.warbandDir}</code>). Хуки идут в worktree из последнего
              коммита, где незакоммиченной .warband нет, поэтому свой скрипт оттуда запускают так: <code>{'node "{warband}/hooks/check.mjs"'}</code>.
            </p>

            <fieldset className="field stages">
              <legend>Стадия</legend>
              {STAGES.map((s) => (
                <label key={s.id} className="check">
                  <input type="radio" name="stage" value={s.id} checked={form.stage === s.id} onChange={() => setForm({ ...form, stage: s.id })} />
                  <span>
                    <code>{s.label}</code> <span className="muted">{s.about}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <FieldProblems problems={problems} field="stage" />

            <EnvRows rows={form.env} problems={problems} onChange={(env) => setForm({ ...form, env })} />

            <div className="field">
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.reduce}
                  // Off on another stage there is nothing to choose; on, the person can always take it off.
                  disabled={form.stage !== 'checks' && !form.reduce}
                  aria-invalid={problems.some((p) => p.field === 'reduce')}
                  onChange={(e) => setForm({ ...form, reduce: e.target.checked })}
                />
                <span>
                  reduce: пропускать вывод через <code>reslop t</code>, чтобы ошибка возвращалась коротким отчётом
                  {form.stage !== 'checks' && <span className="muted"> (только для стадии checks)</span>}
                </span>
              </label>
              <FieldProblems problems={problems} field="reduce" />
              {reslopNote}
            </div>

            <div className="row">
              <button className="button primary" disabled={!dirty || busy || stale} onClick={() => void save()}>
                {busy ? 'Сохраняю…' : 'Сохранить'}
              </button>
              <button
                className="button"
                disabled={!dirty || busy}
                onClick={() => {
                  setForm(saved ? formOf(saved.hook) : blankForm());
                  setProblems([]);
                }}
              >
                Отменить правки
              </button>
              <button className="button" disabled={mode.kind !== 'edit' || busy} onClick={() => void duplicate()}>
                Дублировать
              </button>
              <button className="button danger" disabled={mode.kind !== 'edit' || busy} onClick={() => void remove()}>
                Удалить
              </button>
              {message && <span className="muted small">{message}</span>}
            </div>

            <h3>Пробный запуск</h3>
            <p className="muted small">
              Выполняет хук в том виде, как он сейчас в форме, в папке проекта (<code>{root}</code>), как <code>warband check</code>. Перед запуском окно покажет точную
              команду и спросит подтверждение.
            </p>
            <div className="row">
              <button className="button" disabled={trial === 'running' || form.run.trim() === ''} onClick={() => void runTrial()}>
                {trial === 'running' ? 'Идёт пробный запуск…' : 'Пробный запуск'}
              </button>
              {trial === 'running' && (
                <button className="button" onClick={() => void window.warband.cancelTrial()}>
                  Остановить
                </button>
              )}
            </div>
            {trial && trial !== 'running' && <TrialView result={trial} />}
          </>
        )}
      </section>
    </div>
  );
}

function FieldProblems({ problems, field, original }: { problems: HookProblem[]; field: HookProblem['field']; original?: string | undefined }): ReactNode {
  const list = problems.filter((p) => p.field === field);
  if (list.length === 0) return null;
  return (
    <ul className="field-errors" role="alert">
      {list.map((p) => (
        <li key={`${p.code}-${p.key ?? ''}`}>{problemText(p, original)}</li>
      ))}
    </ul>
  );
}

function EnvRows({ rows, problems, onChange }: { rows: [string, string][]; problems: HookProblem[]; onChange(rows: [string, string][]): void }): ReactNode {
  const bad = new Set(problems.filter((p) => p.field === 'env').map((p) => p.key ?? ''));
  const set = (i: number, k: 0 | 1, value: string): void => onChange(rows.map((row, j) => (j === i ? ((k === 0 ? [value, row[1]] : [row[0], value]) as [string, string]) : row)));
  return (
    <fieldset className="field">
      <legend>Переменные окружения</legend>
      {rows.length === 0 && <span className="muted small">Нет. Например NX_DAEMON=false, чтобы Nx не оставлял демон, держащий worktree.</span>}
      {rows.map(([key, value], i) => (
        <div key={i} className="env-row">
          <input type="text" aria-label="Имя переменной" value={key} placeholder="ИМЯ" spellCheck={false} aria-invalid={bad.has(key.trim())} onChange={(e) => set(i, 0, e.target.value)} />
          <span aria-hidden="true">=</span>
          <input type="text" aria-label="Значение" value={value} placeholder="значение" spellCheck={false} onChange={(e) => set(i, 1, e.target.value)} />
          <button className="icon-button" title="Убрать переменную" aria-label="Убрать переменную" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <div>
        <button className="link" onClick={() => onChange([...rows, ['', '']])}>
          + переменная
        </button>
      </div>
      <FieldProblems problems={problems} field="env" />
    </fieldset>
  );
}

function TrialView({ result }: { result: TrialResult }): ReactNode {
  // The result lands below the form; bring it into view.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Not returned: scrollIntoView gives a promise in this Chromium, and React would call it as a cleanup.
    void ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [result]);
  if (result.status === 'refused') return <p className="error">{result.error}</p>;
  if (result.status !== 'finished' && result.status !== 'cancelled') return null;
  const verdict =
    result.status === 'cancelled'
      ? 'остановлен'
      : result.timedOut
        ? 'превышено время'
        : result.ok
          ? 'успешно'
          : 'упал';
  return (
    <div ref={ref} className={`trial ${result.ok ? 'ok' : 'failed'}`} role="status">
      <dl className="facts">
        <dt>Итог</dt>
        <dd className={result.ok ? '' : 'error'}>{verdict}</dd>
        <dt>Код возврата</dt>
        <dd>{result.exitCode ?? '—'}</dd>
        <dt>Время</dt>
        <dd>{secondsText(result.seconds)}</dd>
        <dt>Команда</dt>
        <dd>
          <code>{result.command}</code>
        </dd>
      </dl>
      <div className="muted small">
        {result.reduced ? 'Короткий отчёт reslop' : 'Последние строки вывода'} ({result.output.length}):
      </div>
      <pre className="trial-output">{result.output.length > 0 ? result.output.join('\n') : '(вывода нет)'}</pre>
      {result.logs && (result.logs.removed.length > 0 || result.logs.restored.length > 0) && (
        <p className="muted small">
          reslop записал журнал этого запуска в <code>.log/</code> рабочей копии; он убран (файлов: {result.logs.removed.length})
          {result.logs.restored.length > 0 && <>, а старые записи, которые reslop удалил при ротации, возвращены (файлов: {result.logs.restored.length})</>}. Остальное в
          .log/ не тронуто.
        </p>
      )}
    </div>
  );
}
