import { isRecord } from './jsonc.js';
import type { Finding, Severity } from './types.js';
import { redact, isLiteralSecret } from './secrets.js';

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const DANGEROUS_BASH = /^Bash\((?:(?:curl|wget|rm|sudo|ssh|scp|nc|ncat|sh|bash|zsh|eval|python3?|node|npx|pip3?|docker|kubectl|chmod|chown)\b|npm\s+(?:install|publish|exec)|git\s+push)/;
const READONLY = /^(Read|Glob|Grep|LS|NotebookRead)(\(|$)|^Bash\((?:git\s+(?:status|diff|log|show|branch)|ls|pwd|cat|echo|head|tail|wc)\b/;

export function allowSeverity(entry: string): Severity {
  const e = entry.trim();
  if (e === '*' || /^(Bash|Write|Edit|MultiEdit|WebFetch)$/.test(e)) return 'high';
  if (/^Bash\((\*|:\*|\*:\*)?\)$/.test(e)) return 'high';
  if (DANGEROUS_BASH.test(e)) return 'high';
  if (/^mcp__[^_]+(__\*)?$/.test(e)) return 'medium';
  if (READONLY.test(e)) return 'low';
  return 'medium';
}

interface Hook {
  key: string;
  command: string;
}

function hooksOf(settings: Record<string, unknown>): Hook[] {
  const out: Hook[] = [];
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isRecord(g)) continue;
      const matcher = typeof g.matcher === 'string' ? g.matcher : '*';
      const inner = Array.isArray(g.hooks) ? g.hooks : [g];
      for (const h of inner) {
        if (!isRecord(h)) continue;
        const command = typeof h.command === 'string' ? h.command : typeof h.prompt === 'string' ? `prompt: ${h.prompt}` : JSON.stringify(h);
        out.push({ key: `${event}|${matcher}|${command}`, command: `${event}[${matcher}]: ${command}` });
      }
    }
  }
  return out;
}

function clip(s: string, n = 140): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Diff the security-relevant parts of `.claude/settings*.json` (permissions, hooks, env, MCP gates). */
export function diffClaudeSettings(file: string, before: unknown, after: unknown): Finding[] {
  const a = isRecord(before) ? before : {};
  const b = isRecord(after) ? after : {};
  const out: Finding[] = [];
  const f = (rule: string, severity: Severity, message: string, category: Finding['category'] = 'permissions', side: 'base' | 'head' = 'head'): void => {
    out.push({ rule, severity, category, file, message, side });
  };

  const permsA = isRecord(a.permissions) ? a.permissions : {};
  const permsB = isRecord(b.permissions) ? b.permissions : {};

  for (const list of ['allow', 'ask', 'deny'] as const) {
    const x = new Set(strList(permsA[list]));
    const y = new Set(strList(permsB[list]));
    for (const e of y) {
      if (x.has(e)) continue;
      if (list === 'allow') f('perm-allow-added', allowSeverity(e), `permission allow rule added: ${clip(e)}`);
      else if (list === 'ask') f('perm-ask-added', 'info', `permission ask rule added: ${clip(e)}`);
      else f('perm-deny-added', 'info', `permission deny rule added: ${clip(e)}`);
    }
    for (const e of x) {
      if (y.has(e)) continue;
      if (list === 'deny') f('perm-deny-removed', 'high', `permission deny rule removed (guardrail): ${clip(e)}`, 'permissions', 'base');
      else if (list === 'ask') f('perm-ask-removed', 'medium', `permission ask rule removed (no longer prompts): ${clip(e)}`, 'permissions', 'base');
      else f('perm-allow-removed', 'info', `permission allow rule removed: ${clip(e)}`, 'permissions', 'base');
    }
  }

  const dirsA = new Set(strList(permsA.additionalDirectories));
  for (const d of strList(permsB.additionalDirectories)) {
    if (!dirsA.has(d)) f('perm-directory-added', 'medium', `additional directory the agent may access: ${clip(d)}`);
  }

  const modeA = typeof permsA.defaultMode === 'string' ? permsA.defaultMode : undefined;
  const modeB = typeof permsB.defaultMode === 'string' ? permsB.defaultMode : undefined;
  if (modeA !== modeB) {
    const sev: Severity = modeB === 'bypassPermissions' ? 'high' : modeB === 'acceptEdits' ? 'medium' : 'low';
    f('perm-default-mode-changed', sev, `defaultMode changed: ${modeA ?? '(default)'} → ${modeB ?? '(default)'}`);
  }

  // hooks execute arbitrary shell commands on agent events
  const hooksA = new Map(hooksOf(a).map((h) => [h.key, h]));
  const hooksB = new Map(hooksOf(b).map((h) => [h.key, h]));
  for (const [k, h] of hooksB) if (!hooksA.has(k)) f('hook-added', 'high', `hook added (runs a command on agent events): ${clip(h.command)}`, 'hooks');
  for (const [k, h] of hooksA) if (!hooksB.has(k)) f('hook-removed', 'low', `hook removed: ${clip(h.command)}`, 'hooks', 'base');

  // MCP gates
  if (b.enableAllProjectMcpServers === true && a.enableAllProjectMcpServers !== true) {
    f('mcp-enable-all', 'high', 'enableAllProjectMcpServers turned on: every server in .mcp.json is auto-approved', 'mcp');
  }
  const enabledA = new Set(strList(a.enabledMcpjsonServers));
  for (const s of strList(b.enabledMcpjsonServers)) if (!enabledA.has(s)) f('mcp-server-approved', 'medium', `project MCP server '${s}' pre-approved`, 'mcp');

  // misc
  if (a.apiKeyHelper !== b.apiKeyHelper && b.apiKeyHelper !== undefined) f('settings-api-key-helper', 'high', `apiKeyHelper changed: ${clip(String(b.apiKeyHelper))}`, 'config');
  const envA = isRecord(a.env) ? a.env : {};
  const envB = isRecord(b.env) ? b.env : {};
  for (const [k, v] of Object.entries(envB)) {
    if (!(k in envA)) f('settings-env-added', 'medium', `env '${k}' added to every session`, 'config');
    else if (envA[k] !== v) f('settings-env-changed', 'low', `env '${k}' changed (value not shown)`, 'config');
    if (typeof v === 'string' && (!(k in envA) || envA[k] !== v) && isLiteralSecret(k, v)) {
      f('settings-secret-literal', 'high', `env '${k}' contains a literal credential ${redact(v)}`, 'config');
    }
  }
  for (const k of Object.keys(envA)) if (!(k in envB)) f('settings-env-removed', 'low', `env '${k}' removed`, 'config', 'base');
  if (isRecord(b.env) && (b.env.ANTHROPIC_BASE_URL !== undefined) && (envA.ANTHROPIC_BASE_URL !== b.env.ANTHROPIC_BASE_URL)) {
    f('settings-base-url', 'high', 'ANTHROPIC_BASE_URL overridden: model traffic (including your code) goes to another endpoint', 'config');
  }
  return out;
}
