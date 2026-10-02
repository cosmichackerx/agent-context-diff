import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowSeverity } from '../src/claude.js';
import { classify } from '../src/discover.js';
import { parseJsonc, stripJsonc } from '../src/jsonc.js';
import { diffLines, hiddenCodePoints, parseMarkdown } from '../src/markdown.js';
import { extractServers, packageSpec, normalizeServer } from '../src/mcp.js';
import { isLiteralSecret, isPlaceholder, redactArg, redactUrl } from '../src/secrets.js';
import { FAKE_GH_TOKEN } from './helpers.js';

test('jsonc: comments, trailing commas and // inside strings', () => {
  const r = parseJsonc(`{
    // line comment
    "url": "https://example.com/a//b", /* block */
    "list": [1, 2, 3,],
    "obj": {"a": "x,}",},
  }`);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { url: 'https://example.com/a//b', list: [1, 2, 3], obj: { a: 'x,}' } });
  assert.equal(parseJsonc('{ nope').ok, false);
  assert.equal(stripJsonc('"a\\"//b"'), '"a\\"//b"');
});

test('classify recognises agent files and ignores node_modules', () => {
  const k = (p: string): string | null => classify(p);
  assert.equal(k('AGENTS.md'), 'instructions');
  assert.equal(k('packages/web/CLAUDE.md'), 'instructions');
  assert.equal(k('.cursor/rules/style.mdc'), 'instructions');
  assert.equal(k('.github/copilot-instructions.md'), 'instructions');
  assert.equal(k('.claude/skills/pdf/SKILL.md'), 'instructions');
  assert.equal(k('.mcp.json'), 'mcp-config');
  assert.equal(k('tools/.mcp.json'), 'mcp-config');
  assert.equal(k('.vscode/mcp.json'), 'mcp-config');
  assert.equal(k('opencode.jsonc'), 'mcp-config');
  assert.equal(k('.claude/settings.json'), 'claude-settings');
  assert.equal(k('.claude/settings.local.json'), 'claude-settings');
  assert.equal(k('node_modules/pkg/AGENTS.md'), null);
  assert.equal(k('README.md'), null);
  assert.equal(k('docs/agents.md'), null);
});

test('secrets: placeholders vs literals', () => {
  assert.ok(isPlaceholder('${GITHUB_TOKEN}'));
  assert.ok(isPlaceholder('$TOKEN'));
  assert.ok(isPlaceholder('Bearer ${TOKEN}'));
  assert.ok(isPlaceholder('{env:API_KEY}'));
  assert.ok(isPlaceholder('<your-key>'));
  assert.ok(isPlaceholder(''));
  assert.equal(isLiteralSecret('GITHUB_TOKEN', '${GITHUB_TOKEN}'), false);
  assert.equal(isLiteralSecret('GITHUB_TOKEN', FAKE_GH_TOKEN), true);
  assert.equal(isLiteralSecret('API_KEY', 'abcdef123456'), true);
  assert.equal(isLiteralSecret('LOG_LEVEL', 'debug'), false);
  assert.equal(isLiteralSecret('PATH_TO_TOKENS', 'x'), false); // too short to be a secret
  assert.ok(!redactUrl('https://u:pw@example.com/x?api_key=abc&q=1').includes('pw'));
  assert.ok(redactUrl('https://example.com/x?token=abcdefgh&q=1').includes('q=1'));
  assert.equal(redactArg('--token=supersecret123'), '--token=[redacted 14 chars]');
  assert.equal(redactArg('--port=8080'), '--port=8080');
  assert.ok(!redactArg(FAKE_GH_TOKEN).includes('ghp_'));
});

test('markdown: sections respect fences, duplicates and frontmatter', () => {
  const p = parseMarkdown(['---', 'alwaysApply: true', 'globs: "**/*.ts"', '---', '# A', 'x', '```sh', '# not a heading', '```', '## B', 'y', '## B', 'z'].join('\n'));
  assert.deepEqual(p.frontmatter, { alwaysApply: 'true', globs: '"**/*.ts"' });
  assert.deepEqual(p.sections.map((s) => s.key), ['(top)', 'A', 'A > B', 'A > B (#2)']);
  assert.equal(p.sections[1]?.lines.some((l) => l.text === '# not a heading'), true);
});

test('diffLines ignores whitespace-only changes and reports real ones', () => {
  const a = ['one', 'two', 'three'].map((text, i) => ({ text, line: i + 1 }));
  const b = ['one', '  two ', 'four', 'three'].map((text, i) => ({ text, line: i + 1 }));
  const d = diffLines(a, b);
  assert.deepEqual(d.added.map((l) => l.text), ['four']);
  assert.deepEqual(d.removed, []);
});

test('hiddenCodePoints detects zero-width, bidi and tag characters', () => {
  assert.deepEqual(hiddenCodePoints('a\u200Bb'), ['U+200B']);
  assert.deepEqual(hiddenCodePoints('x\u202Ey'), ['U+202E']);
  assert.deepEqual(hiddenCodePoints(`t${String.fromCodePoint(0xe0041)}`), ['U+E0041']);
  assert.deepEqual(hiddenCodePoints('plain ascii and ünïcödé ✓'), []);
});

test('mcp: server shapes (claude/vscode/opencode/zed)', () => {
  const claude = extractServers({ mcpServers: { a: { command: 'npx', args: ['-y', 'pkg@1.0.0'], env: { K: 'v' } } } });
  assert.equal(claude.get('a')?.transport, 'stdio');
  const vscode = extractServers({ servers: { r: { type: 'http', url: 'https://x.example/mcp', headers: { A: 'b' } } } });
  assert.equal(vscode.get('r')?.url, 'https://x.example/mcp');
  const opencode = extractServers({ mcp: { l: { type: 'local', command: ['npx', '-y', 'pkg@2.0.0'], environment: { E: '1' } }, r: { type: 'remote', url: 'https://x.example' } } });
  assert.equal(opencode.get('l')?.command, 'npx');
  assert.deepEqual(opencode.get('l')?.args, ['-y', 'pkg@2.0.0']);
  assert.equal(opencode.get('l')?.env.E, '1');
  assert.equal(opencode.get('r')?.transport, 'http');
  const zed = extractServers({ context_servers: { z: { command: { path: 'uvx', args: ['tool==1.2'], env: { Z: '1' } } } } });
  assert.equal(zed.get('z')?.command, 'uvx');
  assert.deepEqual(extractServers({ mcp: 'not an object' }).size, 0);
  assert.deepEqual(extractServers(null).size, 0);
  assert.deepEqual(extractServers({ mcpServers: { bad: 'string' } }).size, 0);
});

test('mcp: package pinning heuristics', () => {
  const spec = (command: string, args: string[]) => packageSpec(normalizeServer('s', { command, args }));
  assert.deepEqual(spec('npx', ['-y', '@scope/pkg@1.2.3']), { spec: '@scope/pkg@1.2.3', pinned: true });
  assert.equal(spec('npx', ['-y', '@scope/pkg'])?.pinned, false);
  assert.equal(spec('npx', ['-y', 'pkg@latest'])?.pinned, false);
  assert.equal(spec('npx.cmd', ['pkg@2'])?.pinned, true);
  assert.equal(spec('C:\\Program Files\\nodejs\\npx.cmd', ['pkg']) ?.pinned, false);
  assert.equal(spec('pnpm', ['dlx', 'pkg@3.0.0'])?.pinned, true);
  assert.equal(spec('uvx', ['mcp-server-git==0.6.2'])?.pinned, true);
  assert.equal(spec('uvx', ['mcp-server-git'])?.pinned, false);
  assert.equal(spec('uvx', ['--from', 'pkg==1.0', 'tool'])?.spec, 'pkg==1.0');
  assert.equal(spec('docker', ['run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/org/img:1.2.3'])?.pinned, true);
  assert.equal(spec('docker', ['run', '-i', '--rm', 'ghcr.io/org/img'])?.pinned, false);
  assert.equal(spec('docker', ['run', 'img:latest'])?.pinned, false);
  assert.equal(spec('docker', ['run', 'img@sha256:abc'])?.pinned, true);
  assert.equal(spec('node', ['server.js']), null);
  assert.equal(spec('python', ['-m', 'srv']), null);
});

test('claude: allow rule severity', () => {
  assert.equal(allowSeverity('Bash'), 'high');
  assert.equal(allowSeverity('Bash(*)'), 'high');
  assert.equal(allowSeverity('Bash(curl:*)'), 'high');
  assert.equal(allowSeverity('Bash(npm install:*)'), 'high');
  assert.equal(allowSeverity('Write'), 'high');
  assert.equal(allowSeverity('Read(./src/**)'), 'low');
  assert.equal(allowSeverity('Bash(git status)'), 'low');
  assert.equal(allowSeverity('Bash(npm run test:*)'), 'low');
  assert.equal(allowSeverity('Bash(npx tsc:*)'), 'low');
  assert.equal(allowSeverity('Bash(grep:*)'), 'low');
  assert.equal(allowSeverity('Bash(gh pr view:*)'), 'low');
  assert.equal(allowSeverity('WebSearch'), 'low');
  assert.equal(allowSeverity('WebFetch(domain:github.com)'), 'low');
  assert.equal(allowSeverity('WebFetch'), 'high');
  assert.equal(allowSeverity('Bash(make:*)'), 'medium');
  assert.equal(allowSeverity('Bash(uv run:*)'), 'medium');
  assert.equal(allowSeverity('Bash(python3:*)'), 'high');
  assert.equal(allowSeverity('mcp__github'), 'medium');
});
