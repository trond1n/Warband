import * as monaco from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { SkillInfo, SkillProblem, SkillsView as View } from '../shared/api.ts';
import { useConfirm } from './Dialog.tsx';
import { copyName, normalName, usedByText } from './hooks-model.ts';
import { Markdown } from './Markdown.tsx';
import type { LeaveGuard } from './Providers.tsx';
import { blankForm, charsText, formOf, inputOf, isDirty, problemText, promptNote, sizeOf } from './skills-model.ts';
import type { SkillForm } from './skills-model.ts';

/*
 * The project's skills: the list on the left; on the right the front matter
 * fields, a Markdown editor (Monaco) and a preview through the same
 * Markdown component the run pages use, which never renders HTML. Every
 * write goes through the core (saveSkill, deleteSkill) in the main process.
 */

type Mode = { kind: 'none' } | { kind: 'edit'; name: string } | { kind: 'new' };

const dark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function SkillsView({ root, setGuard }: { root: string; setGuard(guard: LeaveGuard | null): void }): ReactNode {
  const [view, setView] = useState<View>();
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  const [form, setForm] = useState<SkillForm>(blankForm);
  const [problems, setProblems] = useState<SkillProblem[]>([]);
  const [message, setMessage] = useState('');
  /** The open skill changed on disk while the form had edits. */
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, ask] = useConfirm();

  const saved: SkillInfo | undefined = mode.kind === 'edit' ? view?.skills.find((s) => s.name === mode.name) : undefined;
  const dirty = mode.kind !== 'none' && isDirty(form, saved);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    setGuard({ dirty: () => dirtyRef.current });
    return () => setGuard(null);
  }, [setGuard]);

  /** Version of the file the form is based on; a watcher report with another one is a change from outside. */
  const openVersion = useRef<string | undefined>(undefined);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  /** Shows `next` and puts the form on `target`, dropping edits. */
  const apply = useCallback((next: View, target: Mode) => {
    setView(next);
    const info = target.kind === 'edit' ? next.skills.find((s) => s.name === target.name) : undefined;
    setMode(target.kind === 'edit' && !info ? { kind: 'none' } : target);
    setForm(info ? formOf(info) : blankForm());
    openVersion.current = info?.version;
    setProblems([]);
    setStale(false);
  }, []);

  useEffect(() => {
    void window.warband.skills(root).then((next) => apply(next, next.skills[0] ? { kind: 'edit', name: next.skills[0].name } : { kind: 'none' }));
  }, [root, apply]);

  const reload = useCallback(async () => {
    apply(await window.warband.skills(root), modeRef.current);
    setMessage('');
  }, [apply, root]);

  // A skill or an agent changed on disk: take it if the open skill has no edits, otherwise say so.
  useEffect(
    () =>
      window.warband.onWorkspaceChanged(async (changed) => {
        if (changed !== root) return;
        const next = await window.warband.skills(root);
        const current = modeRef.current;
        if (current.kind !== 'edit') return setView(next);
        const info = next.skills.find((s) => s.name === current.name);
        // Other skills or the agents changed; the open one did not.
        if (info?.version === openVersion.current) return setView(next);
        if (dirtyRef.current) setStale(true);
        else apply(next, current);
      }),
    [apply, root],
  );

  const askLeave = (): Promise<boolean> =>
    ask({ title: 'Несохранённые правки', body: 'Скилл изменён и не сохранён. Уйти без сохранения?', confirm: 'Уйти', danger: true });

  const open = async (target: Mode, fill?: SkillForm): Promise<void> => {
    if (dirty && !(await askLeave())) return;
    setMode(target);
    const info = target.kind === 'edit' ? view?.skills.find((s) => s.name === target.name) : undefined;
    setForm(fill ?? (info ? formOf(info) : blankForm()));
    openVersion.current = info?.version;
    setProblems([]);
    setMessage('');
    setStale(false);
  };

  const confirmRename = (from: string, to: string, agents: string[]): Promise<boolean> =>
    ask({
      title: `Переименовать скилл «${from}» в «${to}»?`,
      body: (
        <>
          <p>
            Файл станет <code>.warband/skills/{to}.md</code>. Скилл используют агенты, в их файлах ссылка поменяется на новое имя:
          </p>
          <ul className="plain">
            {agents.map((a) => (
              <li key={a}>
                <code>/{a}</code> <span className="muted small">.warband/agents/{a}.json</span>
              </li>
            ))}
          </ul>
          <p className="muted">Скилл и агенты меняются одной операцией: если что-то не запишется, всё останется как было.</p>
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
    const version = openVersion.current ?? '';
    setBusy(true);
    setMessage('');
    let result = await window.warband.saveSkill(root, inputOf(form), original, version, renameAgents);
    // The agents changed since the list was shown (or were unknown): ask again with the list of now.
    const again = !result.ok && 'problems' in result && result.problems.length === 1 ? result.problems.find((p) => p.code === 'rename-in-use') : undefined;
    if (again && original !== null) {
      setBusy(false);
      if (!(await confirmRename(original, newName, again.agents ?? []))) return;
      setBusy(true);
      result = await window.warband.saveSkill(root, inputOf(form), original, version, again.agents ?? []);
    }
    setBusy(false);
    if (result.ok) {
      // Our own write must not look like someone else's change when the watcher reports it.
      openVersion.current = result.version;
      modeRef.current = { kind: 'edit', name: result.name };
      apply(await window.warband.skills(root), { kind: 'edit', name: result.name });
      setMessage(original !== null && original !== result.name ? `Переименован, файл .warband/skills/${result.name}.md.` : `Сохранено в .warband/skills/${result.name}.md.`);
    } else if ('problems' in result) setProblems(result.problems);
    else if ('changed' in result) setStale(true);
    else setMessage(result.error);
  };

  const duplicate = async (): Promise<void> => {
    if (!view || mode.kind !== 'edit') return;
    await open({ kind: 'new' }, { ...form, name: copyName(mode.name, view.skills.map((s) => s.name)) });
    setMessage('Копия ещё не сохранена: проверьте имя и сохраните.');
  };

  const usedDialog = (name: string, agents: string[]): Promise<boolean> =>
    ask({
      title: `Скилл «${name}» используется`,
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
          <p className="muted">Уберите скилл из этих агентов, тогда его можно будет удалить. Пока ссылки есть, скилл не удаляется.</p>
        </>
      ),
      confirm: 'Понятно',
      single: true,
    });

  const remove = async (): Promise<void> => {
    if (!view || !saved) return;
    if (saved.usedBy && saved.usedBy.length > 0) {
      await usedDialog(saved.name, saved.usedBy);
      return;
    }
    const ok = await ask({
      title: `Удалить скилл «${saved.name}»?`,
      body: (
        <p>
          Файл <code>{saved.file}</code> будет удалён. Агенты его не используют.
        </p>
      ),
      confirm: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    const result = await window.warband.deleteSkill(root, saved.name, saved.version);
    if (result.ok) {
      const next = await window.warband.skills(root);
      apply(next, next.skills[0] ? { kind: 'edit', name: next.skills[0].name } : { kind: 'none' });
      setMessage('');
    } else if ('usedBy' in result) await usedDialog(saved.name, result.usedBy);
    else if ('changed' in result) setStale(true);
    else setMessage(result.error);
  };

  if (!view) return <div className="page muted">Читаю .warband/skills/…</div>;

  const renaming = mode.kind === 'edit' && normalName(form.name) !== mode.name && form.name.trim() !== '';
  const size = sizeOf(form, saved?.extra ?? []);

  return (
    <div className="page split">
      {dialog}
      <section className="split-list" aria-label="Скиллы">
        <h1>Скиллы</h1>
        <p className="muted small">Правила для агентов в Markdown: канон кода, договорённости команды. Папка проекта .warband/skills/.</p>
        <button className="button primary" onClick={() => void open({ kind: 'new' })}>
          + Создать
        </button>
        {view.skills.map((s) => (
          <button
            key={s.name}
            className={`list-item${mode.kind === 'edit' && mode.name === s.name ? ' active' : ''}`}
            onClick={() => void (mode.kind === 'edit' && mode.name === s.name ? undefined : open({ kind: 'edit', name: s.name }))}
          >
            <span className="run-text">
              <span className="run-task">{s.name}</span>
              <span className="run-meta">
                {charsText(s.size)} · {usedByText(s.usedBy)}
              </span>
            </span>
          </button>
        ))}
        {mode.kind === 'new' && (
          <div className="list-item active" aria-current="true">
            <span className="run-text">
              <span className="run-task">{form.name.trim() || 'новый скилл'}</span>
              <span className="run-meta">не сохранён</span>
            </span>
          </div>
        )}
      </section>

      <section className="split-form wide" aria-label="Скилл">
        {view.error && (
          <div className="callout warn" role="alert">
            Не удалось прочитать .warband/skills/: {view.error}
          </div>
        )}
        {view.agentsError && (
          <div className="callout warn" role="alert">
            Не удалось прочитать агентов, поэтому не видно, кто использует скиллы: {view.agentsError}
          </div>
        )}
        {stale && (
          <div className="callout warn" role="alert">
            Файл скилла изменился на диске, пока форма была открыта. Ваши правки не сохранены.{' '}
            <button className="link" onClick={() => void reload()}>
              Перечитать
            </button>{' '}
            (правки пропадут)
          </div>
        )}

        {mode.kind === 'none' ? (
          <div className="empty">
            <h2>{view.skills.length === 0 ? 'В проекте нет скиллов' : 'Выберите скилл слева'}</h2>
            <p className="muted">Скилл — документ с правилами. Warband кладёт его целиком в промпт агентов, которые его используют, одинаково для любого CLI.</p>
            <button className="button primary" onClick={() => void open({ kind: 'new' })}>
              Создать
            </button>
          </div>
        ) : (
          <>
            <h2>{mode.kind === 'new' ? 'Новый скилл' : mode.name}</h2>
            <p className="muted small">
              {charsText(size)}. {promptNote(saved ? saved.usedBy : [])}
            </p>

            <div className="skill-fields">
              <label className="field">
                <span>Имя</span>
                <input
                  type="text"
                  value={form.name}
                  spellCheck={false}
                  placeholder="например code-canon"
                  aria-invalid={problems.some((p) => p.field === 'name')}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Описание, одной строкой</span>
                <input
                  type="text"
                  className="plain-font"
                  value={form.description}
                  placeholder="о чём скилл"
                  aria-invalid={problems.some((p) => p.field === 'description')}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </label>
            </div>
            <FieldProblems problems={problems} original={mode.kind === 'edit' ? mode.name : undefined} />
            {mode.kind === 'edit' && (
              <p className="muted small">
                Чтобы переименовать, измените имя и сохраните: файл переедет в <code>.warband/skills/&lt;имя&gt;.md</code>, ссылки в агентах обновятся. Имя и описание
                пишутся в заголовок файла (front matter).
              </p>
            )}

            <div className="skill-editor">
              <div className="skill-pane">
                <div className="muted small">Markdown</div>
                <MarkdownEditor value={form.body} onChange={(body) => setForm((f) => ({ ...f, body }))} />
              </div>
              <div className="skill-pane">
                <div className="muted small">Предпросмотр</div>
                <div className="skill-preview">{form.body.trim() === '' ? <p className="muted">Пусто. Напишите правила слева.</p> : <Markdown text={form.body} />}</div>
              </div>
            </div>

            <div className="row">
              <button className="button primary" disabled={!dirty || busy || stale} onClick={() => void save()}>
                {busy ? 'Сохраняю…' : renaming ? 'Сохранить и переименовать' : 'Сохранить'}
              </button>
              <button
                className="button"
                disabled={!dirty || busy}
                onClick={() => {
                  setForm(saved ? formOf(saved) : blankForm());
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
            {saved && (
              <p className="muted small">
                Файл <code>{saved.file}</code>, sha256 <code title={saved.version}>{saved.version.slice(0, 12)}</code>. Этот же хеш пишется в событие run_started
                каждого прогона, так что в журнале видно, по какой версии скилла он шёл.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function FieldProblems({ problems, original }: { problems: SkillProblem[]; original?: string | undefined }): ReactNode {
  if (problems.length === 0) return null;
  return (
    <ul className="field-errors" role="alert">
      {problems.map((p) => (
        <li key={`${p.field}-${p.code}`}>
          {p.field === 'name' ? 'Имя: ' : 'Описание: '}
          {problemText(p, original)}
        </li>
      ))}
    </ul>
  );
}

/** Monaco for the body. The text in the editor follows `value` when it changes from outside (another skill, a reload). */
function MarkdownEditor({ value, onChange }: { value: string; onChange(value: string): void }): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const ed = monaco.editor.create(host.current, {
      value,
      language: 'markdown',
      automaticLayout: true,
      wordWrap: 'on',
      minimap: { enabled: false },
      lineNumbers: 'off',
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      fontSize: 13,
      unicodeHighlight: { ambiguousCharacters: false },
      theme: dark() ? 'vs-dark' : 'vs',
      ariaLabel: 'Текст скилла в Markdown',
    });
    editor.current = ed;
    keepLineEnds(ed, value);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = (): void => monaco.editor.setTheme(dark() ? 'vs-dark' : 'vs');
    media.addEventListener('change', onTheme);
    const sub = ed.onDidChangeModelContent(() => changed.current(ed.getValue()));
    return () => {
      sub.dispose();
      media.removeEventListener('change', onTheme);
      ed.getModel()?.dispose();
      ed.dispose();
      editor.current = undefined;
    };
    // Created once; `value` is followed by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ed = editor.current;
    if (ed && ed.getValue() !== value) {
      ed.setValue(value);
      keepLineEnds(ed, value);
    }
  }, [value]);

  return <div ref={host} className="monaco-host" />;
}

/**
 * Line ends as the file has them, LF for a new one. Left alone, Monaco on
 * Windows types CRLF, and the body would not match the front matter.
 */
function keepLineEnds(ed: monaco.editor.IStandaloneCodeEditor, value: string): void {
  ed.getModel()?.setEOL(value.includes('\r\n') ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
}
