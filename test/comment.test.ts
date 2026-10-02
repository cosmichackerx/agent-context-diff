import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/comment-cli.js';
import { buildBody, COMMENT_MARKER, commentEligibility, MAX_COMMENT, upsertComment } from '../src/comment.js';
import { diffSnapshots } from '../src/diff.js';
import { renderMarkdown } from '../src/report.js';
import { FAKE_GH_TOKEN, mem } from './helpers.js';

async function fakeGithub(opts: { deny?: boolean } = {}) {
  const comments: { id: number; body: string }[] = [];
  const log: string[] = [];
  let next = 1;
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    log.push(`${req.method} ${req.url}`);
    const json = (code: number, v: unknown): void => void res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (opts.deny) return json(403, { message: 'Resource not accessible by integration' });
    if (req.headers.authorization !== 'Bearer tkn') return json(401, {});
    const list = /^\/repos\/o\/r\/issues\/7\/comments/.exec(req.url ?? '');
    const one = /^\/repos\/o\/r\/issues\/comments\/(\d+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && list) return json(200, comments);
    if (req.method === 'POST' && list) {
      const c = { id: next++, body: (JSON.parse(raw) as { body: string }).body };
      comments.push(c);
      return json(201, c);
    }
    if (req.method === 'PATCH' && one) {
      const c = comments.find((x) => x.id === Number(one[1]));
      if (!c) return json(404, {});
      c.body = (JSON.parse(raw) as { body: string }).body;
      return json(200, c);
    }
    return json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, comments, log, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('sticky comment: created once, then updated in place, then left alone when nothing changed', async () => {
  const gh = await fakeGithub();
  try {
    const t = { apiUrl: gh.url, token: 'tkn', repo: 'o/r', pr: 7 };
    gh.comments.push({ id: 100, body: 'someone else' });
    assert.deepEqual(await upsertComment(t, '## one'), { action: 'created', id: 1 });
    assert.deepEqual(await upsertComment(t, '## two'), { action: 'updated', id: 1 });
    assert.deepEqual(await upsertComment(t, '## two'), { action: 'unchanged', id: 1 });
    assert.equal(gh.comments.length, 2, 'exactly one comment of ours');
    assert.equal(gh.comments[0]?.body, 'someone else', 'other comments are untouched');
    assert.equal(gh.comments[1]?.body, `${COMMENT_MARKER}\n## two\n`);
  } finally {
    await gh.close();
  }
});

test('sticky comment: a token without permission is a skip with advice, not an error', async () => {
  const gh = await fakeGithub({ deny: true });
  try {
    const out = await upsertComment({ apiUrl: gh.url, token: 'tkn', repo: 'o/r', pr: 7 }, 'x');
    assert.equal(out.action, 'skipped');
    assert.match((out as { reason: string }).reason, /pull-requests: write/);
  } finally {
    await gh.close();
  }
});

test('sticky comment: never for forks or non pull request events; long reports are truncated', () => {
  assert.deepEqual(commentEligibility({ pull_request: { number: 3, head: { repo: { full_name: 'o/r' } } } }, 'O/R'), { pr: 3 });
  assert.match((commentEligibility({ pull_request: { number: 3, head: { repo: { full_name: 'fork/r' } } } }, 'o/r') as { skip: string }).skip, /fork/);
  assert.match((commentEligibility({ pull_request: { number: 3, head: { repo: null } } }, 'o/r') as { skip: string }).skip, /fork/);
  assert.match((commentEligibility({ push: {} }, 'o/r') as { skip: string }).skip, /not a pull request/);
  const body = buildBody('x'.repeat(MAX_COMMENT + 500));
  assert.ok(body.length < 65536 && body.includes('truncated') && body.startsWith(COMMENT_MARKER));
});

test('sticky comment: the report in the comment never contains secret values', () => {
  const r = diffSnapshots(
    mem({ '.mcp.json': '{"mcpServers":{}}' }),
    mem({ '.mcp.json': JSON.stringify({ mcpServers: { x: { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: FAKE_GH_TOKEN } } } }) }),
  );
  const body = buildBody(renderMarkdown(r));
  assert.ok(!body.includes(FAKE_GH_TOKEN));
  assert.match(body, /mcp-server-added|x/);
});

test('comment-cli: end to end against a fake API, skipping forks without any request', async () => {
  const gh = await fakeGithub();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'acd-comment-'));
    const md = join(dir, 'report.md');
    writeFileSync(md, '## report\n');
    const ev = (head: string): string => {
      const p = join(dir, `event-${head.replace('/', '_')}.json`);
      writeFileSync(p, JSON.stringify({ pull_request: { number: 7, head: { repo: { full_name: head } } } }));
      return p;
    };
    const lines: string[] = [];
    const env = (event: string): NodeJS.ProcessEnv => ({ GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'tkn', GITHUB_EVENT_PATH: event, GITHUB_API_URL: gh.url });
    assert.equal(await main([md], env(ev('someone/fork')), (s) => lines.push(s)), 0);
    assert.match(lines.join('\n'), /pull request from a fork/);
    assert.equal(gh.log.length, 0);
    assert.equal(await main([md], env(ev('o/r')), (s) => lines.push(s)), 0);
    assert.equal(await main([md], env(ev('o/r')), (s) => lines.push(s)), 0);
    assert.match(lines.join('\n'), /sticky comment created \(#1\)/);
    assert.match(lines.join('\n'), /sticky comment unchanged \(#1\)/);
    assert.equal(gh.comments.length, 1);
    assert.equal(await main([], {}, () => undefined), 2);
  } finally {
    await gh.close();
  }
});
