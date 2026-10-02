import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffSnapshots, importsFile } from '../src/diff.js';
import { mem } from './helpers.js';

const run = (before: Record<string, string>, after: Record<string, string>, checkDivergence = true) =>
  diffSnapshots(mem(before), mem(after), { checkDivergence }).findings.filter((f) => f.rule === 'ctx-files-diverge');

test('importsFile recognises @AGENTS.md import forms', () => {
  assert.equal(importsFile('@AGENTS.md\n', 'AGENTS.md'), true);
  assert.equal(importsFile('# Claude\n\n@./AGENTS.md\n\n## Claude only\n- be brief\n', 'AGENTS.md'), true);
  assert.equal(importsFile('See @AGENTS.md\n', 'AGENTS.md'), true);
  assert.equal(importsFile('- @AGENTS.md\r\n'.replace('\r', ''), 'AGENTS.md'), true);
  assert.equal(importsFile('Read AGENTS.md for details\n', 'AGENTS.md'), false);
  assert.equal(importsFile('email me@AGENTS.md.example\n', 'AGENTS.md'), false);
});

test('divergence: off by default', () => {
  assert.equal(run({}, { 'AGENTS.md': '# A\n- one\n', 'CLAUDE.md': '# A\n- two\n' }, false).length, 0);
});

test('divergence: CLAUDE.md that only imports @AGENTS.md is fine, with or without extras', () => {
  assert.equal(run({ 'AGENTS.md': '# A\n- one\n' }, { 'AGENTS.md': '# A\n- one\n- two\n', 'CLAUDE.md': '@AGENTS.md\n' }).length, 0);
  assert.equal(run({}, { 'AGENTS.md': '# A\n- one\n', 'CLAUDE.md': '@AGENTS.md\n\n## Claude\n- use plan mode\n' }).length, 0);
});

test('divergence: updating one file but not the other is low severity and counts the differing lines', () => {
  const same = '# Rules\n- Never push to main.\n- Run tests.\n';
  const r = run({ 'AGENTS.md': same, 'CLAUDE.md': same }, { 'AGENTS.md': `${same}- Use pnpm.\n`, 'CLAUDE.md': same });
  assert.equal(r.length, 1);
  assert.equal(r[0]?.severity, 'low');
  assert.equal(r[0]?.file, 'CLAUDE.md');
  assert.match(r[0]?.message ?? '', /1 line\(s\) only in AGENTS\.md, 0 only in CLAUDE\.md/);
  assert.match(r[0]?.message ?? '', /touched AGENTS\.md\b/);
});

test('divergence: identical content, unrelated changes and formatting-only differences are quiet', () => {
  const same = '# Rules\n- Run tests.\n';
  assert.equal(run({}, { 'AGENTS.md': same, 'CLAUDE.md': same }).length, 0);
  assert.equal(run({}, { 'AGENTS.md': same, 'CLAUDE.md': '# Rules\n-   Run tests.   \n\n' }).length, 0);
  // differing pair that this change did not touch is not reported
  const files = { 'AGENTS.md': '# A\n- one\n', 'CLAUDE.md': '# A\n- two\n', 'docs/AGENTS.md': 'x\n' };
  assert.equal(run(files, { ...files, 'docs/AGENTS.md': 'y\n' }).length, 0);
});

test('divergence: works per directory', () => {
  const r = run({}, { 'pkg/a/AGENTS.md': '# A\n- one\n', 'pkg/a/CLAUDE.md': '# A\n- two\n', 'pkg/b/AGENTS.md': '# B\n', 'pkg/b/CLAUDE.md': '# B\n' });
  assert.equal(r.length, 1);
  assert.equal(r[0]?.file, 'pkg/a/CLAUDE.md');
  assert.match(r[0]?.message ?? '', /^pkg\/a\/AGENTS\.md and CLAUDE\.md differ/);
});

test('divergence: --check-divergence flag on a real repository', async () => {
  const { TestRepo } = await import('./helpers.js');
  const { run } = await import('../src/cli.js');
  const repo = new TestRepo('acd div ');
  try {
    repo.write('AGENTS.md', '# R\n- one\n').write('CLAUDE.md', '# R\n- one\n');
    repo.commit('base');
    repo.write('AGENTS.md', '# R\n- one\n- two\n');
    repo.commit('update agents only');
    const go = (extra: string[]): string => {
      let out = '';
      run(['-C', repo.dir, 'HEAD~1', 'HEAD', '--format', 'json', ...extra], (s) => (out += s), () => undefined);
      return out;
    };
    assert.ok(!go([]).includes('ctx-files-diverge'));
    assert.ok(go(['--check-divergence']).includes('ctx-files-diverge'));
    let help = '';
    run(['--list-rules'], (s) => (help += s), () => undefined);
    assert.ok(help.includes('ctx-files-diverge'));
  } finally {
    repo.cleanup();
  }
});
