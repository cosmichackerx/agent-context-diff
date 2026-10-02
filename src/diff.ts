import { classify } from './discover.js';
import { diffInstructionFile } from './instructions.js';
import { diffClaudeSettings } from './claude.js';
import { parseJsonc } from './jsonc.js';
import { diffServers, extractServers } from './mcp.js';
import { SEVERITY_RANK, type DiffResult, type FileChange, type Finding, type Snapshot } from './types.js';

function parseConfig(text: string | null): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text === null) return { ok: true, value: {} };
  return parseJsonc(text);
}

/** Compare every tracked agent file between two snapshots. */
export function diffSnapshots(base: Snapshot, head: Snapshot): DiffResult {
  const paths = new Set<string>();
  for (const p of base.listFiles()) if (classify(p)) paths.add(p);
  for (const p of head.listFiles()) if (classify(p)) paths.add(p);

  const files: FileChange[] = [];
  const findings: Finding[] = [];

  for (const file of [...paths].sort()) {
    const kind = classify(file);
    if (!kind) continue;
    const before = base.read(file);
    const after = head.read(file);
    if (before === null && after === null) continue;
    if (before === after) continue;
    files.push({ file, kind, status: before === null ? 'added' : after === null ? 'removed' : 'modified' });

    if (kind === 'instructions') {
      findings.push(...diffInstructionFile(file, before, after));
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
