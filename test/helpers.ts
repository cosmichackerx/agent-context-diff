import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Snapshot } from '../src/types.js';

export class TestRepo {
  readonly dir: string;
  constructor(prefix = 'acd test ') {
    // spaces in the path on purpose: must work on every OS
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    this.git('init', '-q', '-b', 'main');
  }

  git(...args: string[]): string {
    return execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args],
      { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }

  write(path: string, content: string | Buffer): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return this;
  }

  remove(path: string): this {
    rmSync(join(this.dir, path), { force: true });
    return this;
  }

  commit(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** In-memory snapshot for unit tests. */
export function mem(files: Record<string, string>, label = 'mem'): Snapshot {
  return {
    label,
    listFiles: () => Object.keys(files),
    read: (p) => (p in files ? (files[p] as string) : null),
  };
}

export const FAKE_GH_TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`;
