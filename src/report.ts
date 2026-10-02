import { createHash } from 'node:crypto';
import { RULES } from './rules.js';
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

const SARIF_LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { high: 'error', medium: 'warning', low: 'note', info: 'note' };
// GitHub code scanning shows `security-severity` (0-10) as Critical/High/Medium/Low
const SARIF_SECURITY_SEVERITY: Record<Severity, string> = { high: '8.0', medium: '5.5', low: '3.0', info: '1.0' };

/**
 * SARIF 2.1.0 for GitHub code scanning (`github/codeql-action/upload-sarif`).
 * Head-side findings carry `region.startLine`; base-side findings (something that was removed) are attached to the
 * file without a region, because a base line number would point at the wrong place in the head file.
 */
export function renderSarif(r: DiffResult, toolVersion: string): string {
  const usedRules = [...new Set(r.findings.map((f) => f.rule))].sort();
  const worst = (rule: string): Severity =>
    r.findings.filter((f) => f.rule === rule).reduce<Severity>((m, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[m] ? f.severity : m), 'info');
  const allRules = [...new Set([...Object.keys(RULES), ...usedRules])].sort();
  const rules = allRules.map((id) => {
    const sev = worst(id);
    return {
      id,
      name: id.replace(/(^|-)([a-z])/g, (_m, _d, c: string) => c.toUpperCase()),
      shortDescription: { text: RULES[id] ?? id },
      helpUri: 'https://github.com/cosmichackerx/agent-context-diff#rules-selection',
      defaultConfiguration: { level: SARIF_LEVEL[sev] },
      properties: { tags: ['security', 'ai-agents'], 'security-severity': SARIF_SECURITY_SEVERITY[sev] },
    };
  });
  const ruleIndex = new Map(allRules.map((id, i) => [id, i]));
  const results = r.findings.map((f) => {
    const physicalLocation: Record<string, unknown> = { artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' } };
    if (f.line && f.side !== 'base') physicalLocation.region = { startLine: f.line };
    const where = f.side === 'base' ? ' (from the base version of the file)' : '';
    return {
      ruleId: f.rule,
      ruleIndex: ruleIndex.get(f.rule) ?? 0,
      level: SARIF_LEVEL[f.severity],
      message: { text: `${f.message}${where}` },
      locations: [{ physicalLocation }],
      partialFingerprints: { 'agentContextDiff/v1': createHash('sha256').update(`${f.rule}\n${f.file}\n${f.message}`).digest('hex').slice(0, 32) },
      properties: { severity: f.severity, category: f.category, side: f.side ?? 'head' },
    };
  });
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'agent-context-diff',
              version: toolVersion,
              informationUri: 'https://github.com/cosmichackerx/agent-context-diff',
              rules,
            },
          },
          originalUriBaseIds: { '%SRCROOT%': { description: { text: 'Repository root' } } },
          properties: { base: r.base, head: r.head },
          results,
        },
      ],
    },
    null,
    2,
  );
}
