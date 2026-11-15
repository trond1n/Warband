import type { ReactNode } from 'react';

/*
 * A small Markdown renderer for plans and summaries written by models:
 * headings, paragraphs, lists with checkboxes, fenced code, tables, and
 * inline code, bold and italics. It builds React elements and never sets
 * HTML, so model text cannot inject markup.
 */

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0];
    if (token.startsWith('`')) out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }): ReactNode {
  const lines = text.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = /^(\s*)(`{3,})(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(fence[2] ?? '```')) body.push(lines[i++] ?? '');
      i++;
      blocks.push(<pre key={key++}>{body.join('\n')}</pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min((heading[1] ?? '#').length + 1, 6);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={key++}>{inline(heading[2] ?? '')}</Tag>);
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && (lines[i + 1] ?? '').includes('---')) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) rows.push(cells(lines[i++] ?? ''));
      blocks.push(
        <table key={key++}>
          <thead>
            <tr>{head.map((c, n) => <th key={n}>{inline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, n) => (
              <tr key={n}>{r.map((c, m) => <td key={m}>{inline(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: { depth: number; text: string; check?: boolean; ordered: boolean }[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? '')) {
        const m = /^(\s*)([-*]|\d+\.)\s+(\[( |x|X)\]\s+)?(.*)$/.exec(lines[i] ?? '');
        if (m) {
          items.push({
            depth: Math.floor((m[1] ?? '').length / 2),
            text: m[5] ?? '',
            ordered: /\d/.test(m[2] ?? ''),
            ...(m[3] ? { check: (m[4] ?? ' ').toLowerCase() === 'x' } : {}),
          });
        }
        i++;
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items.map((item, n) => (
            <li key={n} style={{ marginLeft: `${item.depth * 1.25}em` }} className={item.check === undefined ? '' : 'md-task'}>
              {item.check !== undefined && <span className={`md-box${item.check ? ' on' : ''}`}>{item.check ? '✓' : ''}</span>}
              {item.ordered && item.check === undefined && <span className="md-num">•</span>}
              <span>{inline(item.text)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(#{1,6}\s|\s*([-*]|\d+\.)\s|\s*```|\|)/.test(lines[i] ?? '')) {
      para.push(lines[i++] ?? '');
    }
    if (para.length === 0) {
      para.push(line);
      i++;
    }
    blocks.push(<p key={key++}>{inline(para.join(' '))}</p>);
  }
  return <div className="md">{blocks}</div>;
}
