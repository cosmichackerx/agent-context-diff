import { isRecord } from './jsonc.js';
import type { Finding, Severity } from './types.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const APPROVAL_RANK: Record<string, number> = { untrusted: 0, 'on-failure': 1, 'on-request': 2, never: 3 };
const SANDBOX_RANK: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };

/** Diff the permission-relevant settings of a Codex `config.toml`: approvals, sandbox, network, trusted projects. */
export function diffCodexConfig(file: string, before: unknown, after: unknown): Finding[] {
  const a = isRecord(before) ? before : {};
  const b = isRecord(after) ? after : {};
  const out: Finding[] = [];
  const f = (rule: string, severity: Severity, message: string): void => {
    out.push({ rule, severity, category: 'permissions', file, message, side: 'head' });
  };

  const apA = str(a.approval_policy);
  const apB = str(b.approval_policy);
  if (apB !== undefined && apB !== apA) {
    const widened = (APPROVAL_RANK[apB] ?? 0) > (APPROVAL_RANK[apA ?? 'on-request'] ?? 2);
    if (widened) f('codex-approval-widened', apB === 'never' ? 'high' : 'medium', `approval_policy ${apA ? `${apA} -> ` : 'set to '}${apB}: Codex asks for fewer confirmations`);
  }
  const sbA = str(a.sandbox_mode);
  const sbB = str(b.sandbox_mode);
  if (sbB !== undefined && sbB !== sbA) {
    const widened = (SANDBOX_RANK[sbB] ?? 0) > (SANDBOX_RANK[sbA ?? 'read-only'] ?? 0);
    if (widened) f('codex-sandbox-widened', sbB === 'danger-full-access' ? 'high' : 'medium', `sandbox_mode ${sbA ? `${sbA} -> ` : 'set to '}${sbB}`);
  }
  const netA = isRecord(a.sandbox_workspace_write) ? a.sandbox_workspace_write.network_access : undefined;
  const netB = isRecord(b.sandbox_workspace_write) ? b.sandbox_workspace_write.network_access : undefined;
  if (netB === true && netA !== true) f('codex-network-enabled', 'medium', 'sandbox_workspace_write.network_access enabled: commands run by Codex can reach the network');
  const trustedA = trusted(a);
  for (const p of trusted(b)) {
    if (!trustedA.has(p)) f('codex-project-trusted', 'medium', `project marked trusted: ${p}`);
  }
  const envA = isRecord(a.shell_environment_policy) ? str(a.shell_environment_policy.inherit) : undefined;
  const envB = isRecord(b.shell_environment_policy) ? str(b.shell_environment_policy.inherit) : undefined;
  if (envB === 'all' && envA !== 'all') f('codex-env-inherit-all', 'medium', 'shell_environment_policy.inherit = "all": every environment variable (including secrets) is passed to commands');
  return out;
}

function trusted(cfg: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  if (isRecord(cfg.projects)) for (const [p, v] of Object.entries(cfg.projects)) if (isRecord(v) && v.trust_level === 'trusted') out.add(p);
  return out;
}
