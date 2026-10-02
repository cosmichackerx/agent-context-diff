/** Parse JSON with comments and trailing commas (JSONC / JSON5-lite), as used by editor configs. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas before } or ] (outside strings: strings were copied verbatim, so scan again carefully)
  let res = '';
  let k = 0;
  while (k < out.length) {
    const c = out[k] as string;
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') {
        if (out[j] === '\\') j++;
        j++;
      }
      res += out.slice(k, j + 1);
      k = j + 1;
    } else if (c === ',') {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j] as string)) j++;
      if (out[j] === '}' || out[j] === ']') {
        k++;
      } else {
        res += c;
        k++;
      }
    } else {
      res += c;
      k++;
    }
  }
  return res;
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export function parseJsonc(text: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(stripJsonc(text)) as unknown };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
