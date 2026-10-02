// Runs every compiled *.test.js with the built-in node:test runner (portable across Node 20/22/24 and OSes).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dir = join('dist', 'test');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => join(dir, f));
if (files.length === 0) {
  console.error('no test files found in', dir);
  process.exit(1);
}
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
