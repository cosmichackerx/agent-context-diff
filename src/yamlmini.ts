// A small YAML reader for agent configuration files (Continue, Goose ...). Supported: block mappings and sequences,
// plain / quoted scalars, single-line flow collections, `|` and `>` block scalars, comments. Unsupported constructs
// (anchors, aliases, tags, merge keys, multi-document files, multi-line plain/flow scalars, tabs) throw, so callers
// report the file as unparsable instead of silently misreading it.

export class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
  }
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

function stripComment(s: string): string {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(s[i - 1] as string)) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1] as string))) return s.slice(0, i);
  }
  return s;
}

function scalar(raw: string, no: number): unknown {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t[0] === '"') {
    if (t.length < 2 || !t.endsWith('"')) throw new YamlError('unterminated double-quoted string', no);
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1).replace(/\\(["\\/])/g, '$1');
    }
  }
  if (t[0] === "'") {
    if (t.length < 2 || !t.endsWith("'")) throw new YamlError('unterminated single-quoted string', no);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!]/.test(t)) throw new YamlError(`unsupported YAML feature near '${t.slice(0, 12)}' (anchors, aliases and tags)`, no);
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(0|[1-9][0-9_]*)$/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Parse a flow collection or scalar that sits on one line. */
function flow(src: string, no: number): unknown {
  let i = 0;
  const ws = (): void => {
    while (i < src.length && /\s/.test(src[i] as string)) i++;
  };
  const value = (): unknown => {
    ws();
    const c = src[i];
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== ']') throw new YamlError("expected ',' or ']'", no);
      }
    }
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (src[i] === '}') {
          i++;
          return obj;
        }
        const k = String(item(':'));
        ws();
        if (src[i] !== ':') throw new YamlError("expected ':' in flow mapping", no);
        i++;
        obj[k] = value();
        ws();
        if (src[i] === ',') i++;
        else if (src[i] !== '}') throw new YamlError("expected ',' or '}'", no);
      }
    }
    return item(',]}');
  };
  const item = (stop: string): unknown => {
    ws();
    const q = src[i];
    let start = i;
    if (q === '"' || q === "'") {
      i++;
      while (i < src.length && src[i] !== q) {
        if (q === '"' && src[i] === '\\') i++;
        i++;
      }
      i++;
      return scalar(src.slice(start, i), no);
    }
    while (i < src.length && !stop.includes(src[i] as string)) i++;
    return scalar(src.slice(start, i), no);
  };
  const v = value();
  ws();
  if (i < src.length) throw new YamlError('unexpected characters after flow collection', no);
  return v;
}

function value(raw: string, no: number): unknown {
  const t = raw.trim();
  if (t[0] === '[' || t[0] === '{') {
    if (!(t[0] === '[' ? t.endsWith(']') : t.endsWith('}'))) throw new YamlError('multi-line flow collections are not supported', no);
    return flow(t, no);
  }
  return scalar(t, no);
}

/** Split `key: rest` at the first `:` that ends a key (outside quotes). Returns null when the line is not a mapping entry. */
function splitKey(text: string): { key: string; rest: string } | null {
  let i = 0;
  let key: string;
  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    i = 1;
    while (i < text.length && text[i] !== q) {
      if (q === '"' && text[i] === '\\') i++;
      i++;
    }
    key = String(scalar(text.slice(0, i + 1), 0));
    i++;
    if (text[i] !== ':') return null;
  } else {
    const m = /^([^\s:#][^:#]*?)\s*:(?=\s|$)/.exec(text);
    if (!m) return null;
    key = (m[1] as string).trim();
    i = m[0].length - 1;
  }
  return { key, rest: text.slice(i + 1) };
}

export function parseYaml(text: string): unknown {
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const lines: Line[] = [];
  for (let n = 0; n < raw.length; n++) {
    const full = raw[n] as string;
    if (/^\t/.test(full) || /^ *\t/.test(full)) throw new YamlError('tabs are not allowed for indentation', n + 1);
    const body = stripComment(full).replace(/\s+$/, '');
    if (body.trim() === '') continue;
    if (/^---\s*$/.test(body) && lines.length === 0) continue;
    if (/^(---|\.\.\.)\s*$/.test(body)) throw new YamlError('multi-document YAML is not supported', n + 1);
    lines.push({ indent: body.length - body.trimStart().length, text: body.trimStart(), no: n + 1 });
  }
  // block scalars need the original lines (blank lines and '#' belong to the text)
  let pos = 0;

  const blockScalar = (header: string, parentIndent: number, startNo: number): string => {
    // find raw lines after the header line number
    let n = startNo; // raw index of the line after header (0-based == startNo)
    const body: string[] = [];
    let indent = -1;
    while (n < raw.length) {
      const l = raw[n] as string;
      if (l.trim() === '') {
        body.push('');
        n++;
        continue;
      }
      const ind = l.length - l.trimStart().length;
      if (indent === -1) {
        if (ind <= parentIndent) break;
        indent = ind;
      }
      if (ind < indent) break;
      body.push(l.slice(indent));
      n++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    // skip consumed logical lines
    while (pos < lines.length && (lines[pos] as Line).no <= n) pos++;
    const folded = header.startsWith('>');
    const joined = folded ? body.join(' ').replace(/ {2,}/g, ' ') : body.join('\n');
    return header.includes('-') ? joined : `${joined}\n`;
  };

  const parseNode = (indent: number): unknown => {
    const first = lines[pos];
    if (!first || first.indent < indent) return null;
    if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(first.indent);
    return parseMap(first.indent);
  };

  const parseSeq = (indent: number): unknown[] => {
    const out: unknown[] = [];
    while (pos < lines.length) {
      const l = lines[pos] as Line;
      if (l.indent !== indent || !(l.text === '-' || l.text.startsWith('- '))) break;
      const rest = l.text === '-' ? '' : l.text.slice(2);
      const restTrim = rest.trimStart();
      if (restTrim === '') {
        pos++;
        const next = lines[pos];
        out.push(next && next.indent > indent ? parseNode(next.indent) : null);
        continue;
      }
      const offset = l.text.length - restTrim.length;
      const entry = splitKey(restTrim);
      if (entry && !/^[[{]/.test(restTrim)) {
        // "- key: value": treat the remainder as a mapping whose indentation is the column of 'key'
        lines[pos] = { indent: indent + offset, text: restTrim, no: l.no };
        out.push(parseMap(indent + offset));
      } else {
        pos++;
        out.push(value(restTrim, l.no));
      }
    }
    return out;
  };

  const parseMap = (indent: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    while (pos < lines.length) {
      const l = lines[pos] as Line;
      if (l.indent !== indent) {
        if (l.indent > indent) throw new YamlError('unexpected indentation', l.no);
        break;
      }
      if (l.text === '-' || l.text.startsWith('- ')) break;
      const kv = splitKey(l.text);
      if (!kv) throw new YamlError(`expected 'key: value', found '${l.text.slice(0, 40)}'`, l.no);
      if (kv.key === '<<') throw new YamlError('merge keys are not supported', l.no);
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new YamlError(`duplicate key '${kv.key}'`, l.no);
      const rest = kv.rest.trim();
      pos++;
      if (rest === '') {
        const next = lines[pos];
        if (next && next.indent > indent) out[kv.key] = parseNode(next.indent);
        else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) out[kv.key] = parseSeq(indent);
        else out[kv.key] = null;
      } else if (/^[|>][+-]?\d?$/.test(rest)) {
        out[kv.key] = blockScalar(rest, indent, l.no);
      } else {
        const next = lines[pos];
        if (next && next.indent > indent && !/^[[{]/.test(rest)) throw new YamlError('multi-line plain scalars are not supported', next.no);
        out[kv.key] = value(rest, l.no);
      }
    }
    return out;
  };

  if (lines.length === 0) return {};
  const first = lines[0] as Line;
  const result = first.text === '-' || first.text.startsWith('- ') ? parseSeq(first.indent) : splitKey(first.text) ? parseMap(first.indent) : value(first.text, first.no);
  if (!splitKey(first.text) && !(first.text === '-' || first.text.startsWith('- '))) pos++;
  if (pos < lines.length) throw new YamlError('unexpected content', (lines[pos] as Line).no);
  return result;
}
