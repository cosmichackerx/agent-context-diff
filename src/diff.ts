import { classify } from './discover.js';
import { diffInstructionFile, lineSet, type DiffContext } from './instructions.js';
import { diffClaudeSettings } from './claude.js';
import { parseJsonc } from './jsonc.js';
import { diffServers, extractServers } from './mcp.js';
import { SEVERITY_RANK, type DiffResult, type FileChange, type Finding, type Snapshot } from './types.js';

function parseConfig(text: string | null): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text === null) return { ok: true, value: {} };
  return parseJsonc(text);
}

/** Compare every tracked agent file between two snapshots. */
function memoize(snap: Snapshot): Snapshot {
  const cache = new Map<string, string | null>();
  return {
    label: snap.label,
    listFiles: () => snap.listFiles(),
    read: (p) => {
      if (!cache.has(p)) cache.set(p, snap.read(p));
      return cache.get(p) ?? null;
    },
  };
}

export interface DiffOptions {
  /** Opt-in: report AGENTS.md / CLAUDE.md pairs in the same directory whose content differs (rule `ctx-files-diverge`). */
  checkDivergence?: boolean;
}

/** A file whose only job is to pull in another one (`@AGENTS.md`), alone or next to extra, tool-specific text. */
export function importsFile(text: string, target: string): boolean {
  const re = new RegExp(`^\\s*(?:[-*]\\s+)?(?:see\\s+|read\\s+)?@(?:\\./)?${target.replace('.', '\\.')}\\s*$`, 'im');
  return re.test(text);
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

function divergence(base: Snapshot, head: Snapshot, changed: Set<string>): Finding[] {
  const out: Finding[] = [];
  const present = new Set(head.listFiles());
  for (const agents of [...present].filter((p) => p === 'AGENTS.md' || p.endsWith('/AGENTS.md')).sort()) {
    const dir = dirOf(agents);
    const claude = `${dir}CLAUDE.md`;
    if (!present.has(claude)) continue;
    if (!changed.has(agents) && !changed.has(claude)) continue;
    const a = head.read(agents);
    const c = head.read(claude);
    if (a === null || c === null) continue;
    if (importsFile(c, 'AGENTS.md') || importsFile(a, 'CLAUDE.md')) continue;
    const lines = (t: string): Set<string> => lineSet([t]);
    const onlyA = [...lines(a)].filter((l) => !lines(c).has(l));
    const onlyC = [...lines(c)].filter((l) => !lines(a).has(l));
    if (onlyA.length === 0 && onlyC.length === 0) continue;
    const touched = [changed.has(agents) ? 'AGENTS.md' : '', changed.has(claude) ? 'CLAUDE.md' : ''].filter(Boolean);
    out.push({
      rule: 'ctx-files-diverge',
      severity: 'low',
      category: 'instructions',
      file: claude,
      message: `${dir || './'}AGENTS.md and CLAUDE.md differ (${onlyA.length} line(s) only in AGENTS.md, ${onlyC.length} only in CLAUDE.md); this change touched ${touched.join(' and ')}. Agents that read different files get different rules; make CLAUDE.md import it with '@AGENTS.md' or keep them in sync`,
      side: 'head',
    });
  }
  return out;
}

export function diffSnapshots(rawBase: Snapshot, rawHead: Snapshot, options: DiffOptions = {}): DiffResult {
  const base = memoize(rawBase);
  const head = memoize(rawHead);
  const paths = new Set<string>();
  for (const p of base.listFiles()) if (classify(p)) paths.add(p);
  for (const p of head.listFiles()) if (classify(p)) paths.add(p);

  const files: FileChange[] = [];
  const findings: Finding[] = [];

  // Text that exists in any instruction file on one side is "known" there: moving a rule between files
  // (CLAUDE.md -> AGENTS.md, .cursorrules -> .cursor/rules/x.mdc) must not look like a deletion plus a new file.
  const instructionTexts = (snap: Snapshot): string[] =>
    snap
      .listFiles()
      .filter((p) => classify(p) === 'instructions')
      .map((p) => snap.read(p))
      .filter((t): t is string => t !== null);
  let ctx: DiffContext | undefined;
  const instructionContext = (): DiffContext => (ctx ??= { baseLines: lineSet(instructionTexts(base)), headLines: lineSet(instructionTexts(head)) });

  for (const file of [...paths].sort()) {
    const kind = classify(file);
    if (!kind) continue;
    const before = base.read(file);
    const after = head.read(file);
    if (before === null && after === null) continue;
    if (before === after) continue;
    files.push({ file, kind, status: before === null ? 'added' : after === null ? 'removed' : 'modified' });

    if (kind === 'instructions') {
      findings.push(...diffInstructionFile(file, before, after, instructionContext()));
      continue;
    }
    const pa = parseConfig(before);
    const pb = parseConfig(after);
    if (!pb.ok) {
      findings.push({
        rule: 'config-unparsable',
        severity: 'medium',
        category: 'config',
        file,
        message: `file is not valid JSON/JSONC (${pb.error}); changes could not be analysed`,
        side: 'head',
      });
      continue;
    }
    const beforeValue = pa.ok ? pa.value : {};
    if (!pa.ok) {
      findings.push({
        rule: 'config-unparsable',
        severity: 'info',
        category: 'config',
        file,
        message: `previous version was not valid JSON/JSONC (${pa.error}); treating it as empty`,
        side: 'base',
      });
    }
    findings.push(...diffServers(file, extractServers(beforeValue), extractServers(pb.value)));
    if (kind === 'claude-settings') findings.push(...diffClaudeSettings(file, beforeValue, pb.value));
  }

  if (options.checkDivergence) findings.push(...divergence(base, head, new Set(files.map((x) => x.file))));

  findings.sort(
    (x, y) =>
      x.file.localeCompare(y.file) ||
      SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] ||
      (x.line ?? 0) - (y.line ?? 0) ||
      x.rule.localeCompare(y.rule),
  );
  return { base: base.label, head: head.label, files, findings };
}

export function highestSeverity(findings: Finding[]): number {
  return findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), -1);
}
