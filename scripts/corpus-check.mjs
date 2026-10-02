#!/usr/bin/env node
// Measures noise on real repositories: for each git repo given on the command line, finds the commits that
// touched agent files and diffs them (single commits and wider windows) with the built tool.
// Usage: node scripts/corpus-check.mjs [--max N] [--jsonl out.jsonl] <repo-dir>...
// Needs `npm run build` first. Works with blobless clones (`git clone --filter=blob:none --no-checkout`).
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { diffSnapshots } from '../dist/src/diff.js';
import { resolveRange } from '../dist/src/git.js';

const PATHSPECS = [
  ':(glob)**/AGENTS.md', ':(glob)**/AGENT.md', ':(glob)**/CLAUDE.md', ':(glob)**/CLAUDE.local.md', ':(glob)**/GEMINI.md',
  ':(glob)**/SKILL.md', ':(glob)**/.cursorrules', ':(glob)**/.windsurfrules', ':(glob)**/.clinerules',
  '.github/copilot-instructions.md', '.github/instructions', '.cursor', '.clinerules', '.windsurf', '.roo', '.junie',
  '.claude', '.agents', ':(glob)**/.mcp.json', '.vscode/mcp.json', '.gemini', '.kiro', '.zed', 'opencode.json',
  'opencode.jsonc', '.opencode',
];

const args = process.argv.slice(2);
let max = 40;
let jsonl;
const repos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max') max = Number(args[++i]);
  else if (args[i] === '--jsonl') jsonl = args[++i];
  else repos.push(args[i]);
}
if (repos.length === 0) {
  console.error('usage: corpus-check.mjs [--max N] [--jsonl file] <repo-dir>...');
  process.exit(2);
}
if (jsonl) writeFileSync(jsonl, '');

const git = (cwd, a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'] });

const totals = new Map();
for (const repo of repos) {
  const name = basename(repo);
  let touching;
  try {
    touching = git(repo, ['log', '--format=%H', '--', ...PATHSPECS]).split('\n').filter(Boolean);
    git(repo, ['log', '-p', '--format=', '-n', '400', '--', ...PATHSPECS]); // prefetch blobs in one go on partial clones
  } catch (e) {
    console.error(`${name}: ${String(e.message).split('\n')[0]}`);
    continue;
  }
  const pairs = [];
  for (const c of touching.slice(0, max)) pairs.push([`${c}^`, c, 'commit']);
  for (let i = 0; i + 6 < touching.length && pairs.length < max + 15; i += 6) pairs.push([touching[i + 6], touching[i], 'window']);
  const perRule = new Map();
  let findings = 0;
  let errors = 0;
  let pairsWithFindings = 0;
  for (const [b, h, kind] of pairs) {
    try {
      const range = resolveRange({ cwd: repo, positional: [b, h] });
      const res = diffSnapshots(range.base, range.head);
      if (res.findings.length) pairsWithFindings++;
      for (const f of res.findings) {
        findings++;
        const k = `${f.rule}|${f.severity}`;
        perRule.set(k, (perRule.get(k) ?? 0) + 1);
        totals.set(k, (totals.get(k) ?? 0) + 1);
        if (jsonl) appendFileSync(jsonl, `${JSON.stringify({ repo: name, base: b.slice(0, 10), head: h.slice(0, 10), kind, ...f })}\n`);
      }
    } catch (e) {
      errors++;
      console.error(`${name} ${b.slice(0, 8)}..${h.slice(0, 8)}: ${String(e.message).split('\n')[0]}`);
    }
  }
  console.log(`${name}: ${touching.length} commits touch agent files; ${pairs.length} diffs, ${pairsWithFindings} with findings, ${findings} findings, ${errors} errors`);
}
console.log('\nfindings by rule|severity (all repos):');
for (const [k, n] of [...totals].sort((x, y) => y[1] - x[1])) console.log(`${String(n).padStart(6)}  ${k}`);
