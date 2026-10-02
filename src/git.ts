import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from './types.js';

const MAX_FILE_BYTES = 1_000_000;

export class UsageError extends Error {}

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message: string; code?: string };
    if (e.code === 'ENOENT') throw new UsageError('git was not found on PATH');
    const stderr = (e.stderr ? e.stderr.toString() : e.message).trim();
    throw new GitError(stderr || e.message);
  }
}

export class GitError extends Error {}

export function repoRoot(cwd: string): string {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new UsageError(`not a git repository: ${cwd}`);
  }
}

function clean(raw: string): string {
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return noBom.replace(/\r\n/g, '\n');
}

export function resolveCommit(root: string, ref: string): string {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
  } catch {
    throw new UsageError(`unknown git ref: ${ref}`);
  }
}

class RefSnapshot implements Snapshot {
  private files: string[] | undefined;
  constructor(
    private readonly root: string,
    private readonly sha: string,
    readonly label: string,
  ) {}

  listFiles(): string[] {
    if (!this.files) {
      const out = git(this.root, ['ls-tree', '-r', '-z', '--full-tree', this.sha]);
      this.files = out
        .split('\0')
        .filter(Boolean)
        .map((entry) => /^(\d+) (\w+) (\w+)\t([\s\S]*)$/.exec(entry))
        .filter((m): m is RegExpExecArray => m !== null && m[2] === 'blob' && m[1] !== '120000')
        .map((m) => m[4] as string);
    }
    return this.files;
  }

  read(path: string): string | null {
    try {
      const size = Number(git(this.root, ['cat-file', '-s', `${this.sha}:${path}`]).trim());
      if (size > MAX_FILE_BYTES) return null;
      return clean(git(this.root, ['show', `${this.sha}:${path}`]));
    } catch {
      return null;
    }
  }
}

class WorktreeSnapshot implements Snapshot {
  readonly label = 'working tree';
  private files: string[] | undefined;
  constructor(private readonly root: string) {}

  listFiles(): string[] {
    if (!this.files) {
      const out = git(this.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
      const set = new Set(out.split('\0').filter(Boolean));
      this.files = [...set].filter((p) => existsSync(join(this.root, p)));
    }
    return this.files;
  }

  read(path: string): string | null {
    try {
      const full = join(this.root, path);
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      return clean(readFileSync(full, 'utf8'));
    } catch {
      return null;
    }
  }
}

export interface Range {
  root: string;
  base: Snapshot;
  head: Snapshot;
}

export interface RangeInput {
  cwd: string;
  /** `a`, `a..b` or `a...b` (merge-base); optional second positional is the head. */
  positional: string[];
  base?: string;
  head?: string;
}

const WORKTREE_NAMES = new Set(['worktree', '@worktree', 'working-tree', 'WORKTREE']);

export function resolveRange(input: RangeInput): Range {
  const root = repoRoot(input.cwd);
  let baseRef = input.base;
  let headRef = input.head;
  let threeDot = false;

  const [first, second] = input.positional;
  if (first !== undefined) {
    const m3 = /^(.*)\.\.\.(.*)$/.exec(first);
    const m2 = /^(.*)\.\.(.*)$/.exec(first);
    if (m3) {
      baseRef = m3[1] || 'HEAD';
      headRef = m3[2] || 'HEAD';
      threeDot = true;
    } else if (m2) {
      baseRef = m2[1] || 'HEAD';
      headRef = m2[2] || 'HEAD';
    } else {
      baseRef = baseRef ?? first;
      headRef = headRef ?? second;
    }
  }
  baseRef = baseRef ?? 'HEAD';

  const baseSha = resolveCommit(root, baseRef);
  let baseLabel = baseRef;
  let effectiveBase = baseSha;
  const headIsWorktree = headRef === undefined || WORKTREE_NAMES.has(headRef);
  const headSha = headIsWorktree ? undefined : resolveCommit(root, headRef as string);

  if (threeDot) {
    const target = headSha ?? resolveCommit(root, 'HEAD');
    try {
      effectiveBase = git(root, ['merge-base', baseSha, target]).trim();
      baseLabel = `${baseRef} (merge-base ${effectiveBase.slice(0, 7)})`;
    } catch {
      throw new UsageError(`no merge base between ${baseRef} and ${headRef}`);
    }
  }
  const base = new RefSnapshot(root, effectiveBase, baseLabel);
  const head = headSha
    ? new RefSnapshot(root, headSha, headRef as string)
    : new WorktreeSnapshot(root);
  return { root, base, head };
}
