/*
 * The part of TOML that bench task files use: [tables] and [dotted.tables],
 * key = value with basic or literal strings, integers, floats, booleans and
 * arrays of those (on one line or several). Anything else is an error with
 * its line number, never a guess. Warband has no runtime dependencies, so
 * this replaces a TOML library.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

const KEY = /^[A-Za-z0-9_-]+$/;

class Reader {
  pos = 0;
  readonly text: string;
  readonly line: () => number;
  constructor(text: string, line: () => number) {
    this.text = text;
    this.line = line;
  }
  peek(): string {
    return this.text[this.pos] ?? '';
  }
  skipSpace(newlines: boolean): void {
    while (this.pos < this.text.length) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || (newlines && (c === '\n' || c === '\r'))) this.pos++;
      else if (newlines && c === '#') while (this.pos < this.text.length && this.peek() !== '\n') this.pos++;
      else break;
    }
  }
  fail(message: string): never {
    throw new Error(`line ${this.line()}: ${message}`);
  }
}

function parseString(r: Reader): string {
  const quote = r.peek();
  r.pos++;
  let out = '';
  while (true) {
    const c = r.peek();
    if (c === '' || c === '\n') r.fail('unterminated string');
    r.pos++;
    if (c === quote) return out;
    if (c === '\\' && quote === '"') {
      const e = r.peek();
      r.pos++;
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
      if (map[e] === undefined) r.fail(`unsupported escape \\${e}`);
      out += map[e];
    } else {
      out += c;
    }
  }
}

function parseValue(r: Reader): TomlValue {
  const c = r.peek();
  if (c === '"' || c === "'") {
    if (r.text.startsWith(c.repeat(3), r.pos)) r.fail('multi-line strings are not supported');
    return parseString(r);
  }
  if (c === '[') {
    r.pos++;
    const items: TomlValue[] = [];
    while (true) {
      r.skipSpace(true);
      if (r.peek() === ']') {
        r.pos++;
        return items;
      }
      items.push(parseValue(r));
      r.skipSpace(true);
      if (r.peek() === ',') r.pos++;
      else if (r.peek() !== ']') r.fail('expected , or ] in array');
    }
  }
  const word = /^[^\s,\]#]+/.exec(r.text.slice(r.pos))?.[0] ?? '';
  r.pos += word.length;
  if (word === 'true') return true;
  if (word === 'false') return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(word.replace(/_/g, ''))) return Number(word.replace(/_/g, ''));
  return r.fail(`unsupported value "${word}"`);
}

function tableAt(root: TomlTable, path: readonly string[], r: Reader): TomlTable {
  let table = root;
  for (const key of path) {
    const next = table[key];
    if (next === undefined) table = table[key] = {};
    else if (typeof next === 'object' && !Array.isArray(next)) table = next;
    else r.fail(`${path.join('.')} is not a table`);
  }
  return table;
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const r: Reader = new Reader(body, (): number => body.slice(0, r.pos).split('\n').length);
  const defined = new Set<string>();
  while (true) {
    r.skipSpace(true);
    if (r.pos >= r.text.length) return root;
    if (r.peek() === '[') {
      const end = r.text.indexOf(']', r.pos);
      if (end < 0) r.fail('unterminated table header');
      const name = r.text.slice(r.pos + 1, end).trim();
      if (name.startsWith('[')) r.fail('arrays of tables are not supported');
      const path = name.split('.').map((k) => k.trim());
      if (!path.every((k) => KEY.test(k))) r.fail(`bad table name [${name}]`);
      if (defined.has(name)) r.fail(`table [${name}] defined twice`);
      defined.add(name);
      current = tableAt(root, path, r);
      r.pos = end + 1;
    } else {
      const eq = r.text.indexOf('=', r.pos);
      const nl = r.text.indexOf('\n', r.pos);
      if (eq < 0 || (nl >= 0 && nl < eq)) r.fail('expected key = value');
      const key = r.text.slice(r.pos, eq).trim();
      if (!KEY.test(key)) r.fail(`bad key "${key}"`);
      if (key in current) r.fail(`key ${key} defined twice`);
      r.pos = eq + 1;
      r.skipSpace(false);
      current[key] = parseValue(r);
    }
    r.skipSpace(false);
    if (r.peek() === '#') while (r.pos < r.text.length && r.peek() !== '\n') r.pos++;
    const end = r.peek();
    if (end !== '' && end !== '\n' && end !== '\r') r.fail('unexpected text after value');
  }
}
