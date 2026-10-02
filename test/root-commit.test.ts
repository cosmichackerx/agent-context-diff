import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffSnapshots } from '../src/diff.js';
import { resolveRange } from '../src/git.js';
import { TestRepo } from './helpers.js';

test('the first commit of a repository can be reviewed with HEAD~1 / <sha>^ (diffed against the empty tree)', () => {
  const repo = new TestRepo('acd root ');
  try {
    repo.write('AGENTS.md', '# Rules\n- Never push to main.\n').write('.mcp.json', '{"mcpServers":{"x":{"command":"npx","args":["-y","pkg"]}}}');
    const first = repo.commit('first');
    for (const base of ['HEAD~1', `${first}^`, 'HEAD^']) {
      const range = resolveRange({ cwd: repo.dir, positional: [base, 'HEAD'] });
      assert.match(range.base.label, /empty tree/);
      const res = diffSnapshots(range.base, range.head);
      assert.deepEqual(res.files.map((f) => f.status), ['added', 'added']);
      assert.ok(res.findings.some((f) => f.rule === 'mcp-server-added'));
    }
    // three-dot works as well, and later commits still resolve normally
    const three = resolveRange({ cwd: repo.dir, positional: ['HEAD~1...HEAD'] });
    assert.equal(diffSnapshots(three.base, three.head).files.length, 2);
    repo.write('AGENTS.md', '# Rules\n').commit('second');
    const second = resolveRange({ cwd: repo.dir, positional: ['HEAD~1', 'HEAD'] });
    assert.doesNotMatch(second.base.label, /empty tree/);
    assert.throws(() => resolveRange({ cwd: repo.dir, positional: ['HEAD~5', 'HEAD'] }), /unknown git ref/);
  } finally {
    repo.cleanup();
  }
});
