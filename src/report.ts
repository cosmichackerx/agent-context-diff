import { SEVERITIES, SEVERITY_RANK, type DiffResult, type Finding, type Severity } from './types.js';

const COLORS: Record<Severity, string> = { high: '\x1b[31m', medium: '\x1b[33m', low: '\x1b[36m', info: '\x1b[2m' };
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

function summaryLine(findings: Finding[]): string {
  if (findings.length === 0) return 'No agent-context changes need attention.';
  const c = countBySeverity(findings);
  return `${findings.length} finding(s): ${c.high} high, ${c.medium} medium, ${c.low} low, ${c.info} info`;
}

export function renderText(r: DiffResult, color: boolean): string {
  const out: string[] = [];
  const paint = (s: string, code: string): string => (color ? `${code}${s}${RESET}` : s);
  out.push(paint(`agent-context-diff  ${r.base} → ${r.head}`, BOLD));
  out.push('');
  if (r.files.length === 0) {
    out.push('No agent instruction or MCP/agent config files changed.');
    return out.join('\n');
  }
  for (const fc of r.files) {
    out.push(`${paint(fc.file, BOLD)} (${fc.status})`);
    const items = r.findings.filter((f) => f.file === fc.file);
    if (items.length === 0) out.push('  (no findings)');
    for (const f of items) {
      const sev = paint(f.severity.toUpperCase().padEnd(6), COLORS[f.severity]);
      const loc = f.line ? `L${f.line}${f.side === 'base' ? '(base)' : ''}` : '';
      out.push(`  ${sev} ${f.rule.padEnd(26)} ${loc.padEnd(9)} ${f.message}`);
    }
    out.push('');
  }
  out.push(summaryLine(r.findings));
  return out.join('\n');
}

const EMOJI: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '🟡', info: '⚪' };

export function renderMarkdown(r: DiffResult): string {
  const out: string[] = [];
  out.push('### agent-context-diff');
  out.push('');
  out.push(`\`${r.base}\` → \`${r.head}\``);
  out.push('');
  if (r.files.length === 0) {
    out.push('No agent instruction or MCP/agent config files changed.');
    return out.join('\n');
  }
  out.push(`**${summaryLine(r.findings)}** across ${r.files.length} file(s).`);
  out.push('');
  for (const fc of r.files) {
    out.push(`#### \`${fc.file}\` (${fc.status})`);
    const items = r.findings.filter((f) => f.file === fc.file);
    if (items.length === 0) out.push('_No findings._');
    else {
      out.push('| Severity | Rule | Line | Detail |');
      out.push('|---|---|---|---|');
      for (const f of items) {
        const detail = f.message.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        out.push(`| ${EMOJI[f.severity]} ${f.severity} | \`${f.rule}\` | ${f.line ?? ''} | ${detail} |`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

export function renderJson(r: DiffResult): string {
  return JSON.stringify(
    {
      schema: 1,
      base: r.base,
      head: r.head,
      summary: countBySeverity(r.findings),
      files: r.files,
      findings: r.findings,
    },
    null,
    2,
  );
}

function ghProp(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
}
function ghData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** GitHub Actions workflow commands (`::warning file=...::msg`). */
export function renderGithub(r: DiffResult): string {
  const level: Record<Severity, string> = { high: 'error', medium: 'warning', low: 'notice', info: 'notice' };
  return r.findings
    .map((f) => {
      // line numbers only make sense for the head file; base-side lines would annotate the wrong place
      const line = f.line && f.side !== 'base' ? `,line=${f.line}` : '';
      return `::${level[f.severity]} file=${ghProp(f.file)}${line},title=${ghProp(f.rule)}::${ghData(f.message)}`;
    })
    .join('\n');
}

export function parseSeverity(s: string): Severity | undefined {
  return (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : undefined;
}

export function meetsThreshold(findings: Finding[], threshold: Severity): boolean {
  return findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[threshold]);
}
