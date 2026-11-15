import * as monaco from 'monaco-editor';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { DiffFile, Finding } from '../shared/api.ts';
import { Markdown } from './Markdown.tsx';
import { findingTarget } from './model.ts';
import type { OpenGate } from './model.ts';

/*
 * The acceptance gate: the change as a side-by-side diff, the reviewer's
 * findings pinned to their lines, the person's own line comments (click a
 * line number), and reslop for a full review in the terminal. Line
 * comments go back as a review plan; plans written in reslop are picked up
 * from the worktree by the engine.
 */

type AcceptGate = Extract<OpenGate, { stage: 'accept' }>;
interface LineComment {
  path: string;
  line: number;
  text: string;
}

const dark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

export function DiffReview({ root, runId, gate }: { root: string; runId: string; gate: AcceptGate }): ReactNode {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [selected, setSelected] = useState(0);
  const [comments, setComments] = useState<LineComment[]>([]);
  const [draft, setDraft] = useState<{ line: number; text: string }>();
  const [general, setGeneral] = useState('');
  const [reslopNote, setReslopNote] = useState('');
  const [pendingPlans, setPendingPlans] = useState(0);
  const [busy, setBusy] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
  const reveal = useRef<number | undefined>(undefined);

  useEffect(() => {
    void window.warband.diff(root, runId).then(setFiles);
  }, [root, runId]);

  const file = files[selected];
  const findingsByFile = useMemo(() => {
    const map = new Map<string, { finding: Finding; line?: number }[]>();
    for (const f of gate.findings) {
      const t = findingTarget(f.where);
      if (!t) continue;
      map.set(t.path, [...(map.get(t.path) ?? []), { finding: f, ...(t.line ? { line: t.line } : {}) }]);
    }
    return map;
  }, [gate.findings]);

  // The editor is created once; models change with the file.
  useEffect(() => {
    if (!host.current) return;
    const diff = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      glyphMargin: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6 },
      fontSize: 13,
      theme: dark() ? 'vs-dark' : 'vs',
    });
    editor.current = diff;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = (): void => monaco.editor.setTheme(dark() ? 'vs-dark' : 'vs');
    media.addEventListener('change', onTheme);
    const click = diff.getModifiedEditor().onMouseDown((e) => {
      const kind = e.target.type;
      if (kind === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || kind === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const line = e.target.position?.lineNumber;
        if (line) setDraft({ line, text: '' });
      }
    });
    return () => {
      click.dispose();
      media.removeEventListener('change', onTheme);
      const model = diff.getModel();
      diff.dispose();
      model?.original.dispose();
      model?.modified.dispose();
    };
  }, []);

  useEffect(() => {
    const diff = editor.current;
    if (!diff || !file) return;
    const old = diff.getModel();
    const uri = (side: string): monaco.Uri => monaco.Uri.parse(`warband-${side}:///${runId}/${file.path}`);
    const original = monaco.editor.createModel(file.original, undefined, uri('a'));
    const modified = monaco.editor.createModel(file.modified, undefined, uri('b'));
    diff.setModel({ original, modified });
    old?.original.dispose();
    old?.modified.dispose();
    setDraft(undefined);
    if (reveal.current) {
      diff.getModifiedEditor().revealLineInCenter(reveal.current);
      reveal.current = undefined;
    }
  }, [file, runId]);

  // Markers for the reviewer's findings and the person's comments.
  useEffect(() => {
    const target = editor.current?.getModifiedEditor();
    if (!target || !file) return;
    const decorations = [
      ...(findingsByFile.get(file.path) ?? []).flatMap(({ finding, line }) =>
        line ? [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'wb-finding-line', glyphMarginClassName: 'wb-finding-glyph', glyphMarginHoverMessage: { value: finding.problem } } }] : [],
      ),
      ...comments
        .filter((c) => c.path === file.path)
        .map((c) => ({ range: new monaco.Range(c.line, 1, c.line, 1), options: { isWholeLine: true, className: 'wb-comment-line', glyphMarginClassName: 'wb-comment-glyph', glyphMarginHoverMessage: { value: c.text } } })),
    ];
    const collection = target.createDecorationsCollection(decorations);
    return () => collection.clear();
  }, [file, comments, findingsByFile]);

  const goTo = (path: string, line?: number): void => {
    const index = files.findIndex((f) => f.path === path || f.path.endsWith(`/${path}`));
    if (index < 0) return;
    if (index === selected && line) editor.current?.getModifiedEditor().revealLineInCenter(line);
    else {
      if (line) reveal.current = line;
      setSelected(index);
    }
  };

  const send = async (outcome: 'ok' | 'changes_requested' | 'rejected'): Promise<void> => {
    setBusy(true);
    await window.warband.decide(runId, {
      outcome,
      ...(general.trim() ? { comment: general } : {}),
      ...(outcome === 'changes_requested' && comments.length > 0 ? { findings: comments.map((c) => ({ where: `${c.path}:${c.line}`, problem: c.text })) } : {}),
    });
  };

  const openReslop = async (): Promise<void> => {
    const result = await window.warband.openReslop(root, runId);
    setReslopNote(result.ok ? 'reslop открыт в отдельном терминале. Оставьте замечания в плане ревью, сохраните, закройте reslop и нажмите «Забрать планы».' : (result.message ?? 'Не удалось открыть reslop'));
  };

  const collectPlans = async (): Promise<void> => {
    const plans = await window.warband.plans(root, runId);
    const pending = plans.filter((p) => p.status !== 'done' && p.open > 0);
    setPendingPlans(pending.length);
    setReslopNote(pending.length > 0 ? `Открытых планов: ${pending.length} (${pending.map((p) => `${p.name}: ${p.open}`).join(', ')}). Они уйдут исполнителю вместе с вашими комментариями.` : 'Открытых планов в .plan/ нет.');
  };

  const canReturn = comments.length > 0 || general.trim() !== '' || pendingPlans > 0;

  return (
    <section className="gate accept" aria-label="Приёмка">
      <div className="gate-head">
        <h2>Приёмка: дифф и решение</h2>
        <span className="muted small">Кликните по номеру строки справа, чтобы оставить комментарий.</span>
      </div>

      <div className="accept-top">
        {gate.summary && (
          <div className="accept-summary">
            <h3>Что сделал исполнитель</h3>
            <Markdown text={gate.summary} />
          </div>
        )}
        <div className="accept-findings">
          <h3>Замечания ревьюера</h3>
          {gate.findings.length === 0 && gate.reviewComments.length === 0 && <p className="muted small">Нет.</p>}
          <ul className="findings">
            {gate.findings.map((f, i) => {
              const t = findingTarget(f.where);
              return (
                <li key={i} className={`finding ${f.severity ?? ''}`}>
                  {f.severity && <span className="sev">{f.severity}</span>}
                  {t ? (
                    <button className="link" onClick={() => goTo(t.path, t.line)}>
                      {f.where}
                    </button>
                  ) : null}
                  <span>{f.problem}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div className="diff-layout">
        <ul className="files" aria-label="Изменённые файлы">
          {files.map((f, i) => (
            <li key={f.path}>
              <button className={`file${i === selected ? ' active' : ''}`} onClick={() => setSelected(i)} title={f.path}>
                <span className={`fstatus s${f.status}`}>{f.status}</span>
                <span className="fname">{f.path}</span>
                {(comments.some((c) => c.path === f.path) || findingsByFile.has(f.path)) && <span className="fmark" aria-label="есть замечания">●</span>}
              </button>
            </li>
          ))}
          {files.length === 0 && <li className="muted small pad">Загрузка диффа…</li>}
        </ul>
        <div className="diff-pane">
          <div className="diff-title small">{file ? file.path : ''}</div>
          <div className="diff-editor" ref={host} />
          {draft && file && (
            <div className="comment-draft">
              <label className="small">
                Комментарий к <code>{file.path}:{draft.line}</code>
                <textarea autoFocus rows={3} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
              </label>
              <div className="row">
                <button
                  className="button primary"
                  disabled={draft.text.trim() === ''}
                  onClick={() => {
                    setComments((list) => [...list, { path: file.path, line: draft.line, text: draft.text.trim() }]);
                    setDraft(undefined);
                  }}
                >
                  Добавить
                </button>
                <button className="button" onClick={() => setDraft(undefined)}>
                  Отмена
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {comments.length > 0 && (
        <ul className="my-comments">
          {comments.map((c, i) => (
            <li key={i}>
              <button className="link" onClick={() => goTo(c.path, c.line)}>
                {c.path}:{c.line}
              </button>{' '}
              {c.text}{' '}
              <button className="icon-button" aria-label="Удалить комментарий" onClick={() => setComments((list) => list.filter((_, n) => n !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea rows={2} value={general} onChange={(e) => setGeneral(e.target.value)} placeholder="Общий комментарий (необязательно)" />
      {reslopNote && <p className="note small">{reslopNote}</p>}

      <div className="row">
        <button className="button primary" disabled={busy} onClick={() => void send('ok')}>
          Принять и закоммитить
        </button>
        <button className="button" disabled={busy || !canReturn} onClick={() => void send('changes_requested')} title={canReturn ? '' : 'Оставьте комментарий или план в reslop'}>
          Вернуть на доработку
        </button>
        <button className="button" onClick={() => void openReslop()}>
          Открыть в reslop
        </button>
        <button className="button" onClick={() => void collectPlans()}>
          Забрать планы
        </button>
        <button className="button danger" disabled={busy} onClick={() => void send('rejected')}>
          Отклонить
        </button>
      </div>
    </section>
  );
}
