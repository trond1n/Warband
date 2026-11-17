import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { AgentInfo, AgentProblem, AgentsView as View, ProviderChoice } from '../shared/api.ts';
import {
  blankForm,
  formOf,
  hooksByStage,
  inputOf,
  isDirty,
  problemText,
  providerMarks,
  roleProblems,
  skillsTotal,
  STAGE_TITLE,
  summary,
  toggle,
} from './agents-model.ts';
import type { AgentDraft, AgentForm, AgentMode, RoleForm } from './agents-model.ts';
import { useConfirm } from './Dialog.tsx';
import { copyName, normalName } from './hooks-model.ts';
import type { LeaveGuard } from './Providers.tsx';
import { charsText } from './skills-model.ts';

/*
 * The project's agents: the list on the left, one agent's form on the
 * right. Skills and hooks are picked from the project; a new one is made on
 * its own screen and the form comes back as it was. Every write goes through
 * the core (saveAgentInput, deleteAgent) in the main process.
 */

export interface AgentsProps {
  root: string;
  setGuard(guard: LeaveGuard | null): void;
  /** The form as it was before the person went to make a skill or hook. */
  restore: AgentDraft | null;
  onRestored(): void;
  /** Go make a skill or hook for this form; it comes back through `restore`. */
  onCreate(kind: 'skill' | 'hook', draft: AgentDraft): void;
  /** Open "Новая задача" with this agent. */
  onRun(name: string): void;
  /** An agent was saved or deleted: the task screen's list changes. */
  onChanged(): void;
}

export function AgentsView({ root, setGuard, restore, onRestored, onCreate, onRun, onChanged }: AgentsProps): ReactNode {
  const [view, setView] = useState<View>();
  const [mode, setMode] = useState<AgentMode>({ kind: 'none' });
  const [form, setForm] = useState<AgentForm>(blankForm);
  const [problems, setProblems] = useState<AgentProblem[]>([]);
  const [message, setMessage] = useState('');
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, ask] = useConfirm();

  const blank = useMemo(() => blankForm(view?.providers), [view?.providers]);
  const saved: AgentInfo | undefined = mode.kind === 'edit' ? view?.agents.find((a) => a.agent.name === mode.name) : undefined;
  const dirty = mode.kind !== 'none' && isDirty(form, saved?.agent, blank);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    setGuard({ dirty: () => dirtyRef.current });
    return () => setGuard(null);
  }, [setGuard]);

  const openVersion = useRef<string | undefined>(undefined);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const apply = useCallback((next: View, target: AgentMode) => {
    setView(next);
    const info = target.kind === 'edit' ? next.agents.find((a) => a.agent.name === target.name) : undefined;
    setMode(target.kind === 'edit' && !info ? { kind: 'none' } : target);
    setForm(info ? formOf(info.agent) : blankForm(next.providers));
    openVersion.current = info?.version;
    setProblems([]);
    setStale(false);
  }, []);

  useEffect(() => {
    void window.warband.agents(root).then((next) => {
      if (restore) {
        // Back from making a skill or hook: the form as it was, with the new one picked.
        setView(next);
        setMode(restore.mode);
        const made = restore.created;
        const exists = made && (made.kind === 'skill' ? next.skills.some((s) => s.name === made.name) : next.hooks.some((h) => h.name === made.name));
        setForm(
          made && exists
            ? { ...restore.form, [made.kind === 'skill' ? 'skills' : 'hooks']: toggle(restore.form[made.kind === 'skill' ? 'skills' : 'hooks'], made.name, true) }
            : restore.form,
        );
        openVersion.current = restore.version;
        setMessage(made && exists ? `${made.kind === 'skill' ? 'Скилл' : 'Хук'} «${made.name}» создан и выбран. Агент ещё не сохранён.` : '');
        onRestored();
      } else apply(next, next.agents[0] ? { kind: 'edit', name: next.agents[0].agent.name } : { kind: 'none' });
    });
    // Runs once per project; `restore` is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, apply]);

  const reload = useCallback(async () => {
    apply(await window.warband.agents(root), modeRef.current);
    setMessage('');
  }, [apply, root]);

  // An agent, skill or hook changed on disk: take it if the open agent has no edits, otherwise say so.
  useEffect(
    () =>
      window.warband.onWorkspaceChanged(async (changed) => {
        if (changed !== root) return;
        const next = await window.warband.agents(root);
        const current = modeRef.current;
        if (current.kind !== 'edit') return setView(next);
        const info = next.agents.find((a) => a.agent.name === current.name);
        if (info?.version === openVersion.current) return setView(next);
        if (dirtyRef.current) setStale(true);
        else apply(next, current);
      }),
    [apply, root],
  );

  const askLeave = (): Promise<boolean> =>
    ask({ title: 'Несохранённые правки', body: 'Агент изменён и не сохранён. Уйти без сохранения?', confirm: 'Уйти', danger: true });

  const open = async (target: AgentMode, fill?: AgentForm): Promise<void> => {
    if (dirty && !(await askLeave())) return;
    setMode(target);
    const info = target.kind === 'edit' ? view?.agents.find((a) => a.agent.name === target.name) : undefined;
    setForm(fill ?? (info ? formOf(info.agent) : blank));
    openVersion.current = info?.version;
    setProblems([]);
    setMessage('');
    setStale(false);
  };

  const save = async (): Promise<void> => {
    if (!view || busy || mode.kind === 'none') return;
    const original = mode.kind === 'edit' ? mode.name : null;
    setBusy(true);
    setMessage('');
    const result = await window.warband.saveAgent(root, inputOf(form), original, openVersion.current ?? '');
    setBusy(false);
    if (result.ok) {
      openVersion.current = result.version;
      modeRef.current = { kind: 'edit', name: result.name };
      apply(await window.warband.agents(root), { kind: 'edit', name: result.name });
      setMessage(
        original !== null && original !== result.name
          ? `Переименован в /${result.name}. Прошлые прогоны остались под именем /${original}.`
          : `Сохранено в .warband/agents/${result.name}.json.`,
      );
      onChanged();
    } else if ('problems' in result) setProblems(result.problems);
    else if ('changed' in result) setStale(true);
    else setMessage(result.error);
  };

  const duplicate = async (): Promise<void> => {
    if (!view || mode.kind !== 'edit') return;
    await open({ kind: 'new' }, { ...form, name: copyName(mode.name, view.agents.map((a) => a.agent.name)) });
    setMessage('Копия ещё не сохранена: проверьте имя и сохраните.');
  };

  const remove = async (): Promise<void> => {
    if (!view || !saved) return;
    const ok = await ask({
      title: `Удалить агента /${saved.agent.name}?`,
      body: (
        <>
          <p>
            Файл <code>{saved.file}</code> будет удалён. Скиллы и хуки агента останутся в проекте.
          </p>
          <p className="muted">Журналы прошлых прогонов не трогаются: они по-прежнему откроются под именем /{saved.agent.name}.</p>
        </>
      ),
      confirm: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    const result = await window.warband.deleteAgent(root, saved.agent.name, saved.version);
    if (result.ok) {
      const next = await window.warband.agents(root);
      apply(next, next.agents[0] ? { kind: 'edit', name: next.agents[0].agent.name } : { kind: 'none' });
      setMessage('');
      onChanged();
    } else if ('changed' in result) setStale(true);
    else setMessage(result.error);
  };

  const create = (kind: 'skill' | 'hook'): void =>
    onCreate(kind, { mode, form, ...(openVersion.current !== undefined ? { version: openVersion.current } : {}) });

  if (!view) return <div className="page muted">Читаю .warband/agents/…</div>;

  const renaming = mode.kind === 'edit' && normalName(form.name) !== mode.name && form.name.trim() !== '';
  const live = roleProblems(form);
  const shown = [...problems.filter((p) => !(p.field === 'reviewer' && (p.code === 'same-cli-no-model' || p.code === 'same-cli-and-model'))), ...live];
  const at = (field: AgentProblem['field']): AgentProblem[] => shown.filter((p) => p.field === field);
  const total = skillsTotal(form.skills, view.skills);

  return (
    <div className="page split">
      {dialog}
      <section className="split-list" aria-label="Агенты">
        <h1>Агенты</h1>
        <p className="muted small">Кто пишет, кто проверяет, по каким правилам и какими проверками. Папка проекта .warband/agents/.</p>
        <button className="button primary" onClick={() => void open({ kind: 'new' })}>
          + Создать
        </button>
        {view.agents.map(({ agent }) => (
          <button
            key={agent.name}
            className={`list-item${mode.kind === 'edit' && mode.name === agent.name ? ' active' : ''}`}
            onClick={() => void (mode.kind === 'edit' && mode.name === agent.name ? undefined : open({ kind: 'edit', name: agent.name }))}
          >
            <span className="run-text">
              <span className="run-task">/{agent.name}</span>
              <span className="run-meta">
                {agent.roles.implementer.runner}/{agent.roles.implementer.model ?? 'по умолч.'} → {agent.roles.reviewer.runner}/{agent.roles.reviewer.model ?? 'по умолч.'}
              </span>
            </span>
          </button>
        ))}
        {mode.kind === 'new' && (
          <div className="list-item active" aria-current="true">
            <span className="run-text">
              <span className="run-task">/{normalName(form.name) || 'новый агент'}</span>
              <span className="run-meta">не сохранён</span>
            </span>
          </div>
        )}
      </section>

      <section className="split-form" aria-label="Агент">
        {view.error && (
          <div className="callout warn" role="alert">
            Не удалось прочитать агентов: {view.error}
          </div>
        )}
        {view.partsError && (
          <div className="callout warn" role="alert">
            Не удалось прочитать скиллы или хуки: {view.partsError}
          </div>
        )}
        {view.providersError && (
          <div className="callout warn" role="alert">
            Не удалось прочитать настройки провайдеров, списков моделей нет: {view.providersError}
          </div>
        )}
        {stale && (
          <div className="callout warn" role="alert">
            Файл агента изменился на диске, пока форма была открыта. Ваши правки не сохранены.{' '}
            <button className="link" onClick={() => void reload()}>
              Перечитать
            </button>{' '}
            (правки пропадут)
          </div>
        )}

        {mode.kind === 'none' ? (
          <div className="empty">
            <h2>{view.agents.length === 0 ? 'В проекте нет агентов' : 'Выберите агента слева'}</h2>
            <p className="muted">Агент — это инструкции, скиллы, хуки и пара «исполнитель — ревьюер». Задачи запускаются с агентом.</p>
            <button className="button primary" onClick={() => void open({ kind: 'new' })}>
              Создать
            </button>
          </div>
        ) : (
          <>
            <h2>{mode.kind === 'new' ? 'Новый агент' : `/${mode.name}`}</h2>

            <label className="field">
              <span>Имя</span>
              <input
                type="text"
                value={form.name}
                spellCheck={false}
                placeholder="например /test"
                aria-invalid={at('name').length > 0}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <Problems list={at('name')} />
            {renaming && (
              <p className="muted small">
                Агент станет /{normalName(form.name)}. Прошлые прогоны останутся под именем /{mode.kind === 'edit' ? mode.name : ''} и будут открываться как раньше.
              </p>
            )}

            <label className="field">
              <span>Что делает агент. Это его инструкции</span>
              <textarea
                className="plain-font"
                rows={5}
                value={form.description}
                placeholder="Например: пишешь e2e- и unit-тесты к готовому коду, код продукта не меняешь."
                aria-invalid={at('description').length > 0}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <Problems list={at('description')} />

            <fieldset className="field pick">
              <legend>Скиллы</legend>
              {view.skills.length === 0 && <span className="muted small">В проекте нет скиллов.</span>}
              {view.skills.map((s) => (
                <label key={s.name} className="check">
                  <input type="checkbox" checked={form.skills.includes(s.name)} onChange={(e) => setForm({ ...form, skills: toggle(form.skills, s.name, e.target.checked) })} />
                  <span>
                    <code>{s.name}</code> <span className="muted">{s.description}</span>
                  </span>
                  <span className="muted small size">{charsText(s.size)}</span>
                </label>
              ))}
              <div className="pick-foot">
                <button className="link" onClick={() => create('skill')}>
                  + новый скилл
                </button>
                <span className="small">
                  {form.skills.length === 0 ? 'Скиллы не выбраны.' : <>Итого {charsText(total)}: столько текста уйдёт в промпт каждого прогона.</>}
                </span>
              </div>
              <Problems list={at('skills')} />
            </fieldset>

            <fieldset className="field pick">
              <legend>Хуки</legend>
              {view.hooks.length === 0 && <span className="muted small">В проекте нет хуков.</span>}
              {hooksByStage(view.hooks).map((group) => (
                <div key={group.stage} className="stage-group">
                  <div className="muted small">{STAGE_TITLE[group.stage]}</div>
                  {group.hooks.map((h) => (
                    <label key={h.name} className="check">
                      <input type="checkbox" checked={form.hooks.includes(h.name)} onChange={(e) => setForm({ ...form, hooks: toggle(form.hooks, h.name, e.target.checked) })} />
                      <span>
                        <code>{h.name}</code> <span className="muted">{h.description || h.run}</span>
                      </span>
                    </label>
                  ))}
                </div>
              ))}
              <div className="pick-foot">
                <button className="link" onClick={() => create('hook')}>
                  + новый хук
                </button>
              </div>
              <Problems list={at('hooks')} />
            </fieldset>

            <div className="roles">
              <RolePicker
                title="Исполнитель (пишет код)"
                role="implementer"
                value={form.implementer}
                providers={view.providers}
                problems={at('implementer')}
                onChange={(implementer) => setForm({ ...form, implementer })}
              />
              <RolePicker
                title="Ревьюер (проверяет и принимает)"
                role="reviewer"
                value={form.reviewer}
                providers={view.providers}
                problems={at('reviewer')}
                onChange={(reviewer) => setForm({ ...form, reviewer })}
              />
              <label className="field">
                <span>Постановщик задач</span>
                <select
                  value={form.planner ? 'separate' : 'reviewer'}
                  onChange={(e) => {
                    if (e.target.value === 'separate') setForm({ ...form, planner: { ...form.reviewer } });
                    else {
                      const { planner, ...rest } = form;
                      setForm(rest);
                    }
                  }}
                >
                  <option value="reviewer">Назначить ревьюера</option>
                  <option value="separate">Выбрать отдельно</option>
                </select>
              </label>
              {form.planner && (
                <RolePicker
                  title="Постановщик задач (уточняет и планирует)"
                  role="planner"
                  value={form.planner}
                  providers={view.providers}
                  problems={at('planner')}
                  onChange={(planner) => setForm({ ...form, planner })}
                />
              )}
            </div>

            <p className="summary" role="status">
              {summary(form, view.providers, view.hooks)}
            </p>

            <div className="row">
              <button className="button primary" disabled={!dirty || busy || stale} onClick={() => void save()}>
                {busy ? 'Сохраняю…' : renaming ? 'Сохранить и переименовать' : 'Сохранить'}
              </button>
              <button
                className="button"
                disabled={!dirty || busy}
                onClick={() => {
                  setForm(saved ? formOf(saved.agent) : blank);
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
            </div>
            <div className="row">
              <button
                className="button"
                disabled={mode.kind !== 'edit' || dirty || busy}
                title={dirty ? 'Сначала сохраните агента' : undefined}
                onClick={() => mode.kind === 'edit' && onRun(mode.name)}
              >
                Запустить задачу с этим агентом
              </button>
              {dirty && mode.kind === 'edit' && <span className="muted small">Сначала сохраните правки.</span>}
              {message && <span className="muted small">{message}</span>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Problems({ list }: { list: AgentProblem[] }): ReactNode {
  if (list.length === 0) return null;
  return (
    <ul className="field-errors" role="alert">
      {list.map((p) => (
        <li key={`${p.code}-${p.item ?? ''}`}>{problemText(p)}</li>
      ))}
    </ul>
  );
}

const OTHER = '__other';

/** Provider, then a model from the Providers screen's list, the CLI's default, or one typed in. */
function RolePicker(props: {
  title: string;
  role: 'planner' | 'implementer' | 'reviewer';
  value: RoleForm;
  providers: ProviderChoice[];
  problems: AgentProblem[];
  onChange(value: RoleForm): void;
}): ReactNode {
  const { title, role, value, providers, problems, onChange } = props;
  const provider = providers.find((p) => p.id === value.runner);
  const models = provider?.models ?? [];
  const listed = value.model === '' || models.includes(value.model);
  const [typing, setTyping] = useState(!listed);
  const custom = typing || !listed;
  const marks = providerMarks(provider, role);
  return (
    <fieldset className="field role">
      <legend>{title}</legend>
      <label className="field">
        <span>Провайдер</span>
        <select value={value.runner} onChange={(e) => (setTyping(false), onChange({ runner: e.target.value, model: '' }))}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {!p.found ? ' — не установлен' : ''}
              {p.verified ? '' : ' — адаптер не подтверждён'}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Модель</span>
        <select
          value={custom ? OTHER : value.model}
          onChange={(e) => {
            if (e.target.value === OTHER) {
              setTyping(true);
              onChange({ ...value, model: '' });
            } else {
              setTyping(false);
              onChange({ ...value, model: e.target.value });
            }
          }}
        >
          <option value="">по умолчанию (как настроен CLI)</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value={OTHER}>другая…</option>
        </select>
      </label>
      {custom && (
        <input
          type="text"
          aria-label="Идентификатор модели"
          value={value.model}
          spellCheck={false}
          placeholder="идентификатор модели, как его принимает CLI"
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      )}
      {models.length === 0 && <p className="muted small">Для {provider?.name ?? value.runner} список моделей пуст: его ведут на экране «Провайдеры». Мастер предлагает тот же список.</p>}
      {marks.map((m) => (
        <p key={m.kind} className={`mark ${m.kind}`}>
          {m.kind === 'unverified' && role === 'implementer' ? (
            <>
              Движок откажет: <q>{m.text}</q>
            </>
          ) : (
            m.text
          )}
        </p>
      ))}
      <Problems list={problems} />
    </fieldset>
  );
}
