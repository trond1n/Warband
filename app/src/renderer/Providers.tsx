import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ProbeState, ProviderInfo, ProviderProblem, ProvidersView as View, RunnerId } from '../shared/api.ts';
import { useConfirm } from './Dialog.tsx';
import { Markdown } from './Markdown.tsx';
import { adapterLabel, APPROVALS_LABEL, DOCS_SECTION, driftText, formOf, isDirty, loginLabel, probeRow, problemText, SANDBOX_LABEL, settingsOf } from './providers-model.ts';
import type { ProviderForm } from './providers-model.ts';

/*
 * The agent CLIs on this machine: one card per CLI on the left, its state,
 * settings and probes on the right. Settings go to providers.json in the
 * app's settings folder, never to a project's .warband.
 */

export interface LeaveGuard {
  /** True when leaving would lose edits. */
  dirty(): boolean;
}

export function ProvidersView({ setGuard, onSaved }: { setGuard(guard: LeaveGuard | null): void; onSaved(): void }): ReactNode {
  const [view, setView] = useState<View>();
  const [selected, setSelected] = useState<RunnerId>('claude');
  const [form, setForm] = useState<ProviderForm>({ binary: '', models: '' });
  const [problems, setProblems] = useState<ProviderProblem[]>([]);
  const [message, setMessage] = useState('');
  /** providers.json changed on disk while the form had edits. */
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialog, ask] = useConfirm();

  const current = view?.providers.find((p) => p.id === selected);
  const dirty = current ? isDirty(form, current.settings) : false;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    setGuard({ dirty: () => dirtyRef.current });
    return () => setGuard(null);
  }, [setGuard]);

  const apply = useCallback((next: View, id: RunnerId) => {
    setView(next);
    const info = next.providers.find((p) => p.id === id);
    if (info) setForm(formOf(info.settings));
    setProblems([]);
    setStale(false);
  }, []);

  const reload = useCallback(async () => apply(await window.warband.providers(), selected), [apply, selected]);

  useEffect(() => {
    void window.warband.providers().then((next) => apply(next, 'claude'));
  }, [apply]);

  // Someone else changed providers.json: take it if nothing is being edited, otherwise say so.
  const versionRef = useRef(view?.version);
  versionRef.current = view?.version;
  useEffect(
    () =>
      window.warband.onProvidersChanged(async () => {
        const next = await window.warband.providers();
        if (next.version === versionRef.current) return;
        if (dirtyRef.current) setStale(true);
        else apply(next, selected);
      }),
    [apply, selected],
  );

  useEffect(
    () =>
      window.warband.onProbe((id, state) => {
        setView((v) => (v ? { ...v, providers: v.providers.map((p) => (p.id === id ? { ...p, probe: state } : p)) } : v));
      }),
    [],
  );

  const select = async (id: RunnerId): Promise<void> => {
    if (id === selected || !view) return;
    if (dirty && !(await askLeave())) return;
    setSelected(id);
    const info = view.providers.find((p) => p.id === id);
    if (info) setForm(formOf(info.settings));
    setProblems([]);
    setMessage('');
  };

  const askLeave = (): Promise<boolean> =>
    ask({ title: 'Несохранённые правки', body: 'Настройки этого CLI изменены и не сохранены. Уйти без сохранения?', confirm: 'Уйти', danger: true });

  const save = async (): Promise<void> => {
    if (!view || !current || saving) return;
    setSaving(true);
    setMessage('');
    const result = await window.warband.saveProvider(current.id, settingsOf(form), view.version);
    setSaving(false);
    if (result.ok) {
      setProblems([]);
      await reload();
      setMessage('Сохранено.');
      onSaved();
    } else if ('problems' in result) setProblems(result.problems);
    else if ('changed' in result) setStale(true);
    else setMessage(result.error);
  };

  const probe = async (info: ProviderInfo): Promise<void> => {
    const ok = await ask({
      title: `Проверить ${info.name}?`,
      body: (
        <>
          <p>
            Будет запущено несколько проб из <code>scripts/spike</code>, по очереди, каждая во временной пустой папке. Каждая проба делает настоящий вызов
            модели и тратит лимит подписки. Это займёт от одной до нескольких минут.
          </p>
          <p className="muted">Результат не меняет отметку «адаптер подтверждён»: она задаётся в коде после разбора проб.</p>
        </>
      ),
      confirm: 'Запустить пробы',
    });
    if (ok) await window.warband.probe(info.id);
  };

  if (!view) return <div className="page muted">Ищу установленные CLI…</div>;

  return (
    <div className="page split">
      {dialog}
      <section className="split-list" aria-label="CLI">
        <h1>Провайдеры</h1>
        <p className="muted small">Агентные CLI на этом компьютере. Настройки общие для всех проектов.</p>
        {view.providers.map((p) => (
          <button key={p.id} className={`list-item${p.id === selected ? ' active' : ''}`} onClick={() => void select(p.id)}>
            <span className={`status-dot ${p.found ? 'done' : 'off'}`} aria-hidden="true" />
            <span className="run-text">
              <span className="run-task">{p.name}</span>
              <span className="run-meta">
                {p.found ? (p.version ?? 'установлен') : 'не найден'}
                {p.capabilities.verified ? ' · подтверждён' : ''}
                {p.drift.kind === 'differs' || p.drift.kind === 'unknown' ? ' · версия отличается' : ''}
              </span>
            </span>
          </button>
        ))}
        <div className="muted small pad">
          Новый CLI добавляется адаптером в коде, не через окно: <DocsLink section="adding">Adding a runner</DocsLink>
        </div>
      </section>

      {current && (
        <section className="split-form" aria-label={current.name}>
          <h2>{current.name}</h2>
          {view.error && (
            <div className="callout warn" role="alert">
              Не удалось прочитать файл настроек: {view.error}
            </div>
          )}
          {stale && (
            <div className="callout warn" role="alert">
              Файл настроек изменился на диске, пока форма была открыта. Ваши правки не сохранены.{' '}
              <button className="link" onClick={() => void reload()}>
                Перечитать
              </button>{' '}
              (правки пропадут)
            </div>
          )}

          <dl className="facts">
            <dt>Установлен</dt>
            <dd>
              {current.found ? `да, ${current.version ?? 'версия не сообщается'}` : 'нет'}
              {current.problem ? <span className="muted"> · {current.problem}</span> : null}
            </dd>
            <dt>Запускается</dt>
            <dd>
              <code>{current.binary}</code>
              {current.settings.binary ? ' (путь задан здесь)' : ' (ищется в PATH)'}
            </dd>
            <dt>Адаптер</dt>
            <dd>{adapterLabel(current.capabilities)}</dd>
            <dt>Песочница</dt>
            <dd>{SANDBOX_LABEL[current.capabilities.sandbox]}</dd>
            <dt>Разрешения без человека</dt>
            <dd>{APPROVALS_LABEL[current.capabilities.headlessApprovals]}</dd>
            <dt>Вход</dt>
            <dd>{loginLabel(current.login, current.found)}</dd>
          </dl>
          {driftText(current.drift) && (
            <div className="callout warn drift" role="status">
              {driftText(current.drift)}{' '}
              <button className="link" disabled={current.probe.running} onClick={() => void probe(current)}>
                Запустить пробы
              </button>
            </div>
          )}
          <div className="small">
            <DocsLink section={DOCS_SECTION[current.id]}>Подробнее в docs/runners.md</DocsLink>
          </div>
          {current.id === 'claude' && (
            <div className="note small">
              GLM работает через Claude Code: его подключают в настройках самого Claude Code, отдельного адаптера нет. <DocsLink section="glm">О GLM</DocsLink>
            </div>
          )}

          <h3>Настройки</h3>
          <label className="field">
            <span>Путь к программе</span>
            <input
              type="text"
              value={form.binary}
              placeholder={`пусто: искать «${current.command}» в PATH`}
              spellCheck={false}
              aria-invalid={problems.some((p) => p.field === 'binary')}
              onChange={(e) => setForm({ ...form, binary: e.target.value })}
            />
          </label>
          <FieldProblems problems={problems} field="binary" />
          <label className="field">
            <span>Модели, по одной в строке</span>
            <textarea
              value={form.models}
              rows={5}
              spellCheck={false}
              placeholder="например opus или sonnet"
              aria-invalid={problems.some((p) => p.field === 'models')}
              onChange={(e) => setForm({ ...form, models: e.target.value })}
            />
          </label>
          <FieldProblems problems={problems} field="models" />
          <p className="muted small">Список ведёте вы. Он появится при выборе модели в форме агента.</p>
          <div className="row">
            <button className="button primary" disabled={!dirty || saving || stale} onClick={() => void save()}>
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
            <button
              className="button"
              disabled={!dirty || saving}
              onClick={() => {
                setForm(formOf(current.settings));
                setProblems([]);
              }}
            >
              Отменить правки
            </button>
            {message && <span className="muted small">{message}</span>}
          </div>
          <p className="muted small">
            Файл: <code>{view.file}</code>. Его же читают <code>warband doctor</code> и <code>warband run</code>.
          </p>

          <h3>Проверка</h3>
          <Probes info={current} onStart={() => void probe(current)} />
        </section>
      )}
    </div>
  );
}

function FieldProblems({ problems, field }: { problems: ProviderProblem[]; field: ProviderProblem['field'] }): ReactNode {
  const list = problems.filter((p) => p.field === field);
  if (list.length === 0) return null;
  return (
    <ul className="field-errors" role="alert">
      {list.map((p) => (
        <li key={`${p.code}-${p.model ?? ''}`}>{problemText(p)}</li>
      ))}
    </ul>
  );
}

/** Shows a section of docs/runners.md in place; the text is rendered without HTML. */
function DocsLink({ section, children }: { section: string; children: ReactNode }): ReactNode {
  const [text, setText] = useState<string>();
  const [open, setOpen] = useState(false);
  const toggle = async (): Promise<void> => {
    if (!open && text === undefined) setText(await window.warband.runnerDocs(section).catch(() => 'Раздел не найден.'));
    setOpen(!open);
  };
  return (
    <>
      <button className="link" aria-expanded={open} onClick={() => void toggle()}>
        {children}
      </button>
      {open && text !== undefined && (
        <div className="docs-box md" role="region">
          <Markdown text={text} />
        </div>
      )}
    </>
  );
}

function Probes({ info, onStart }: { info: ProviderInfo; onStart(): void }): ReactNode {
  const state: ProbeState = info.probe;
  return (
    <>
      <div className="row">
        <button className="button" disabled={!info.found || state.running} onClick={onStart}>
          {state.running ? `Идёт проба ${state.results.length + 1} из ${state.total}${state.current ? `: ${state.current}` : ''}…` : 'Проверить'}
        </button>
        {state.running && (
          <button className="button" onClick={() => void window.warband.cancelProbe()}>
            Остановить
          </button>
        )}
        {!info.found && <span className="muted small">CLI не найден, проверять нечего.</span>}
      </div>
      {state.error && <p className="error">{state.error}</p>}
      {state.results.length > 0 && (
        <table className="table probes">
          <thead>
            <tr>
              <th>Проба</th>
              <th>Что проверяет</th>
              <th>Ответ</th>
              <th>Файл</th>
              <th>Инструменты</th>
              <th>Выход</th>
              <th>Сек</th>
            </tr>
          </thead>
          <tbody>
            {state.results.map((r) => {
              const row = probeRow(r);
              return (
                <tr key={row.probe}>
                  <td className="nowrap">
                    <code>{row.probe}</code>
                  </td>
                  <td className="small">{row.about}</td>
                  <td>{row.answer}</td>
                  <td className="small">{row.file}</td>
                  <td className="small">{row.tools}</td>
                  <td>{row.exit}</td>
                  <td>{row.seconds}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {state.finished && !state.running && (
        <p className="muted small">
          Завершено {new Date(state.finished).toLocaleString('ru-RU')}. Здоровый результат: выход 0 везде; pong, read, edit и verdict с ответом, edit создал файл; write и пробы «outside» не дают ни маркера, ни файла.
        </p>
      )}
    </>
  );
}
