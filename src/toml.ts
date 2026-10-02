// A small TOML reader for agent configuration files (Codex `config.toml`). It understands what such files use:
// tables, arrays of tables, dotted keys, basic/literal/multi-line strings, numbers, booleans, dates (kept as strings),
// arrays and inline tables. Anything else throws, and callers report the file as unparsable instead of guessing.

export class TomlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

type Table = Record<string, unknown>;

class Reader {
  pos = 0;
  constructor(readonly s: string) {}
  get line(): number {
    let n = 1;
    for (let i = 0; i < this.pos && i < this.s.length; i++) if (this.s[i] === '\n') n++;
    return n;
  }
  fail(msg: string): never {
    throw new TomlError(msg, this.line);
  }
  peek(o = 0): string {
    return this.s[this.pos + o] ?? '';
  }
  eof(): boolean {
    return this.pos >= this.s.length;
  }
  startsWith(t: string): boolean {
    return this.s.startsWith(t, this.pos);
  }
  skipInline(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }
  skipComment(): void {
    if (this.peek() === '#') while (!this.eof() && this.peek() !== '\n') this.pos++;
  }
  /** Skip whitespace, comments and newlines (inside arrays and between statements). */
  skipAll(): void {
    for (;;) {
      this.skipInline();
      if (this.peek() === '#') this.skipComment();
      else if (this.peek() === '\n' || this.peek() === '\r') this.pos++;
      else return;
    }
  }
  endOfLine(): void {
    this.skipInline();
    this.skipComment();
    if (this.eof()) return;
    if (this.peek() === '\r') this.pos++;
    if (this.peek() !== '\n') this.fail('unexpected characters after value');
    this.pos++;
  }
}

const BARE = /[A-Za-z0-9_-]/;

function parseKeyPart(r: Reader): string {
  r.skipInline();
  const c = r.peek();
  if (c === '"') return parseBasicString(r);
  if (c === "'") return parseLiteralString(r);
  let out = '';
  while (BARE.test(r.peek()) && r.peek() !== '') out += r.s[r.pos++];
  if (!out) r.fail(`expected a key, found '${c || 'end of file'}'`);
  return out;
}

function parseKeyPath(r: Reader): string[] {
  const parts = [parseKeyPart(r)];
  for (;;) {
    r.skipInline();
    if (r.peek() !== '.') return parts;
    r.pos++;
    parts.push(parseKeyPart(r));
  }
}

const ESC: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

function readEscape(r: Reader): string {
  const e = r.s[r.pos++] ?? '';
  if (e in ESC) return ESC[e] as string;
  if (e === 'u' || e === 'U') {
    const len = e === 'u' ? 4 : 8;
    const hex = r.s.slice(r.pos, r.pos + len);
    if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) r.fail('invalid unicode escape');
    r.pos += len;
    return String.fromCodePoint(parseInt(hex, 16));
  }
  return r.fail(`invalid escape '\\${e}'`);
}

function parseBasicString(r: Reader): string {
  r.pos++;
  let out = '';
  for (;;) {
    const c = r.peek();
    if (c === '' || c === '\n') r.fail('unterminated string');
    r.pos++;
    if (c === '"') return out;
    out += c === '\\' ? readEscape(r) : c;
  }
}

function parseLiteralString(r: Reader): string {
  r.pos++;
  const end = r.s.indexOf("'", r.pos);
  const nl = r.s.indexOf('\n', r.pos);
  if (end === -1 || (nl !== -1 && nl < end)) r.fail('unterminated string');
  const v = r.s.slice(r.pos, end);
  r.pos = end + 1;
  return v;
}

function parseMultiline(r: Reader, quote: '"' | "'"): string {
  const delim = quote.repeat(3);
  r.pos += 3;
  if (r.peek() === '\r') r.pos++;
  if (r.peek() === '\n') r.pos++;
  let out = '';
  for (;;) {
    if (r.eof()) r.fail('unterminated multi-line string');
    if (r.startsWith(delim)) {
      r.pos += 3;
      // up to two extra quotes belong to the string
      while (r.peek() === quote && out.length >= 0 && r.s.slice(r.pos - 3, r.pos + 1) === quote.repeat(4)) {
        out += quote;
        r.pos++;
      }
      return out;
    }
    const c = r.s[r.pos++] as string;
    if (quote === '"' && c === '\\') {
      // line-ending backslash trims the following whitespace
      if (/^[ \t]*\r?\n/.test(r.s.slice(r.pos))) {
        while (/\s/.test(r.peek())) r.pos++;
      } else out += readEscape(r);
    } else out += c;
  }
}

function parseValue(r: Reader): unknown {
  r.skipInline();
  const c = r.peek();
  if (r.startsWith('"""')) return parseMultiline(r, '"');
  if (r.startsWith("'''")) return parseMultiline(r, "'");
  if (c === '"') return parseBasicString(r);
  if (c === "'") return parseLiteralString(r);
  if (c === '[') {
    r.pos++;
    const arr: unknown[] = [];
    for (;;) {
      r.skipAll();
      if (r.peek() === ']') {
        r.pos++;
        return arr;
      }
      arr.push(parseValue(r));
      r.skipAll();
      if (r.peek() === ',') r.pos++;
      else if (r.peek() !== ']') r.fail("expected ',' or ']' in array");
    }
  }
  if (c === '{') {
    r.pos++;
    const t: Table = {};
    r.skipInline();
    if (r.peek() === '}') {
      r.pos++;
      return t;
    }
    for (;;) {
      const path = parseKeyPath(r);
      r.skipInline();
      if (r.peek() !== '=') r.fail("expected '=' in inline table");
      r.pos++;
      setPath(r, t, path, parseValue(r));
      r.skipInline();
      if (r.peek() === ',') {
        r.pos++;
        continue;
      }
      if (r.peek() === '}') {
        r.pos++;
        return t;
      }
      r.fail("expected ',' or '}' in inline table");
    }
  }
  let tok = '';
  while (r.peek() !== '' && !/[\s,\]}#]/.test(r.peek())) tok += r.s[r.pos++];
  if (tok === 'true') return true;
  if (tok === 'false') return false;
  if (/^[+-]?(inf|nan)$/.test(tok)) return Number(tok.replace('inf', 'Infinity').replace('nan', 'NaN'));
  if (/^[+-]?(0|[1-9][0-9_]*)(\.[0-9_]+)?([eE][+-]?[0-9_]+)?$/.test(tok)) return Number(tok.replace(/_/g, ''));
  if (/^0x[0-9a-fA-F_]+$|^0o[0-7_]+$|^0b[01_]+$/.test(tok)) return Number(tok.replace(/_/g, ''));
  if (/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?$/.test(tok) || /^\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(tok)) return tok;
  return r.fail(`unsupported value '${tok || c}'`);
}

const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v);

function setPath(r: Reader, root: Table, path: string[], value: unknown): void {
  let cur = root;
  for (const part of path.slice(0, -1)) {
    let next = cur[part];
    if (next === undefined) next = cur[part] = {};
    if (Array.isArray(next)) next = next[next.length - 1];
    if (!isTable(next)) r.fail(`'${part}' is not a table`);
    cur = next;
  }
  const last = path[path.length - 1] as string;
  if (Object.prototype.hasOwnProperty.call(cur, last)) r.fail(`duplicate key '${path.join('.')}'`);
  cur[last] = value;
}

function openTable(r: Reader, root: Table, path: string[], array: boolean): Table {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    const part = path[i] as string;
    const lastPart = i === path.length - 1;
    let next = cur[part];
    if (lastPart && array) {
      if (next === undefined) next = cur[part] = [];
      if (!Array.isArray(next)) r.fail(`'${part}' is not an array of tables`);
      const t: Table = {};
      next.push(t);
      return t;
    }
    if (next === undefined) next = cur[part] = {};
    if (Array.isArray(next)) next = next[next.length - 1];
    if (!isTable(next)) r.fail(`'${part}' is not a table`);
    cur = next;
  }
  return cur;
}

export function parseToml(text: string): Record<string, unknown> {
  const r = new Reader(text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
  const root: Table = {};
  let current = root;
  for (;;) {
    r.skipAll();
    if (r.eof()) return root;
    if (r.peek() === '[') {
      const array = r.peek(1) === '[';
      r.pos += array ? 2 : 1;
      const path = parseKeyPath(r);
      r.skipInline();
      if (array ? !r.startsWith(']]') : r.peek() !== ']') r.fail('unterminated table header');
      r.pos += array ? 2 : 1;
      current = openTable(r, root, path, array);
      r.endOfLine();
      continue;
    }
    const path = parseKeyPath(r);
    r.skipInline();
    if (r.peek() !== '=') r.fail(`expected '=' after key '${path.join('.')}'`);
    r.pos++;
    setPath(r, current, path, parseValue(r));
    r.endOfLine();
  }
}
