import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { ALLOWLIST_FILE, globToRegExp, parseAllowlist } from '../src/allowlist.js';
import { run } from '../src/cli.js';
import { diffSnapshots } from '../src/diff.js';
import { renderJson, renderMarkdown, renderSarif, renderText } from '../src/report.js';
import { TestRepo, mem } from './helpers.js';

const GH = JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github@1.2.3'] } } });
const FS = JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '/tmp'] } } });
const both = JSON.stringify({ mcpServers: { ...JSON.parse(GH).mcpServers, ...JSON.parse(FS).mcpServers } });
const allow = (...ignore: object[]): string => JSON.stringify({ ignore });
const rules = (r: { findings: { rule: string }[] }): string[] => r.findings.map((f) => f.rule);

test('allow-list from the base ref hides the matching finding and records the reason', () => {
  const base = mem({ [ALLOWLIST_FILE]: allow({ rule: 'mcp-server-added', server: 'github', reason: 'approved in SEC-12' }), '.mcp.json': '{}' });
  const head = mem({ [ALLOWLIST_FILE]: allow({ rule: 'mcp-server-added', server: 'github', reason: 'approved in SEC-12' }), '.mcp.json': both });
  const r = diffSnapshots(base, head);
  assert.ok(!r.findings.some((f) => f.rule === 'mcp-server-added' && f.message.includes("'github'")), 'github server hidden');
  assert.ok(r.findings.some((f) => f.rule === 'mcp-server-added' && f.message.includes("'files'")), 'other server still reported');
  assert.equal(r.ignored?.length, 1);
  assert.equal(r.ignored?.[0]?.reason, 'approved in SEC-12');
  assert.equal(r.allowlist?.source, 'base');
});

test('a change cannot silence its own findings: entries added in the head do not apply and are reported', () => {
  const base = mem({ '.mcp.json': '{}' });
  const head = mem({ [ALLOWLIST_FILE]: allow({ rule: 'mcp-server-added', server: 'github', reason: 'trust me' }), '.mcp.json': GH });
  const r = diffSnapshots(base, head);
  assert.ok(rules(r).includes('mcp-server-added'), 'finding is still reported');
  assert.ok(rules(r).includes('allowlist-entry-added'), 'the new entry is reported');
  assert.equal(r.ignored?.length ?? 0, 0);
  assert.equal(r.allowlist?.source, 'none');
  assert.ok(r.files.some((f) => f.file === ALLOWLIST_FILE));
});

test('editing an existing entry (widening it) counts as a new entry', () => {
  const narrow = allow({ rule: 'mcp-server-added', server: 'github', reason: 'ok' });
  const wide = allow({ rule: 'mcp-server-added', reason: 'ok' });
  const r = diffSnapshots(mem({ [ALLOWLIST_FILE]: narrow, '.mcp.json': '{}' }), mem({ [ALLOWLIST_FILE]: wide, '.mcp.json': both }));
  const added = r.findings.filter((f) => f.rule === 'allowlist-entry-added');
  assert.equal(added.length, 1);
  assert.equal(added[0]?.severity, 'high', 'no file/server/contains narrowing = high');
  assert.equal(rules(r).filter((x) => x === 'mcp-server-added').length, 1, 'only the base entry (github) applies');
});

test('allow-list findings are never suppressible by the allow-list', () => {
  const entry = { rule: 'allowlist-*', file: '**', reason: 'meta' };
  const r = diffSnapshots(mem({ [ALLOWLIST_FILE]: allow(entry) }), mem({ [ALLOWLIST_FILE]: allow(entry, { rule: 'x', file: 'y', reason: 'z' }) }));
  assert.ok(rules(r).includes('allowlist-entry-added'));
});

test('a wildcard rule entry is high severity even when narrowed to a file', () => {
  const r = diffSnapshots(mem({ '.mcp.json': '{}' }), mem({ [ALLOWLIST_FILE]: allow({ rule: 'mcp-*', file: '.mcp.json', reason: 'ok' }), '.mcp.json': '{}' }));
  assert.equal(r.findings.find((f) => f.rule === 'allowlist-entry-added')?.severity, 'high');
});

test('validation: reason is mandatory, unknown keys and bare wildcards are rejected', () => {
  assert.equal(parseAllowlist(allow({ rule: 'a' })).ok, false);
  assert.equal(parseAllowlist(allow({ rule: 'a', reason: '  ' })).ok, false);
  assert.equal(parseAllowlist(allow({ rule: 'a', reason: 'r', servr: 'x' })).ok, false);
  assert.equal(parseAllowlist(allow({ rule: '*', reason: 'r' })).ok, false);
  assert.equal(parseAllowlist(allow({ rule: 'mcp-*', reason: 'r' })).ok, false);
  assert.equal(parseAllowlist(allow({ rule: 'mcp-*', file: '.mcp.json', reason: 'r' })).ok, true);
  assert.equal(parseAllowlist(allow({ rule: 'a', reason: 'r', expires: 'next week' })).ok, false);
  assert.equal(parseAllowlist('{ "ignore": [] // none yet\n}').ok, true, 'JSONC comments are allowed');
  assert.equal(parseAllowlist('[]').ok, false);
});

test('a broken allow-list on the base ref ignores nothing and says so', () => {
  const r = diffSnapshots(mem({ [ALLOWLIST_FILE]: '{ nope', '.mcp.json': '{}' }), mem({ [ALLOWLIST_FILE]: '{ nope', '.mcp.json': GH }));
  assert.ok(rules(r).includes('mcp-server-added'));
  assert.ok(rules(r).includes('allowlist-invalid'));
  assert.match(r.allowlist?.error ?? '', /invalid/);
});

test('expired entries stop applying and are listed; unused entries are listed', () => {
  const list = allow({ rule: 'mcp-server-added', server: 'github', reason: 'temporary', expires: '2026-01-31' }, { rule: 'hook-added', file: 'x.json', reason: 'stale' });
  const base = mem({ [ALLOWLIST_FILE]: list, '.mcp.json': '{}' });
  const head = mem({ [ALLOWLIST_FILE]: list, '.mcp.json': GH });
  const before = diffSnapshots(base, head, { now: new Date('2026-01-15T00:00:00Z') });
  assert.equal(before.ignored?.length, 1);
  assert.equal(before.allowlist?.unused.length, 1);
  const after = diffSnapshots(base, head, { now: new Date('2026-02-02T00:00:00Z') });
  assert.equal(after.ignored?.length, 0);
  assert.ok(rules(after).includes('mcp-server-added'));
  assert.equal(after.allowlist?.expired.length, 1);
});

test('matching: file globs, contains, rule globs and --no-allowlist', () => {
  assert.ok(globToRegExp('docs/**/*.md').test('docs/a/b/c.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'));
  assert.ok(globToRegExp('mcp-*').test('mcp-server-added'));
  const list = allow({ rule: 'mcp-*', file: '.mcp.json', contains: 'GITHUB', reason: 'ok' });
  const base = mem({ [ALLOWLIST_FILE]: list, '.mcp.json': '{}' });
  const head = mem({ [ALLOWLIST_FILE]: list, '.mcp.json': GH });
  assert.ok((diffSnapshots(base, head).ignored?.length ?? 0) >= 1, 'case-insensitive contains');
  assert.equal(diffSnapshots(base, head, { allowlist: false }).ignored, undefined);
});

test('reports show what was ignored and why; SARIF carries suppressions and still validates', () => {
  const list = allow({ rule: 'mcp-server-added', server: 'github', reason: 'approved in SEC-12' });
  const r = diffSnapshots(mem({ [ALLOWLIST_FILE]: list, '.mcp.json': '{}' }), mem({ [ALLOWLIST_FILE]: list, '.mcp.json': both }));
  assert.match(renderText(r, false), /accepted by the allow-list \(read from the base ref\)[\s\S]*approved in SEC-12/);
  assert.match(renderMarkdown(r), /<details><summary>Allow-list<\/summary>[\s\S]*approved in SEC-12/);
  const json = JSON.parse(renderJson(r)) as { ignored: { reason: string; ignoredBy: string }[] };
  assert.equal(json.ignored[0]?.reason, 'approved in SEC-12');
  const sarif = JSON.parse(renderSarif(r, '9.9.9')) as { runs: { results: { suppressions?: { kind: string; justification: string }[] }[] }[] };
  const suppressed = sarif.runs[0]?.results.filter((x) => x.suppressions) ?? [];
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0]?.suppressions?.[0]?.kind, 'external');
  assert.match(suppressed[0]?.suppressions?.[0]?.justification ?? '', /approved in SEC-12/);
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../test/fixtures/sarif-schema-2.1.0.json', import.meta.url)), 'utf8')) as object;
  const validate = new Ajv({ strict: false, validateFormats: false, allErrors: true }).compile(schema);
  assert.ok(validate(sarif), JSON.stringify(validate.errors));
});

test('CLI with git: base-ref allow-list passes the gate, PR-added one does not; --allowlist file works', () => {
  const repo = new TestRepo();
  try {
    repo.write('.mcp.json', '{}\n').commit('init');
    // 1) main gets an allow-list for the github server
    repo.git('checkout', '-q', '-b', 'setup');
    repo.write(ALLOWLIST_FILE, allow({ rule: 'mcp-server-added', server: 'github', reason: 'approved in SEC-12' }));
    repo.commit('add allow-list');
    repo.git('branch', '-f', 'main', 'setup');
    repo.git('checkout', '-q', 'main');
    // 2) a PR adds the approved server and a second, unapproved one
    repo.git('checkout', '-q', '-b', 'pr');
    repo.write('.mcp.json', both).commit('add servers');
    let out = '';
    let code = run(['-C', repo.dir, 'main...HEAD', '--fail-on', 'high', '--no-color'], (s) => (out += s), () => undefined);
    assert.equal(code, 1, out);
    assert.match(out, /files/);
    assert.match(out, /approved in SEC-12/);
    // 3) a PR that only adds the approved server passes the gate
    repo.git('checkout', '-q', 'main');
    repo.git('checkout', '-q', '-b', 'pr2');
    repo.write('.mcp.json', GH).commit('only github');
    out = '';
    code = run(['-C', repo.dir, 'main...HEAD', '--fail-on', 'high', '--no-color'], (s) => (out += s), () => undefined);
    assert.equal(code, 0, out);
    // 4) a PR that tries to approve its own server fails
    repo.git('checkout', '-q', 'main');
    repo.git('checkout', '-q', '-b', 'pr3');
    repo.write('.mcp.json', both).write(ALLOWLIST_FILE, allow({ rule: 'mcp-server-added', server: 'github', reason: 'ok' }, { rule: 'mcp-server-added', server: 'files', reason: 'self-approved' })).commit('self approve');
    out = '';
    code = run(['-C', repo.dir, 'main...HEAD', '--fail-on', 'high', '--no-color'], (s) => (out += s), () => undefined);
    assert.equal(code, 1, out);
    assert.match(out, /allowlist-entry-added/);
    // 5) explicit trusted file outside the repo
    const explicit = new TestRepo('acd allow ');
    try {
      explicit.write('trusted.json', allow({ rule: 'mcp-server-added', file: '.mcp.json', reason: 'org policy' }));
      out = '';
      code = run(['-C', repo.dir, 'main...HEAD', '--fail-on', 'high', '--no-color', '--allowlist', `${explicit.dir}/trusted.json`], (s) => (out += s), () => undefined);
      assert.equal(code, 0, out);
      assert.match(out, /from --allowlist/);
      assert.equal(run(['-C', repo.dir, '--allowlist', `${explicit.dir}/missing.json`], () => undefined, () => undefined), 2);
    } finally {
      explicit.cleanup();
    }
  } finally {
    repo.cleanup();
  }
});
