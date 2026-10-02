import { SEVERITY_RANK, type Finding, type Severity } from './types.js';
import { matchesTokenPattern, redactTokens } from './secrets.js';

export interface Section {
  /** Heading path such as `Testing > Unit tests`; `(top)` for text before the first heading. */
  key: string;
  /** Lines of the section body (heading line excluded). */
  lines: { text: string; line: number }[];
  headingLine: number;
}

export interface Parsed {
  frontmatter: Record<string, string>;
  sections: Section[];
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(```+|~~~+)/;

function parseFrontmatter(lines: string[]): { fm: Record<string, string>; bodyStart: number } {
  if (lines[0]?.trim() !== '---') return { fm: {}, bodyStart: 0 };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---' || lines[i]?.trim() === '...') {
      const fm: Record<string, string> = {};
      let currentKey: string | null = null;
      for (const raw of lines.slice(1, i)) {
        const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
        if (kv) {
          currentKey = kv[1] as string;
          fm[currentKey] = (kv[2] as string).trim();
        } else if (currentKey && raw.trim() !== '') {
          fm[currentKey] = `${fm[currentKey] ?? ''} ${raw.trim()}`.trim();
        }
      }
      return { fm, bodyStart: i + 1 };
    }
  }
  return { fm: {}, bodyStart: 0 };
}

export function parseMarkdown(text: string): Parsed {
  const lines = text.split('\n');
  const { fm, bodyStart } = parseFrontmatter(lines);
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  const seen = new Map<string, number>();
  let current: Section = { key: '(top)', lines: [], headingLine: 0 };
  sections.push(current);
  seen.set('(top)', 1);
  let fence: string | null = null;

  for (let i = bodyStart; i < lines.length; i++) {
    const raw = lines[i] as string;
    const f = FENCE.exec(raw);
    if (f) {
      const marker = (f[1] as string)[0] as string;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }
    const h = fence === null ? HEADING.exec(raw) : null;
    if (h) {
      const level = (h[1] as string).length;
      while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level) stack.pop();
      stack.push({ level, title: h[2] as string });
      let key = stack.map((s) => s.title).join(' > ');
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 1) key = `${key} (#${n})`;
      current = { key, lines: [], headingLine: i + 1 };
      sections.push(current);
    } else {
      current.lines.push({ text: raw, line: i + 1 });
    }
  }
  return { frontmatter: fm, sections };
}

// ---------------------------------------------------------------------------------------------
// line diff
// ---------------------------------------------------------------------------------------------

export interface LineDiff {
  added: { text: string; line: number }[];
  removed: { text: string; line: number }[];
}

type L = { text: string; line: number };
const norm = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** LCS-based line diff ignoring whitespace-only differences; falls back to multiset diff for huge inputs. */
export function diffLines(before: L[], after: L[]): LineDiff {
  const a = before.filter((l) => norm(l.text) !== '');
  const b = after.filter((l) => norm(l.text) !== '');
  const added: L[] = [];
  const removed: L[] = [];
  if (a.length * b.length > 4_000_000) {
    const counts = new Map<string, number>();
    for (const l of a) counts.set(norm(l.text), (counts.get(norm(l.text)) ?? 0) + 1);
    for (const l of b) {
      const c = counts.get(norm(l.text)) ?? 0;
      if (c > 0) counts.set(norm(l.text), c - 1);
      else added.push(l);
    }
    const countsB = new Map<string, number>();
    for (const l of b) countsB.set(norm(l.text), (countsB.get(norm(l.text)) ?? 0) + 1);
    for (const l of a) {
      const c = countsB.get(norm(l.text)) ?? 0;
      if (c > 0) countsB.set(norm(l.text), c - 1);
      else removed.push(l);
    }
    return { added, removed };
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        norm((a[i] as L).text) === norm((b[j] as L).text)
          ? (dp[i + 1]![j + 1] as number) + 1
          : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (norm((a[i] as L).text) === norm((b[j] as L).text)) {
      i++;
      j++;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      removed.push(a[i++] as L);
    } else {
      added.push(b[j++] as L);
    }
  }
  while (i < n) removed.push(a[i++] as L);
  while (j < m) added.push(b[j++] as L);
  return { added, removed };
}

// ---------------------------------------------------------------------------------------------
// content heuristics
// ---------------------------------------------------------------------------------------------

const NEGATIVE_DIRECTIVE = /\b(never|must not|mustn't|do not|don't|dont|forbidden|prohibited|not allowed|avoid)\b/i;
const DIRECTIVE = /\b(never|must not|do not|don't|forbidden|prohibited|must|always|required|only)\b/i;

export function isNegativeDirective(line: string): boolean {
  return NEGATIVE_DIRECTIVE.test(line);
}
export function isDirective(line: string): boolean {
  return DIRECTIVE.test(line);
}

interface Risk {
  rule: string;
  severity: Severity;
  re: RegExp;
  what: string;
}

const RISKS: Risk[] = [
  { rule: 'ctx-injection-phrase', severity: 'high', what: 'contains a prompt-injection style phrase', re: /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?)\b/i },
  { rule: 'ctx-injection-phrase', severity: 'high', what: 'tells the agent to hide things from the user', re: /\b(do not|don't|never|without)\b[^.\n]{0,25}\b(tell|inform|notify|mention|show|reveal|alert)\b[^.\n]{0,25}\b(the )?(user|human|developer|reviewer)\b/i },
  { rule: 'ctx-injection-phrase', severity: 'medium', what: 'contains secrecy wording', re: /\b(secretly|silently|covertly|quietly)\b/i },
  { rule: 'ctx-dangerous-command', severity: 'high', what: 'pipes a download into a shell', re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i },
  { rule: 'ctx-dangerous-command', severity: 'high', what: 'disables agent permission checks', re: /--dangerously-skip-permissions|--yolo\b|--dangerously-bypass-approvals-and-sandbox|bypassPermissions/i },
  { rule: 'ctx-dangerous-command', severity: 'high', what: 'contains a destructive delete', re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$|\*)/i },
  { rule: 'ctx-dangerous-command', severity: 'medium', what: 'bypasses git hooks or force-pushes', re: /--no-verify\b|git\s+push\s+(--force|-f)\b|--force-with-lease/i },
  { rule: 'ctx-dangerous-command', severity: 'medium', what: 'changes permissions broadly or escalates privileges', re: /\bchmod\s+(-R\s+)?7[0-7][0-7]\b|\bsudo\s+\S+/i },
  { rule: 'ctx-dangerous-command', severity: 'medium', what: 'executes decoded or evaluated content', re: /base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh|\beval\s*[(`$"']/i },
  { rule: 'ctx-exfiltration', severity: 'medium', what: 'asks to send data to an external endpoint', re: /\b(send|upload|post|exfiltrate|forward|transmit)\b[^.\n]{0,60}\b(to|at)\b[^.\n]{0,20}https?:\/\//i },
];

const ZERO_WIDTH_AND_BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\u180E]/;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/u;

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function hiddenCodePoints(line: string): string[] {
  const out = new Set<string>();
  for (const ch of line) {
    const cp = ch.codePointAt(0) as number;
    if (ZERO_WIDTH_AND_BIDI.test(ch) || TAG_CHARS.test(ch)) out.add(hex(cp));
  }
  return [...out];
}

export interface ScanOptions {
  file: string;
  category: Finding['category'];
}

/** Heuristic scan of *added* lines. Each finding points at the head file line. */
export function scanAddedLines(lines: L[], opts: ScanOptions): Finding[] {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, 'file' | 'category' | 'side'>): void => {
    out.push({ ...f, file: opts.file, category: opts.category, side: 'head' });
  };
  let urls = 0;
  let firstUrlLine = 0;
  for (const l of lines) {
    const hidden = hiddenCodePoints(l.text);
    if (hidden.length > 0) {
      add({
        rule: 'ctx-hidden-characters',
        severity: 'high',
        line: l.line,
        message: `added line contains invisible Unicode characters (${hidden.join(', ')}); these can hide instructions from reviewers`,
      });
    }
    if (/<!--/.test(l.text)) {
      add({
        rule: 'ctx-html-comment',
        severity: 'medium',
        line: l.line,
        message: 'added HTML comment: invisible in rendered Markdown but still read by agents',
      });
    }
    for (const r of RISKS) {
      if (r.re.test(l.text)) {
        add({ rule: r.rule, severity: r.severity, line: l.line, message: `added line ${r.what}: ${snippet(l.text)}` });
      }
    }
    if (matchesTokenPattern(l.text)) {
      add({ rule: 'ctx-secret-literal', severity: 'high', line: l.line, message: 'added line contains what looks like a credential (value not shown)' });
    }
    if (/[A-Za-z0-9+/]{120,}={0,2}/.test(l.text) && !/https?:\/\//.test(l.text)) {
      add({ rule: 'ctx-encoded-blob', severity: 'medium', line: l.line, message: 'added line contains a long base64-like blob' });
    }
    if (/https?:\/\/\S+/.test(l.text)) {
      urls++;
      if (!firstUrlLine) firstUrlLine = l.line;
    }
  }
  if (urls > 0) {
    add({ rule: 'ctx-url-added', severity: 'info', line: firstUrlLine, message: `${urls} added line(s) contain URLs` });
  }
  return dedupe(out);
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const k = `${f.rule}|${f.line}|${f.message}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

export function snippet(text: string, max = 100): string {
  const visible = Array.from(redactTokens(text))
    .map((ch) => (hiddenCodePoints(ch).length > 0 ? `[${hiddenCodePoints(ch)[0]}]` : ch))
    .join('');
  const t = visible.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
