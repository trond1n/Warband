/*
 * Glob patterns for repository paths, with no dependencies. Paths use "/".
 *
 *   *      any characters except "/"
 *   **     any characters, "/" included; "**\/" also matches nothing
 *   ?      one character except "/"
 *   {a,b}  either alternative
 *
 * As in .gitignore, a pattern without "/" matches at any depth
 * ("package.json" is "**\/package.json"), and a leading "/" anchors it to
 * the repository root.
 */

const escape = (c: string): string => (/[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c);

function body(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) {
        out += '\\{';
        continue;
      }
      out += `(?:${pattern
        .slice(i + 1, end)
        .split(',')
        .map(body)
        .join('|')})`;
      i = end;
    } else out += escape(c);
  }
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, '/');
  if (p.startsWith('/')) p = p.slice(1);
  else if (!p.includes('/')) p = `**/${p}`;
  if (p.endsWith('/')) p += '**';
  return new RegExp(`^${body(p)}$`);
}

/** The first pattern that matches the path, if any. */
export function matchGlob(path: string, patterns: readonly string[]): string | undefined {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return patterns.find((p) => globToRegExp(p).test(clean));
}
