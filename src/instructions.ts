import type { Finding, Severity } from './types.js';
import {
  diffLines,
  isDirective,
  isNegativeDirective,
  prohibitionSnippet,
  parseMarkdown,
  scanAddedLines,
  snippet,
  type Parsed,
} from './markdown.js';

const MAX_LINE_FINDINGS = 12;
/** More section-level notices than this per file are collapsed into one summary line. */
const MAX_SECTION_NOTICES = 6;

/** Whitespace-normalised line used to recognise text that merely moved between sections or files. */
export const normLine = (t: string): string => t.trim().replace(/\s+/g, ' ');

/** Every non-empty normalised line of the given instruction files. */
export function lineSet(texts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const l of t.split('\n')) if (l.trim() !== '') out.add(normLine(l));
  return out;
}

export interface DiffContext {
  /** Lines of ALL instruction files on the base side. A line found here is not new text. */
  baseLines?: ReadonlySet<string>;
  /** Lines of ALL instruction files on the head side. A line found here was not deleted, only moved. */
  headLines?: ReadonlySet<string>;
}

const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[a-z0-9_`'-]{2,}/g) ?? []);

/** True when `a` is a (near-)duplicate of `b`: fully contained in it, or a Dice overlap of at least 0.75. */
function similar(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  if (shared === a.size && a.size >= 3) return true;
  return (2 * shared) / (a.size + b.size) >= 0.75;
}

/** Files loaded into every session (as opposed to on-demand skills, commands and scoped rules). */
export function isAlwaysLoaded(file: string, frontmatter: Record<string, string> = {}): boolean {
  const base = file.split('/').pop() ?? file;
  if (/^(AGENTS|AGENT|CLAUDE|CLAUDE\.local|GEMINI)\.md$|^AGENTS\.override\.md$|^\.(cursor|windsurf|cline)rules$/.test(base)) return true;
  if (file === '.github/copilot-instructions.md' || file === '.junie/guidelines.md') return true;
  return frontmatter.alwaysApply?.toLowerCase() === 'true';
}

const SENSITIVE_FRONTMATTER = new Set([
  'tools',
  'allowed-tools',
  'allowedtools',
  'disallowed-tools',
  'alwaysapply',
  'permissionmode',
  'disable-model-invocation',
  'model',
  'globs',
]);

function countLines(p: Parsed): number {
  return p.sections.reduce((n, s) => n + s.lines.filter((l) => l.text.trim() !== '').length, 0);
}

/** Compare one instruction file (AGENTS.md, CLAUDE.md, Cursor rule, SKILL.md ...). */
export function diffInstructionFile(file: string, before: string | null, after: string | null, ctx: DiffContext = {}): Finding[] {
  const out: Finding[] = [];
  const f = (rule: string, severity: Severity, message: string, extra: Partial<Finding> = {}): void => {
    out.push({ rule, severity, category: 'instructions', file, message, ...extra });
  };
  const inBase = (t: string): boolean => ctx.baseLines?.has(normLine(t)) ?? false;
  const inHead = (t: string): boolean => ctx.headLines?.has(normLine(t)) ?? false;
  const nonEmpty = (p: Parsed): { text: string; line: number }[] => p.sections.flatMap((s) => s.lines).filter((l) => l.text.trim() !== '');

  if (before === null && after !== null) {
    const parsed = parseMarkdown(after);
    const lines = nonEmpty(parsed);
    const known = lines.filter((l) => inBase(l.text)).length;
    const moved = lines.length > 0 && known / lines.length >= 0.8;
    const always = isAlwaysLoaded(file, parsed.frontmatter);
    f(
      'ctx-file-added',
      moved ? 'info' : always ? 'medium' : 'low',
      moved
        ? `instruction file added with content that already existed elsewhere (${known}/${lines.length} lines): moved, renamed or copied`
        : `new agent instruction file (${lines.length} non-empty lines, ${parsed.sections.length - 1} section(s))${always ? ', loaded into every session' : ''}`,
      { line: 1, side: 'head' },
    );
    // text that already existed in another instruction file is not new
    out.push(...scanAddedLines(parsed.sections.flatMap((s) => s.lines).filter((l) => !inBase(l.text)), { file, category: 'instructions' }));
    return out;
  }
  if (before !== null && after === null) {
    const parsed = parseMarkdown(before);
    const lines = nonEmpty(parsed);
    const gone = lines.filter((l) => !inHead(l.text));
    const guardrails = gone.filter((l) => isNegativeDirective(l.text)).length;
    const moved = lines.length > 0 && gone.length / lines.length <= 0.2;
    // dropping a skill, command or scoped rule takes away an optional capability; dropping a root file drops its guardrails
    f(
      'ctx-file-removed',
      moved ? 'info' : guardrails > 0 && isAlwaysLoaded(file, parsed.frontmatter) ? 'medium' : 'low',
      moved
        ? `instruction file removed but its content still exists in other instruction files (${lines.length - gone.length}/${lines.length} lines): moved or renamed`
        : `agent instruction file removed (${lines.length} non-empty lines${guardrails ? `, ${guardrails} prohibition line(s) not found elsewhere` : ''})`,
    );
    return out;
  }
  if (before === null || after === null || before === after) return out;

  const a = parseMarkdown(before);
  const b = parseMarkdown(after);

  // frontmatter
  const keys = new Set([...Object.keys(a.frontmatter), ...Object.keys(b.frontmatter)]);
  for (const k of [...keys].sort()) {
    const x = a.frontmatter[k];
    const y = b.frontmatter[k];
    if (x === y) continue;
    const lower = k.toLowerCase();
    // `disable-model-invocation: true` takes capability away, so adding it is not a risk
    const restrictive = lower === 'disable-model-invocation' && y?.toLowerCase() === 'true';
    const sensitive = SENSITIVE_FRONTMATTER.has(lower) && !restrictive;
    const what = x === undefined ? `added (${snippet(y ?? '', 60)})` : y === undefined ? 'removed' : `changed: ${snippet(x, 40)} → ${snippet(y, 40)}`;
    f('ctx-frontmatter-changed', sensitive ? 'medium' : 'info', `frontmatter key '${k}' ${what}`);
  }

  // sections
  const byKeyA = new Map(a.sections.map((s) => [s.key, s]));
  const byKeyB = new Map(b.sections.map((s) => [s.key, s]));
  // A line that merely moved (to another position, section or file) is neither added nor removed.
  const allBefore = new Set(a.sections.flatMap((s) => s.lines.map((l) => normLine(l.text))));
  const allAfter = new Set(b.sections.flatMap((s) => s.lines.map((l) => normLine(l.text))));
  const knownBefore = (t: string): boolean => allBefore.has(normLine(t)) || inBase(t);
  const knownAfter = (t: string): boolean => allAfter.has(normLine(t)) || inHead(t);
  const addedLinesAll: { text: string; line: number }[] = [];
  const notices: Finding[] = [];
  let lineFindings = 0;
  let suppressed = 0;
  const notice = (rule: string, severity: Severity, message: string, extra: Partial<Finding>): void => {
    notices.push({ rule, severity, category: 'instructions', file, message, ...extra });
  };

  // A prohibition that was only reworded ("Avoid X" -> "Avoid X or Y") still stands in the head file.
  const headProhibitions = b.sections.flatMap((s) => s.lines).filter((l) => isNegativeDirective(l.text)).map((l) => words(l.text));
  const reworded = (text: string): boolean => {
    const w = words(text);
    return headProhibitions.some((h) => similar(w, h));
  };
  const guardrail = (l: { text: string; line: number }): void => {
    if (reworded(l.text)) return;
    if (lineFindings >= MAX_LINE_FINDINGS) {
      suppressed++;
      return;
    }
    lineFindings++;
    f('ctx-guardrail-removed', 'medium', `prohibition removed: "${prohibitionSnippet(l.text)}"`, { line: l.line, side: 'base' });
  };

  for (const [key, sa] of byKeyA) {
    if (byKeyB.has(key)) continue;
    const body = sa.lines.filter((l) => l.text.trim());
    const gone = body.filter((l) => !knownAfter(l.text));
    const prohibitions = gone.filter((l) => isNegativeDirective(l.text));
    const moved = body.length > 0 && gone.length === 0;
    notice(
      'ctx-section-removed',
      moved ? 'info' : 'low',
      `section '${key}' removed (${body.length} lines${prohibitions.length ? `, ${prohibitions.length} prohibition line(s) listed separately` : ''}${moved ? '; all of it still exists elsewhere: renamed or moved' : ''})`,
      { line: sa.headingLine || 1, side: 'base' },
    );
    for (const l of prohibitions) guardrail(l);
  }
  for (const [key, sb] of byKeyB) {
    const sa = byKeyA.get(key);
    if (!sa) {
      const body = sb.lines.filter((l) => l.text.trim());
      const fresh = sb.lines.filter((l) => l.text.trim() && !knownBefore(l.text));
      notice(
        'ctx-section-added',
        'info',
        `section '${key}' added (${body.length} lines${body.length > 0 && fresh.length === 0 ? '; all of it existed elsewhere: renamed or moved' : ''})`,
        { line: sb.headingLine || 1, side: 'head' },
      );
      addedLinesAll.push(...fresh);
      continue;
    }
    const raw = diffLines(sa.lines, sb.lines);
    const d = {
      added: raw.added.filter((l) => !knownBefore(l.text)),
      removed: raw.removed.filter((l) => !knownAfter(l.text)),
    };
    if (d.added.length === 0 && d.removed.length === 0) continue;
    const dirAdded = d.added.filter((l) => isDirective(l.text)).length;
    const dirRemoved = d.removed.filter((l) => isNegativeDirective(l.text)).length;
    notice(
      'ctx-section-changed',
      dirAdded + dirRemoved > 0 ? 'low' : 'info',
      `section '${key}' changed (+${d.added.length} −${d.removed.length} lines)`,
      { line: sb.headingLine || 1, side: 'head' },
    );
    addedLinesAll.push(...d.added);
    for (const l of d.removed) if (isNegativeDirective(l.text)) guardrail(l);
  }
  if (suppressed > 0) f('ctx-guardrail-removed', 'medium', `${suppressed} more prohibition line(s) removed (not listed)`);

  // Many low-value structural notices in one file (big rewrites) become a single summary line.
  const quiet = notices.filter((n) => n.severity === 'info' || n.severity === 'low');
  if (quiet.length > MAX_SECTION_NOTICES) {
    const count = (rule: string): number => quiet.filter((n) => n.rule === rule).length;
    const loud = notices.filter((n) => !quiet.includes(n));
    out.push(...loud);
    f(
      'ctx-section-changed',
      quiet.some((n) => n.severity === 'low') ? 'low' : 'info',
      `${quiet.length} section-level changes: ${count('ctx-section-added')} added, ${count('ctx-section-removed')} removed, ${count('ctx-section-changed')} changed (listed individually when there are ${MAX_SECTION_NOTICES} or fewer)`,
      { line: 1, side: 'head' },
    );
  } else {
    out.push(...notices);
  }

  out.push(...scanAddedLines(addedLinesAll, { file, category: 'instructions' }));
  return out;
}
