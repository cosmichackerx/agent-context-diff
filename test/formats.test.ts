import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../src/discover.js';
import { diffSnapshots } from '../src/diff.js';
import { parseToml } from '../src/toml.js';
import { parseYaml } from '../src/yamlmini.js';
import { FAKE_GH_TOKEN, mem } from './helpers.js';

const diff = (before: Record<string, string>, after: Record<string, string>) => diffSnapshots(mem(before), mem(after));
const rules = (r: ReturnType<typeof diff>): string[] => r.findings.map((f) => f.rule).sort();

// ---------------------------------------------------------------------------------------------- TOML

test('toml: tables, dotted keys, arrays of tables, inline tables and every string flavour', () => {
  const v = parseToml(
    [
      '# comment',
      'title = "a \\"b\\" \\u00e9" # trailing',
      "lit = 'C:\\path'",
      'n = 1_000',
      'f = 1.5e2',
      'on = true',
      'when = 2026-10-02T10:00:00Z',
      'arr = [',
      '  "x", # first',
      '  "y",',
      ']',
      'inline = { a = 1, b.c = "d" }',
      'multi = """',
      'line1',
      'line2"""',
      'raw = \'\'\'no \\escape\'\'\'',
      'a.b.c = 1',
      '[tbl]',
      'k = "v"',
      '[tbl.sub]',
      '"quoted key" = 2',
      '[[items]]',
      'name = "one"',
      '[[items]]',
      'name = "two"',
    ].join('\r\n'),
  ) as Record<string, any>;
  assert.equal(v.title, 'a "b" é');
  assert.equal(v.lit, 'C:\\path');
  assert.equal(v.n, 1000);
  assert.equal(v.f, 150);
  assert.equal(v.on, true);
  assert.equal(v.when, '2026-10-02T10:00:00Z');
  assert.deepEqual(v.arr, ['x', 'y']);
  assert.deepEqual(v.inline, { a: 1, b: { c: 'd' } });
  assert.equal(v.multi, 'line1\nline2');
  assert.equal(v.raw, 'no \\escape');
  assert.deepEqual(v.a, { b: { c: 1 } });
  assert.deepEqual(v.tbl, { k: 'v', sub: { 'quoted key': 2 } });
  assert.deepEqual(v.items, [{ name: 'one' }, { name: 'two' }]);
});

test('toml: errors name the line and duplicate keys are rejected', () => {
  assert.throws(() => parseToml('a = 1\nb = \n'), /line 2/);
  assert.throws(() => parseToml('a = 1\na = 2\n'), /duplicate key 'a'/);
  assert.throws(() => parseToml('[t\nx = 1'), /unterminated table header/);
  assert.throws(() => parseToml('s = "open'), /unterminated string/);
  assert.throws(() => parseToml('x = nope'), /unsupported value 'nope'/);
});

const CODEX_BASE = ['model = "gpt-5"', '', '[mcp_servers.docs]', 'command = "npx"', 'args = ["-y", "docs-mcp@1.2.3"]', '[mcp_servers.docs.env]', 'LEVEL = "info"', ''].join('\n');

test('codex config.toml: a new MCP server is found like in the JSON formats', () => {
  assert.equal(classify('.codex/config.toml'), 'codex-config');
  const r = diff(
    { '.codex/config.toml': CODEX_BASE },
    {
      '.codex/config.toml':
        CODEX_BASE + ['[mcp_servers.shell]', 'command = "npx"', 'args = ["-y", "some-new-server"]', '[mcp_servers.shell.env]', `API_TOKEN = "${FAKE_GH_TOKEN}"`, ''].join('\r\n'),
    },
  );
  const added = r.findings.find((f) => f.rule === 'mcp-server-added');
  assert.ok(added, JSON.stringify(rules(r)));
  assert.match(added.message, /shell/);
  assert.ok(!JSON.stringify(r).includes(FAKE_GH_TOKEN), 'secrets are redacted');
  assert.ok(r.findings.some((f) => f.rule.startsWith('mcp-') && /literal|secret/i.test(f.message)), 'a literal secret in env is reported');
});

test('codex config.toml: widened approvals, sandbox, network, trusted projects', () => {
  const r = diff(
    { '.codex/config.toml': 'approval_policy = "on-request"\nsandbox_mode = "read-only"\n' },
    {
      '.codex/config.toml': [
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        '[sandbox_workspace_write]',
        'network_access = true',
        '[projects."/work/app"]',
        'trust_level = "trusted"',
        '[shell_environment_policy]',
        'inherit = "all"',
      ].join('\n'),
    },
  );
  assert.deepEqual(rules(r), ['codex-approval-widened', 'codex-env-inherit-all', 'codex-network-enabled', 'codex-project-trusted', 'codex-sandbox-widened']);
  assert.equal(r.findings.find((f) => f.rule === 'codex-approval-widened')?.severity, 'high');
  assert.equal(r.findings.find((f) => f.rule === 'codex-sandbox-widened')?.severity, 'high');
});

test('codex config.toml: tightening is not reported, and invalid TOML is flagged', () => {
  const tighter = diff({ '.codex/config.toml': 'approval_policy = "never"\n' }, { '.codex/config.toml': 'approval_policy = "untrusted"\n' });
  assert.deepEqual(tighter.findings, []);
  const bad = diff({ '.codex/config.toml': 'a = 1\n' }, { '.codex/config.toml': 'a = \n' });
  assert.equal(bad.findings[0]?.rule, 'config-unparsable');
  assert.match(bad.findings[0]?.message ?? '', /not valid TOML.*line 1/);
});

// ---------------------------------------------------------------------------------------------- YAML

test('yaml: block mappings, sequences of mappings, flow collections, block scalars, comments', () => {
  const v = parseYaml(
    [
      '---',
      'name: "demo" # comment',
      "version: '1.0.0'",
      'on: true',
      'count: 3',
      'empty:',
      'flow: [a, "b c", 3, {x: 1, y: [1, 2]}]',
      'map: {k: v}',
      'text: |',
      '  line one',
      '',
      '  line # three',
      'folded: >-',
      '  a',
      '  b',
      'list:',
      '- plain',
      '- key: 1',
      '  other: two',
      '-',
      '  nested: yes',
      'servers:',
      '  - name: files',
      '    command: npx',
      '    args:',
      '      - -y',
      '      - "@scope/pkg@1.0.0"',
      '    env:',
      '      TOKEN: abc',
      '  - name: web',
      '    url: https://example.com/mcp',
    ].join('\r\n'),
  ) as Record<string, any>;
  assert.equal(v.name, 'demo');
  assert.equal(v.version, '1.0.0');
  assert.equal(v.on, true);
  assert.equal(v.count, 3);
  assert.equal(v.empty, null);
  assert.deepEqual(v.flow, ['a', 'b c', 3, { x: 1, y: [1, 2] }]);
  assert.deepEqual(v.map, { k: 'v' });
  assert.equal(v.text, 'line one\n\nline # three\n');
  assert.equal(v.folded, 'a b');
  assert.deepEqual(v.list, ['plain', { key: 1, other: 'two' }, { nested: 'yes' }]);
  assert.deepEqual(v.servers, [
    { name: 'files', command: 'npx', args: ['-y', '@scope/pkg@1.0.0'], env: { TOKEN: 'abc' } },
    { name: 'web', url: 'https://example.com/mcp' },
  ]);
});

test('yaml: unsupported constructs fail loudly instead of being misread', () => {
  assert.throws(() => parseYaml('a: &x 1\nb: *x\n'), /anchors, aliases and tags/);
  assert.throws(() => parseYaml('a: 1\n---\nb: 2\n'), /multi-document/);
  assert.throws(() => parseYaml('a: 1\n\tb: 2\n'), /tabs/);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key/);
  assert.throws(() => parseYaml('a: first\n  second\n'), /multi-line plain scalars/);
  assert.throws(() => parseYaml('a: [1,\n 2]\n'), /multi-line flow/);
  assert.throws(() => parseYaml('<<: x\n'), /merge keys/);
});

const CONTINUE_BASE = ['name: Config', 'version: 1.0.0', 'schema: v1', 'mcpServers:', '  - name: docs', '    command: npx', '    args: ["-y", "docs-mcp@1.2.3"]', ''].join('\n');

test('continue config.yaml: a new MCP server in the mcpServers list is found', () => {
  assert.equal(classify('.continue/config.yaml'), 'mcp-config');
  assert.equal(classify('.continue/mcpServers/browser.yaml'), 'mcp-config');
  const r = diff(
    { '.continue/config.yaml': CONTINUE_BASE },
    { '.continue/config.yaml': `${CONTINUE_BASE}  - name: remote\n    url: https://mcp.example.com/sse\n  - name: runner\n    command: npx\n    args:\n      - -y\n      - evil-pkg\n` },
  );
  const added = r.findings.filter((f) => f.rule === 'mcp-server-added').map((f) => f.message);
  assert.equal(added.length, 2, added.join(' | '));
  assert.ok(added.some((m) => /remote/.test(m)) && added.some((m) => /runner/.test(m)));
});

test('continue .continue/mcpServers/*.yaml files and goose-style extensions parse as servers', () => {
  const r = diff({}, { '.continue/mcpServers/one.yaml': 'name: one\nmcpServers:\n  - name: one\n    command: uvx\n    args: [tool]\n' });
  assert.deepEqual(rules(r).filter((x) => x === 'mcp-server-added'), ['mcp-server-added']);
  const goose = diff({ '.continue/config.yaml': 'name: x\n' }, { '.continue/config.yaml': 'name: x\nmcpServers:\n  - name: g\n    cmd: npx\n    envs: {K: v}\n' });
  assert.ok(goose.findings.some((f) => f.rule === 'mcp-server-added'));
});

test('invalid or unsupported YAML is reported as config-unparsable, not silently ignored', () => {
  const r = diff({ '.continue/config.yaml': 'name: x\n' }, { '.continue/config.yaml': 'name: &a x\nmcpServers:\n  - *a\n' });
  assert.equal(r.findings[0]?.rule, 'config-unparsable');
  assert.match(r.findings[0]?.message ?? '', /not valid YAML/);
});

test('continue shapes seen in public repos: root mcpServers.yaml map form and `uses:` hub blocks', () => {
  assert.equal(classify('.continue/mcpServers.yaml'), 'mcp-config');
  const map = diff({}, { '.continue/mcpServers.yaml': '# generated\nmcpServers:\n  runner:\n    command: python\n    args:\n    - -m\n    - srv\n' });
  assert.ok(map.findings.some((f) => f.rule === 'mcp-server-added' && /runner/.test(f.message)));
  const hub = diff({}, { '.continue/mcpServers/docs.yaml': 'name: Docs\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - uses: continuedev/continue-docs-mcp\n' });
  assert.ok(hub.findings.some((f) => f.rule === 'mcp-server-added' && /continue-docs-mcp/.test(f.message)), JSON.stringify(hub.findings));
});
