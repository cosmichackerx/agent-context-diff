import type { Finding, Severity } from './types.js';
import {
  diffLines,
  isDirective,
  isNegativeDirective,
  parseMarkdown,
  scanAddedLines,
  snippet,
  type Parsed,
} from './markdown.js';

const MAX_LINE_FINDINGS = 12;

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
export function diffInstructionFile(file: string, before: string | null, after: string | null): Finding[] {
  const out: Finding[] = [];
  const f = (rule: string, severity: Severity, message: string, extra: Partial<Finding> = {}): void => {
    out.push({ rule, severity, category: 'instructions', file, message, ...extra });
  };

  if (before === null && after !== null) {
    const parsed = parseMarkdown(after);
    f('ctx-file-added', 'medium', `new agent instruction file (${countLines(parsed)} non-empty lines, ${parsed.sections.length - 1} section(s))`, { line: 1, side: 'head' });
    const all = parsed.sections.flatMap((s) => s.lines);
    out.push(...scanAddedLines(all, { file, category: 'instructions' }));
    return out;
  }
  if (before !== null && after === null) {
    const parsed = parseMarkdown(before);
    const guardrails = parsed.sections.flatMap((s) => s.lines).filter((l) => isNegativeDirective(l.text)).length;
    f(
      'ctx-file-removed',
      guardrails > 0 ? 'medium' : 'low',
      `agent instruction file removed (${countLines(parsed)} non-empty lines${guardrails ? `, ${guardrails} prohibition line(s)` : ''})`,
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
    const sensitive = SENSITIVE_FRONTMATTER.has(k.toLowerCase());
    const what = x === undefined ? `added (${snippet(y ?? '', 60)})` : y === undefined ? 'removed' : `changed: ${snippet(x, 40)} → ${snippet(y, 40)}`;
    f('ctx-frontmatter-changed', sensitive ? 'medium' : 'info', `frontmatter key '${k}' ${what}`);
  }

  // sections
  const byKeyA = new Map(a.sections.map((s) => [s.key, s]));
  const byKeyB = new Map(b.sections.map((s) => [s.key, s]));
  // A line that merely moved (to another position or section) is neither added nor removed.
  const normLine = (t: string): string => t.trim().replace(/\s+/g, ' ');
  const allBefore = new Set(a.sections.flatMap((s) => s.lines.map((l) => normLine(l.text))));
  const allAfter = new Set(b.sections.flatMap((s) => s.lines.map((l) => normLine(l.text))));
  const addedLinesAll: { text: string; line: number }[] = [];
  let lineFindings = 0;
  let suppressed = 0;

  for (const [key, sa] of byKeyA) {
    if (byKeyB.has(key)) continue;
    const dir = sa.lines.filter((l) => isNegativeDirective(l.text) && !allAfter.has(normLine(l.text))).length;
    f('ctx-section-removed', dir > 0 ? 'medium' : 'low', `section '${key}' removed (${sa.lines.filter((l) => l.text.trim()).length} lines${dir ? `, ${dir} prohibition line(s)` : ''})`, { line: sa.headingLine || 1, side: 'base' });
  }
  for (const [key, sb] of byKeyB) {
    const sa = byKeyA.get(key);
    if (!sa) {
      f('ctx-section-added', 'low', `section '${key}' added (${sb.lines.filter((l) => l.text.trim()).length} lines)`, { line: sb.headingLine || 1, side: 'head' });
      addedLinesAll.push(...sb.lines.filter((l) => !allBefore.has(normLine(l.text))));
      continue;
    }
    const raw = diffLines(sa.lines, sb.lines);
    const d = {
      added: raw.added.filter((l) => !allBefore.has(normLine(l.text))),
      removed: raw.removed.filter((l) => !allAfter.has(normLine(l.text))),
    };
    if (d.added.length === 0 && d.removed.length === 0) continue;
    const dirAdded = d.added.filter((l) => isDirective(l.text)).length;
    const dirRemoved = d.removed.filter((l) => isNegativeDirective(l.text)).length;
    f(
      'ctx-section-changed',
      dirAdded + dirRemoved > 0 ? 'low' : 'info',
      `section '${key}' changed (+${d.added.length} −${d.removed.length} lines)`,
      { line: sb.headingLine || 1, side: 'head' },
    );
    addedLinesAll.push(...d.added);
    for (const l of d.removed) {
      if (!isNegativeDirective(l.text)) continue;
      if (lineFindings >= MAX_LINE_FINDINGS) {
        suppressed++;
        continue;
      }
      lineFindings++;
      f('ctx-guardrail-removed', 'medium', `prohibition removed: "${snippet(l.text)}"`, { line: l.line, side: 'base' });
    }
  }
  if (suppressed > 0) f('ctx-guardrail-removed', 'medium', `${suppressed} more prohibition line(s) removed (not listed)`);

  out.push(...scanAddedLines(addedLinesAll, { file, category: 'instructions' }));
  return out;
}
