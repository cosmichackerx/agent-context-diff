import { parseJsonc } from './jsonc.js';
import { SEVERITY_RANK, type Finding, type IgnoredFinding, type Snapshot } from './types.js';

/** Repo-relative location of the allow-list. It is always read from the BASE ref. */
export const ALLOWLIST_FILE = '.agent-context-diff.json';

export interface IgnoreEntry {
  /** Rule id or glob (`mcp-*`). */
  rule: string;
  /** Repo-relative path glob (`*` within a directory, `**` across). Default: any file. */
  file?: string;
  /** MCP server name (or glob) the finding is about. */
  server?: string;
  /** Case-insensitive substring of the finding message. */
  contains?: string;
  /** Why this is accepted. Mandatory: it is shown in every report. */
  reason: string;
  /** `YYYY-MM-DD`; the entry stops applying after this day (UTC). */
  expires?: string;
}

export interface Allowlist {
  entries: IgnoreEntry[];
}

export type ParsedAllowlist = { ok: true; allowlist: Allowlist } | { ok: false; error: string };

const KEYS = new Set(['rule', 'file', 'server', 'contains', 'reason', 'expires']);

export function parseAllowlist(text: string): ParsedAllowlist {
  const parsed = parseJsonc(text);
  if (!parsed.ok) return { ok: false, error: `not valid JSON (${parsed.error})` };
  const root = parsed.value as Record<string, unknown> | null;
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return { ok: false, error: 'top level must be an object with an "ignore" array' };
  for (const k of Object.keys(root)) if (k !== 'ignore' && k !== '$schema') return { ok: false, error: `unknown top-level key "${k}"` };
  const list = root.ignore ?? [];
  if (!Array.isArray(list)) return { ok: false, error: '"ignore" must be an array' };
  const entries: IgnoreEntry[] = [];
  for (const [i, raw] of list.entries()) {
    const where = `ignore[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${where} must be an object` };
    const o = raw as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!KEYS.has(k)) return { ok: false, error: `${where} has unknown key "${k}" (allowed: ${[...KEYS].join(', ')})` };
    for (const k of KEYS) if (k in o && typeof o[k] !== 'string') return { ok: false, error: `${where}.${k} must be a string` };
    if (!o.rule || !(o.rule as string).trim()) return { ok: false, error: `${where}.rule is required` };
    if (!o.reason || !(o.reason as string).trim()) return { ok: false, error: `${where}.reason is required: say why this is accepted` };
    if (o.expires !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(o.expires as string)) return { ok: false, error: `${where}.expires must look like 2026-12-31` };
    const narrowed = o.file !== undefined || o.server !== undefined || o.contains !== undefined;
    if ((o.rule as string).includes('*') && !narrowed) {
      return { ok: false, error: `${where} uses a wildcard rule without file, server or contains; that would hide whole classes of findings everywhere` };
    }
    entries.push(o as unknown as IgnoreEntry);
  }
  return { ok: true, allowlist: { entries } };
}

/** Glob with `*` (no slash), `**` (anything) and `?`. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

const serverOf = (message: string): string | undefined => /^server '([^']+)'/.exec(message)?.[1];

export function entryMatches(e: IgnoreEntry, f: Finding): boolean {
  if (!globToRegExp(e.rule).test(f.rule)) return false;
  if (e.file !== undefined && !globToRegExp(e.file).test(f.file)) return false;
  if (e.server !== undefined) {
    const s = serverOf(f.message);
    if (s === undefined || !globToRegExp(e.server).test(s)) return false;
  }
  if (e.contains !== undefined && !f.message.toLowerCase().includes(e.contains.toLowerCase())) return false;
  return true;
}

export function isExpired(e: IgnoreEntry, now: Date): boolean {
  return e.expires !== undefined && now.getTime() > Date.parse(`${e.expires}T23:59:59Z`);
}

export function describeEntry(e: IgnoreEntry): string {
  const parts = [`rule=${e.rule}`];
  if (e.file !== undefined) parts.push(`file=${e.file}`);
  if (e.server !== undefined) parts.push(`server=${e.server}`);
  if (e.contains !== undefined) parts.push(`contains="${e.contains}"`);
  if (e.expires !== undefined) parts.push(`expires=${e.expires}`);
  return parts.join(' ');
}

export interface AllowlistOutcome {
  findings: Finding[];
  ignored: IgnoredFinding[];
  /** Entries that matched nothing (stale: remove them). */
  unused: string[];
  /** Entries that no longer apply because they expired. */
  expired: string[];
  source: 'base' | 'file' | 'none';
  /** Set when the allow-list exists but could not be used. */
  error?: string;
}

export function applyAllowlist(findings: Finding[], list: Allowlist | undefined, source: 'base' | 'file' | 'none', now: Date): AllowlistOutcome {
  if (!list) return { findings, ignored: [], unused: [], expired: [], source };
  const used = new Set<number>();
  const expired: string[] = [];
  list.entries.forEach((e) => {
    if (isExpired(e, now)) expired.push(describeEntry(e));
  });
  const kept: Finding[] = [];
  const ignored: IgnoredFinding[] = [];
  for (const f of findings) {
    const idx = list.entries.findIndex((e, i) => !isExpired(e, now) && entryMatches(e, f) && (used.add(i), true));
    if (idx >= 0) ignored.push({ finding: f, reason: (list.entries[idx] as IgnoreEntry).reason, entry: describeEntry(list.entries[idx] as IgnoreEntry) });
    else kept.push(f);
  }
  const unused = list.entries.filter((e, i) => !used.has(i) && !isExpired(e, now)).map(describeEntry);
  return { findings: kept, ignored, unused, expired, source };
}

const canon = (e: IgnoreEntry): string => JSON.stringify(Object.keys(e).sort().map((k) => [k, (e as unknown as Record<string, string>)[k]]));

/** Findings about changes to the allow-list itself. They are never suppressible: they are added after the allow-list ran. */
export function allowlistChangeFindings(base: Snapshot, head: Snapshot): Finding[] {
  const b = base.read(ALLOWLIST_FILE);
  const h = head.read(ALLOWLIST_FILE);
  if (h === null || h === b) return [];
  const mk = (rule: string, severity: Finding['severity'], message: string): Finding => ({ rule, severity, category: 'config', file: ALLOWLIST_FILE, message, side: 'head' });
  const ph = parseAllowlist(h);
  if (!ph.ok) return [mk('allowlist-invalid', 'medium', `the allow-list is invalid (${ph.error}); it is ignored until fixed`)];
  const pb = b === null ? undefined : parseAllowlist(b);
  const before = new Set(pb?.ok ? pb.allowlist.entries.map(canon) : []);
  const out: Finding[] = [];
  for (const e of ph.allowlist.entries) {
    if (before.has(canon(e))) continue;
    const broad = e.rule.includes('*') || (e.file === undefined && e.server === undefined && e.contains === undefined);
    out.push(
      mk(
        'allowlist-entry-added',
        broad ? 'high' : 'medium',
        `new allow-list entry (${describeEntry(e)}): "${e.reason}". It does not apply to this change; once merged it will hide matching findings in later changes`,
      ),
    );
  }
  return out.sort((x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]);
}

/** Read the allow-list from the base snapshot. A broken one is reported, never half-applied. */
export function loadFromBase(base: Snapshot): { list?: Allowlist; error?: string } {
  const text = base.read(ALLOWLIST_FILE);
  if (text === null) return {};
  const p = parseAllowlist(text);
  return p.ok ? { list: p.allowlist } : { error: `${ALLOWLIST_FILE} in ${base.label} is invalid (${p.error}); no findings were ignored` };
}
