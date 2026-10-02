export type Severity = 'info' | 'low' | 'medium' | 'high';
export const SEVERITIES: readonly Severity[] = ['info', 'low', 'medium', 'high'];
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };

export type Category = 'instructions' | 'mcp' | 'permissions' | 'hooks' | 'config';

export interface Finding {
  /** Stable rule id, e.g. `mcp-server-added`. */
  rule: string;
  severity: Severity;
  category: Category;
  /** Repo-relative path using forward slashes. */
  file: string;
  message: string;
  /** 1-based line in the head (or, for removals, the base) version of the file when known. */
  line?: number;
  /** Which side `line` refers to. */
  side?: 'base' | 'head';
}

export type FileStatus = 'added' | 'removed' | 'modified';

export interface FileChange {
  file: string;
  status: FileStatus;
  kind: FileKind;
}

export type FileKind = 'instructions' | 'mcp-config' | 'claude-settings' | 'allowlist';

/** A read-only view of the files of a git ref (or of the working tree). */
export interface Snapshot {
  readonly label: string;
  listFiles(): string[];
  /** File contents (UTF-8, BOM stripped, CRLF normalised to LF) or `null` when absent/unreadable. */
  read(path: string): string | null;
}

/** A finding accepted by an allow-list entry. It does not count towards `--fail-on`. */
export interface IgnoredFinding {
  finding: Finding;
  reason: string;
  /** Human readable form of the matching entry. */
  entry: string;
}

export interface AllowlistInfo {
  /** `base`: read from the base ref (default). `file`: given with --allowlist. `none`. */
  source: 'base' | 'file' | 'none';
  /** Entries that matched nothing: candidates for removal. */
  unused: string[];
  expired: string[];
  /** Why an existing allow-list could not be used. */
  error?: string;
}

export interface DiffResult {
  base: string;
  head: string;
  files: FileChange[];
  findings: Finding[];
  ignored?: IgnoredFinding[];
  allowlist?: AllowlistInfo;
}
