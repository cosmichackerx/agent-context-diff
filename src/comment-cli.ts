#!/usr/bin/env node
// Used by the GitHub Action (`comment: true`): agent-context-diff-comment <markdown-file>
// Reads the pull_request event from GITHUB_EVENT_PATH; the token comes from GITHUB_TOKEN. Never fails the job.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentEligibility, upsertComment } from './comment.js';

export async function main(argv: string[], env: NodeJS.ProcessEnv, log: (s: string) => void = (s) => process.stdout.write(`${s}\n`)): Promise<number> {
  const file = argv[0];
  if (!file) {
    log('usage: agent-context-diff-comment <markdown-file>');
    return 2;
  }
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token || !env.GITHUB_EVENT_PATH) {
    log('::notice::agent-context-diff: no sticky comment (GITHUB_REPOSITORY, GITHUB_TOKEN or GITHUB_EVENT_PATH missing)');
    return 0;
  }
  const verdict = commentEligibility(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as unknown, repo);
  if ('skip' in verdict) {
    log(`::notice::agent-context-diff: no sticky comment (${verdict.skip})`);
    return 0;
  }
  try {
    const out = await upsertComment({ apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com', token, repo, pr: verdict.pr }, readFileSync(file, 'utf8'));
    log(out.action === 'skipped' ? `::warning::agent-context-diff: sticky comment skipped: ${out.reason}` : `agent-context-diff: sticky comment ${out.action} (#${out.id})`);
  } catch (err) {
    log(`::warning::agent-context-diff: sticky comment failed: ${(err as Error).message}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then((c) => {
    process.exitCode = c;
  });
}
