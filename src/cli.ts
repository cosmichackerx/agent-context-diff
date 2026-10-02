#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { diffSnapshots } from './diff.js';
import { GitError, resolveRange, UsageError } from './git.js';
import { meetsThreshold, parseSeverity, renderGithub, renderJson, renderMarkdown, renderSarif, renderText } from './report.js';
import { RULES } from './rules.js';
import type { Severity } from './types.js';

const HELP = `agent-context-diff - diff AGENTS.md, CLAUDE.md, Cursor rules and MCP/agent configs between git refs

Usage:
  agent-context-diff [base] [head] [options]
  agent-context-diff main...HEAD            changes since the merge base (pull request view)
  agent-context-diff v1.0 v1.1              between two refs
  agent-context-diff                        working tree vs HEAD (uncommitted changes)

Options:
  -C, --cwd <dir>        run as if started in <dir> (default: current directory)
      --base <ref>       base ref (default: HEAD)
      --head <ref>       head ref, or "worktree" (default: working tree)
  -f, --format <fmt>     text | markdown | json | github | sarif   (default: text)
  -o, --output <file>    write the report to a file instead of stdout
      --fail-on <level>  exit 1 if a finding is at least: high | medium | low | info | never (default: never)
      --check-divergence report AGENTS.md / CLAUDE.md pairs in one directory that differ (opt-in)
      --no-color         disable colors
      --list-rules       print all rule ids and exit
  -v, --version          print version
  -h, --help             print this help

Exit codes: 0 ok, 1 findings at/above --fail-on, 2 usage or git error.
`;

function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(join(here, rel), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'agent-context-diff' && pkg.version) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return 'unknown';
}

export function run(argv: string[], stdout: (s: string) => void = (s) => process.stdout.write(s), stderr: (s: string) => void = (s) => process.stderr.write(s)): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        cwd: { type: 'string', short: 'C' },
        base: { type: 'string' },
        head: { type: 'string' },
        format: { type: 'string', short: 'f', default: 'text' },
        output: { type: 'string', short: 'o' },
        'fail-on': { type: 'string', default: 'never' },
        'no-color': { type: 'boolean', default: false },
        'check-divergence': { type: 'boolean', default: false },
        'list-rules': { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    stderr(`agent-context-diff: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout(HELP);
    return 0;
  }
  if (values.version) {
    stdout(`agent-context-diff ${version()}\n`);
    return 0;
  }
  if (values['list-rules']) {
    for (const [id, desc] of Object.entries(RULES)) stdout(`${id.padEnd(28)} ${desc}\n`);
    return 0;
  }
  const format = values.format as string;
  if (!['text', 'markdown', 'json', 'github', 'sarif'].includes(format)) {
    stderr(`agent-context-diff: unknown --format '${format}' (text, markdown, json, github, sarif)\n`);
    return 2;
  }
  const failOnRaw = values['fail-on'] as string;
  const failOn: Severity | 'never' | undefined = failOnRaw === 'never' ? 'never' : parseSeverity(failOnRaw);
  if (failOn === undefined) {
    stderr(`agent-context-diff: unknown --fail-on '${failOnRaw}' (high, medium, low, info, never)\n`);
    return 2;
  }
  if (positionals.length > 2) {
    stderr('agent-context-diff: too many arguments (expected [base] [head])\n');
    return 2;
  }

  try {
    const range = resolveRange({ cwd: resolve(values.cwd ?? '.'), positional: positionals, base: values.base, head: values.head });
    const result = diffSnapshots(range.base, range.head, { checkDivergence: values['check-divergence'] === true });
    const color = !values['no-color'] && !values.output && Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env);
    let text: string;
    switch (format) {
      case 'markdown':
        text = renderMarkdown(result);
        break;
      case 'json':
        text = renderJson(result);
        break;
      case 'github':
        text = renderGithub(result);
        break;
      case 'sarif':
        text = renderSarif(result, version());
        break;
      default:
        text = renderText(result, color);
    }
    if (values.output) writeFileSync(values.output, `${text}\n`);
    else if (text) stdout(`${text}\n`);
    return failOn !== 'never' && meetsThreshold(result.findings, failOn) ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError || err instanceof GitError) {
      stderr(`agent-context-diff: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url) || /agent-context-diff(\.js)?$/.test(invoked)) {
  process.exitCode = run(process.argv.slice(2));
}
