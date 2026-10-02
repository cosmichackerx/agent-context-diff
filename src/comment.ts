// Sticky pull request comment: create the comment once, update the same one on every run.

export const COMMENT_MARKER = '<!-- agent-context-diff:sticky -->';
/** GitHub rejects comment bodies longer than 65536 characters. */
export const MAX_COMMENT = 60000;

export interface CommentTarget {
  apiUrl: string;
  token: string;
  /** `owner/repo` */
  repo: string;
  pr: number;
  fetchImpl?: typeof fetch;
}

export type CommentOutcome = { action: 'created' | 'updated' | 'unchanged'; id: number } | { action: 'skipped'; reason: string };

export function buildBody(markdown: string): string {
  let text = markdown.trim();
  if (text.length > MAX_COMMENT) text = `${text.slice(0, MAX_COMMENT)}\n\n_(report truncated; see the job summary for the full text)_`;
  return `${COMMENT_MARKER}\n${text}\n`;
}

/** Decide from the `pull_request` event payload whether a comment may be written (not for forks: their token is read-only). */
export function commentEligibility(event: unknown, repo: string): { pr: number } | { skip: string } {
  const e = event as { pull_request?: { number?: number; head?: { repo?: { full_name?: string } | null } } } | null;
  const pr = e?.pull_request;
  if (!pr || typeof pr.number !== 'number') return { skip: 'not a pull request event' };
  const headRepo = pr.head?.repo?.full_name;
  if (!headRepo || headRepo.toLowerCase() !== repo.toLowerCase()) return { skip: 'pull request from a fork (the token is read-only there)' };
  return { pr: pr.number };
}

async function call(t: CommentTarget, method: string, path: string, body?: unknown): Promise<Response> {
  const f = t.fetchImpl ?? fetch;
  return f(`${t.apiUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${t.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-context-diff',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const denied = (status: number): boolean => status === 401 || status === 403;

/** Create the sticky comment or update the existing one. A missing permission is a skip (with a reason), not a failure. */
export async function upsertComment(t: CommentTarget, markdown: string): Promise<CommentOutcome> {
  const body = buildBody(markdown);
  let existing: { id: number; body: string } | undefined;
  for (let page = 1; page <= 10 && !existing; page++) {
    const res = await call(t, 'GET', `/repos/${t.repo}/issues/${t.pr}/comments?per_page=100&page=${page}`);
    if (denied(res.status)) return { action: 'skipped', reason: `the token cannot read pull request comments (HTTP ${res.status}); grant pull-requests: write` };
    if (!res.ok) return { action: 'skipped', reason: `could not list comments (HTTP ${res.status})` };
    const items = (await res.json()) as { id: number; body?: string }[];
    const hit = items.find((c) => typeof c.body === 'string' && c.body.startsWith(COMMENT_MARKER));
    if (hit) existing = { id: hit.id, body: hit.body as string };
    if (items.length < 100) break;
  }
  if (existing) {
    if (existing.body === body) return { action: 'unchanged', id: existing.id };
    const res = await call(t, 'PATCH', `/repos/${t.repo}/issues/comments/${existing.id}`, { body });
    if (denied(res.status)) return { action: 'skipped', reason: `the token cannot edit the comment (HTTP ${res.status}); grant pull-requests: write` };
    if (!res.ok) return { action: 'skipped', reason: `could not update the comment (HTTP ${res.status})` };
    return { action: 'updated', id: existing.id };
  }
  const res = await call(t, 'POST', `/repos/${t.repo}/issues/${t.pr}/comments`, { body });
  if (denied(res.status)) return { action: 'skipped', reason: `the token cannot create comments (HTTP ${res.status}); grant pull-requests: write` };
  if (!res.ok) return { action: 'skipped', reason: `could not create the comment (HTTP ${res.status})` };
  const created = (await res.json()) as { id: number };
  return { action: 'created', id: created.id };
}
