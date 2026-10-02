# agent-context-diff

**Diff `AGENTS.md`, `CLAUDE.md`, Cursor rules and MCP server configs between git refs — and flag the changes that matter for security review.**

`agent-context-diff` is a zero-dependency TypeScript CLI and GitHub Action for teams that let AI coding agents
(Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Windsurf, Cline, OpenCode, Zed …) work in their repositories.
Those agents are steered by plain files in the repo — `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.mcp.json`,
`.claude/settings.json` — and a one-line change to them can add a new MCP server that runs `npx` code on every
developer machine, widen tool permissions to `Bash(*)`, drop a "never push to main" rule, or smuggle invisible
Unicode instructions past a reviewer. A normal `git diff` shows the text but not the *meaning*. This tool does.

```text
# example output (abridged)
$ agent-context-diff main...HEAD --fail-on high

.mcp.json (modified)
  HIGH   mcp-server-added        server 'gh': added (stdio `npx -y @x/github`)
  HIGH   mcp-secret-literal      server 'gh': env 'GITHUB_TOKEN' contains a literal credential [redacted 40 chars]; use an environment reference instead
  MEDIUM mcp-unpinned-package    server 'gh': runs '@x/github' without a pinned version, so upstream changes execute on your machine unreviewed

.claude/settings.json (modified)
  HIGH   perm-default-mode-changed  defaultMode changed: (default) → bypassPermissions
  HIGH   perm-deny-removed          permission deny rule removed (guardrail): Bash(curl:*)

AGENTS.md (modified)
  HIGH   ctx-hidden-characters   L9   added line contains invisible Unicode characters (U+200B); these can hide instructions from reviewers
  MEDIUM ctx-guardrail-removed   L6(base)  prohibition removed: "- Never commit secrets."
```

## Why

- **Agent config is code.** MCP servers execute commands and talk to the network; permissions decide what an agent
  may do unattended; hooks run arbitrary shell commands. They deserve code review, not a skim.
- **Review fatigue.** Config diffs are noisy JSON and prose. This tool classifies each change by severity so the
  reviewer sees "3 high" instead of 400 lines.
- **Prompt-injection surface.** Rules files are read by the model. Zero-width characters, bidi overrides, Unicode
  tag characters ("ASCII smuggling"), HTML comments and "ignore previous instructions" phrasing are invisible or
  easy to miss in a PR.
- **Git-ref aware.** Compare `main...HEAD` in a pull request, two release tags, or your uncommitted working tree.

## Install

Requires Node.js 20+ and git. The package is not on the npm registry yet; install straight from GitHub:

```bash
npm install -g github:cosmichackerx/agent-context-diff
# or run once without installing
npm exec --package=github:cosmichackerx/agent-context-diff -- agent-context-diff main...HEAD
```

Or from a clone: `npm ci && npm run build && node dist/src/cli.js --help`.

## Usage

```bash
agent-context-diff                       # uncommitted changes (working tree vs HEAD)
agent-context-diff main...HEAD           # what this branch changed since it diverged from main (PR view)
agent-context-diff v1.0.0 v1.1.0         # between two refs
agent-context-diff main..feature         # direct tree comparison
agent-context-diff -C path/to/repo main...HEAD --format markdown > comment.md
agent-context-diff main...HEAD --fail-on high      # exit code 1 if any high finding (CI gate)
agent-context-diff --list-rules
```

| Option | Description |
|---|---|
| `-C, --cwd <dir>` | Run as if started in `<dir>` |
| `--base <ref>` / `--head <ref>` | Alternative to positional refs; `--head worktree` = working tree |
| `-f, --format` | `text` (default), `markdown`, `json`, `github` (workflow annotations), `sarif` (code scanning) |
| `-o, --output <file>` | Write the report to a file |
| `--fail-on <level>` | `high`, `medium`, `low`, `info`, `never` (default `never`) |
| `--check-divergence` | Opt-in: report `AGENTS.md`/`CLAUDE.md` pairs in one directory whose content differs |
| `--no-color` | Disable colors (also honours `NO_COLOR`) |

Exit codes: `0` ok · `1` a finding at or above `--fail-on` · `2` usage/git error.

## GitHub Action

```yaml
name: agent-context-review
on: pull_request
permissions:
  contents: read
jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0          # both sides of the PR must be available
      - uses: cosmichackerx/agent-context-diff@v0.3.0
        with:
          fail-on: high           # high | medium | low | info | never
```

### Sticky pull request comment

Set `comment: true` and the report is posted as **one** comment that is updated in place on every push (no comment pile-up).
The job needs `pull-requests: write`; fork PRs (read-only token) are skipped with a log line, never failed.

```yaml
permissions:
  contents: read
  pull-requests: write
steps:
  - uses: actions/checkout@v5
    with: { fetch-depth: 0 }
  - uses: cosmichackerx/agent-context-diff@v0.3.0
    with:
      comment: true        # sticky comment, identified by a hidden marker
      fail-on: high
```

The same thing works from any CI: `agent-context-diff main..HEAD -f markdown > report.md && GITHUB_TOKEN=… agent-context-diff-comment report.md`
(reads `GITHUB_REPOSITORY` and `GITHUB_EVENT_PATH`; it never fails the job). Comments over 60 000 characters are truncated with a notice.

### Code scanning (SARIF)

`--format sarif` writes SARIF 2.1.0 (validated against the official JSON schema in the test suite). Head-side
findings carry a line; findings about something *removed* are attached to the file without a line. Upload with the
CodeQL action's uploader so findings show up in the **Security → Code scanning** tab:

```yaml
jobs:
  diff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write      # needed by upload-sarif
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: cosmichackerx/agent-context-diff@v0.3.0
        with:
          format: sarif
          output-file: agent-context.sarif
      - uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: agent-context.sarif
          category: agent-context-diff
```

Code scanning is free for public repositories; private repositories need GitHub Code Security.

On pull requests the base and head default to the PR's base/head SHAs. Findings appear as annotations, and a
Markdown report is added to the job summary (`summary: false` to disable). Inputs: `base`, `head`,
`working-directory`, `fail-on`, `format`, `output-file`, `summary`, `check-divergence`, `node-version`. The action builds the tool from
source with `npm ci --ignore-scripts` on the runner; it needs no secrets and makes no network calls beyond npm
installing the dev toolchain.

## What it understands

**Instruction files:** `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `.cursorrules`,
`.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `.github/instructions/*.md`,
`.cursor/rules/**/*.{md,mdc}`, `.cursor/commands`, `.windsurf/rules`, `.roo/rules*`, `.junie/guidelines.md`,
`.claude/{commands,agents,skills,rules}/**/*.md`, `SKILL.md` (in any directory; `node_modules` is ignored), and
since v0.1.1 Aider `CONVENTIONS.md` (repository root), Amazon Q `.amazonq/rules`, Kiro `.kiro/steering`,
Continue `.continue/rules`, Augment `.augment/rules`, Trae `.trae/rules`, Copilot `.github/prompts/*.prompt.md`,
`.github/agents/*.md` and `.github/chatmodes/*.chatmode.md`.

**MCP / agent configs (JSON or JSONC):** `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`,
`.roo/mcp.json`, `.kiro/settings/mcp.json`, `.windsurf/mcp.json`, `.zed/settings.json`, `opencode.json(c)`,
`.amazonq/{mcp,default}.json`, `.amazonq/cli-agents/*.json`, `.continue/mcpServers/*.json`,
`.claude/settings.json`, `.claude/settings.local.json`. Server blocks under `mcpServers`, `servers`,
`context_servers` and `mcp` are normalised (stdio command + args, argv-style `command`, Zed-style command objects,
remote `url`/`headers`).

**TOML and YAML configs (since v0.3.0):** Codex `.codex/config.toml` (`[mcp_servers.*]`, plus `approval_policy`,
`sandbox_mode`, `[shell_environment_policy]`, `[projects.*] trust_level`) and Continue
`.continue/{config,mcpServers}.yaml`, `.continue/mcpServers/*.yaml`, `.continue/agents/*.yaml` (list or map form, including
`uses:` hub blocks). The parsers are small, dependency-free subsets: TOML tables / arrays of tables / dotted keys / all string
forms / inline tables, and block YAML with flow collections and `|`/`>` scalars. Anchors, aliases, tags, merge keys and
multi-document YAML are refused with a `config-unparsable` finding instead of being misread.
Checked against 8 public `.codex/config.toml` and 7 public Continue YAML files found by GitHub code search: all parse
and yield the expected servers (hand-compared; this is a parse check, not a finding-accuracy study).

Example (real output on a throwaway repo, `.codex/config.toml` and `.continue/config.yaml` changed):

```text
agent-context-diff  HEAD~2 → HEAD

.codex/config.toml (modified)
  HIGH   codex-approval-widened               approval_policy set to never: Codex asks for fewer confirmations
  HIGH   codex-sandbox-widened                sandbox_mode set to danger-full-access
  HIGH   mcp-server-added                     server 'fetcher': added (stdio `npx -y mcp-fetch-server`)
  MEDIUM codex-env-inherit-all                shell_environment_policy.inherit = "all": every environment variable (including secrets) is passed to commands
  MEDIUM codex-project-trusted                project marked trusted: /home/dev/app
  MEDIUM mcp-unpinned-package                 server 'fetcher': runs 'mcp-fetch-server' without a pinned version, so upstream changes execute on your machine unreviewed

.continue/config.yaml (modified)
  HIGH   mcp-server-added                     server 'acme/db-server': added (http hub:acme/db-server)
  HIGH   mcp-server-added                     server 'tools': added (http https://mcp.example.com/sse)

8 finding(s): 5 high, 3 medium, 0 low, 0 info
```

### Rules (selection)

Run `agent-context-diff --list-rules` for the full list.

| Rule | Typical severity | Meaning |
|---|---|---|
| `mcp-server-added` | high | New MCP server: new code execution / data-egress surface |
| `mcp-command-changed`, `mcp-package-changed`, `mcp-url-changed` | high / medium | What a server runs or where it connects changed |
| `mcp-auto-approve` | high | `autoApprove`, `alwaysAllow` or `trust: true` added or widened |
| `mcp-secret-literal` | high | Literal token in `env`, `headers`, args or URL (value never printed) |
| `mcp-unpinned-package` | medium | `npx`/`uvx`/`docker` package without a pinned version |
| `mcp-shell-wrapper` | medium / high | `bash -c …` launch, or download-and-execute one-liner |
| `perm-allow-added` | low – high | Severity scales with breadth: `Read(*)` low … `Bash(*)` high |
| `perm-deny-removed`, `perm-default-mode-changed` | high | Guardrail removed / `bypassPermissions` |
| `hook-added` | medium / high | New hook = new shell command on agent events (high when it uses the network, eval, sudo …) |
| `ctx-guardrail-removed` | medium | A "never / do not / must not" line disappeared (moves are ignored) |
| `ctx-hidden-characters` | high | Zero-width, bidi or Unicode tag characters in added text |
| `ctx-injection-phrase` | high | "Ignore previous instructions", "don't tell the user" … |
| `ctx-dangerous-command` | medium / high | `curl … \| sh`, `--no-verify`, `--dangerously-skip-permissions`, `rm -rf /` … (not when the line forbids it) |
| `ctx-html-comment` | medium | Invisible-when-rendered comment added to an instruction file |
| `ctx-frontmatter-changed` | medium | `tools`, `allowed-tools`, `alwaysApply`, `permissionMode` changed |
| `codex-approval-widened`, `codex-sandbox-widened` | high / medium | Codex `approval_policy = "never"`, `sandbox_mode = "danger-full-access"` |
| `codex-network-enabled`, `codex-env-inherit-all`, `codex-project-trusted` | medium | Network access in the sandbox, all env vars passed to commands, project marked trusted |
| `ctx-files-diverge` | low | Opt-in (`--check-divergence`): `AGENTS.md` and `CLAUDE.md` in one directory differ. `CLAUDE.md` containing `@AGENTS.md` is fine |

Only **added** lines are scanned for risky content, so pre-existing text is not re-reported on every PR, and lines
that merely moved (to another section *or another instruction file*, e.g. `CLAUDE.md` → `AGENTS.md`) are not treated
as new or as deleted.

## Reducing noise

Config review tools live or die by their false-positive rate, so v0.1.1 was tuned against real history (see
[Measured on real repositories](#measured-on-real-repositories)). What is deliberately quiet, what is still
reported on purpose, and what you can do about it today:

| You will see | Why it is reported | What to do |
|---|---|---|
| `mcp-server-added` (high) for a documentation server such as `https://docs.example.com/mcp` | Any new server is a new data-egress or code-execution surface. This is the finding you most want a human to see, and it appeared on every real repo that adopted MCP. | Review it once. Use `--fail-on` to decide which severities block a PR, e.g. `--fail-on high` blocks only new servers, widened permissions and hidden characters. |
| `mcp-unpinned-package` (medium) for `npx -y @scope/server` | A package runner without a version executes whatever upstream publishes next. A lockfile does **not** pin `npx` launches that happen outside the project. | Pin it (`@scope/server@1.2.3`) or accept it by gating on `--fail-on high`. |
| `perm-allow-added` (low) for `Bash(npm test:*)`, `Bash(grep:*)`, `Bash(gh pr view:*)`, `WebFetch(domain:github.com)` | Intentionally broad but read-only or dev-loop rules are `low`, not `medium`. | Nothing; they stay below `--fail-on medium`. Rules that run arbitrary code (`Bash(python3:*)`, `Bash(uv run:*)`, `Bash(make:*)`) remain `medium`/`high` on purpose. |
| `hook-added` (medium) for a formatter hook such as `bunx prettier --write .` | A hook is a shell command that runs on every agent event. Plain local commands are `medium`; hooks that use the network, `eval`, `sudo` or command substitution are `high`. | Review the hook and the script it calls (the script itself is not an agent file and is not analysed). |
| `ctx-guardrail-removed` (medium) | A line starting with "Never / Do not / Don't / Avoid / Must not" was deleted and nothing similar remains in the file. Prose such as "runs that don't time out" is **not** treated as a prohibition, and a reworded prohibition is not reported. | Intentional edits are expected; the finding points at the base-side line so you can confirm quickly. |
| `ctx-file-added` / `ctx-file-removed` | Only files loaded into *every* session (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`, `alwaysApply: true` rules) are `medium`; skills, commands and scoped rules are `low`. A file whose content still exists in another instruction file (a rename or consolidation) is `info`. | Nothing; renames and consolidations are no longer alarming. |
| `ctx-section-*` (info/low) | Structural notices. More than six in one file collapse into a single summary line. | Filter with `--fail-on medium`. |
| `ctx-dangerous-command` for `curl … \| sh` (medium) | An installer one-liner was added to instructions an agent will follow. `http://`, `sudo`, or a raw-IP URL makes it `high`. Lines that *forbid* a command ("never use `--no-verify`"), type unions that list `bypassPermissions`, and `--force-with-lease` are not flagged. | Replace the one-liner with a pinned package-manager install if you can. |
| `ctx-html-comment` (medium) | Comments are invisible in rendered Markdown but read by agents. Comments inside code fences and bare tool markers (`<!-- BEGIN:x -->`, `<!-- prettier-ignore-start -->`) are ignored. | Move the text out of the comment, or review it. |

## Accepting known findings: the allow-list

Some findings are real but already reviewed (the documentation MCP server your team approved). Put them in
`.agent-context-diff.json` at the repository root:

```json
{
  "ignore": [
    { "rule": "mcp-server-added", "server": "github", "reason": "approved in SEC-123 (pinned, read-only token)" },
    { "rule": "perm-allow-added", "file": ".claude/settings.json", "contains": "Bash(make test", "reason": "dev loop",
      "expires": "2027-03-31" }
  ]
}
```

| Key | Meaning |
|---|---|
| `rule` | Rule id or glob (`mcp-*`). Required. A wildcard rule must also have `file`, `server` or `contains`. |
| `file` | Path glob (`*` inside a directory, `**` across). Default: any file. |
| `server` | MCP server name (or glob) the finding is about. |
| `contains` | Case-insensitive text that must appear in the finding message. |
| `reason` | **Required.** Shown in every report so the exception stays visible. |
| `expires` | `YYYY-MM-DD`. After that day the entry stops applying and is listed as expired. |

**A change cannot silence its own findings.** The file is read from the **base** ref (the target branch of the pull
request), never from the head. Entries a pull request adds do not apply to it; they are reported as
`allowlist-entry-added` (high for wildcard or unrestricted entries, medium otherwise) so a reviewer sees the new
exception, and they start working once the change is merged. An invalid allow-list on the base ref ignores nothing and
is reported as `allowlist-invalid`. Unknown keys, a missing `reason` and a bare `"rule": "*"` are rejected.

Ignored findings do not count towards `--fail-on`. They are listed in text/Markdown output, in the JSON `ignored` array,
and in SARIF as results with `suppressions` (kind `external`, with your reason), so code scanning shows them as accepted.
Entries that match nothing are listed as stale. Real output (the pull request adds the approved `github` server and an
unapproved `files` server; the allow-list on `main` approves only `github`):

```text
$ agent-context-diff main...HEAD --fail-on high
agent-context-diff  main (merge-base 8d0ae97) → HEAD

.mcp.json (modified)
  HIGH   mcp-server-added                     server 'files': added (stdio `npx -y @modelcontextprotocol/server-filesystem@1.0.0 /tmp`)

1 finding(s): 1 high, 0 medium, 0 low, 0 info
1 finding(s) accepted by the allow-list (read from the base ref):
  - mcp-server-added in .mcp.json: approved in SEC-123 (pinned, read-only token)
```

Use `--no-allowlist` to see everything, or `--allowlist <file>` to apply a trusted file kept outside the change under
review (for example an organisation-wide policy checked out separately). Do not point `--allowlist` at a file inside a
pull request checkout: that file is controlled by the change.

## Measured on real repositories

`scripts/corpus-check.mjs` runs the built tool over every commit that touched an agent file, plus wider windows of
six touching commits, in a list of git repositories (blobless clones are fine). On 2026-10-02 it was run over
16 public repositories with real agent configuration history (`openai/codex`, `langchain-ai/langchain`,
`cline/cline`, `astral-sh/uv`, `vercel/ai`, `getsentry/warden`, `getzep/zep`, `modelcontextprotocol/typescript-sdk`,
`livestorejs/livestore`, `Doist/todoist-mcp`, `anthropics/claude-code-action`, `bitrise-io/bitrise-workflow-editor`,
`github/github-mcp-server`, `ClickHouse/ai-sdk-cpp`, `disler/agent-sandboxes`, `jnarowski/agentcmd`):
471 historical diffs.

| Over 471 diffs | v0.1.0 | v0.1.1 |
|---|---:|---:|
| Findings in total | 3207 | 1970 |
| `high` findings | 48 | 25 |
| `medium` findings | 844 | 207 |
| Diffs with at least one `medium` or `high` finding | 203 (43 %) | 110 (23 %) |
| Diffs with at least one `high` finding | 42 (9 %) | 21 (4 %) |

The tuning that produced this: prohibitions must be imperative (not "runs that don't time out"); "silently" alone is
not secrecy wording; "do not tell the user *to run* X" is not hiding; lines that forbid a command are not
instructions to run it; `--force-with-lease`, `eval` inside `locomo-eval`, and union types listing `bypassPermissions`
are not dangerous; text that moved between instruction files is neither deleted nor new; reworded prohibitions are
not removals; hooks, dev-loop permissions and renamed/consolidated files got graded severities; and big rewrites
collapse into one summary line.

Every remaining `high` finding was reviewed by hand; they are real additions (new MCP servers, `Write`/`python3`
permissions, an example skill that tells the model to hide a rule from the user). The `medium` findings are mostly
`ctx-guardrail-removed`, where a "don't/never/avoid" line really was deleted or rewritten. Those are review prompts,
not defects, which is why the gate is `--fail-on` and not "any finding".

```bash
git clone --filter=blob:none --no-checkout https://github.com/OWNER/REPO.git
npm run build
node scripts/corpus-check.mjs --max 40 --jsonl findings.jsonl REPO
```

## How it compares

This is a young, fast-moving niche. Related projects, each with a different focus:

- [`agent-scope-diff`](https://github.com/pfrederiksen/agent-scope-diff) — risk-focused diffs of agent manifests and
  permission snapshots (shell-first, file-pair oriented).
- [`context-drift`](https://github.com/geekiyer/context-drift) — checks whether `CLAUDE.md`/`AGENTS.md` still match the
  codebase (dead paths, stale commands).
- [`agentsync`](https://github.com/mujinlabs/agentsync) and [`@agents-dev/cli`](https://www.npmjs.com/package/@agents-dev/cli) —
  generate/sync instruction and MCP files across tools and detect drift between generated copies.

`agent-context-diff` is complementary: it answers **"what did this PR change in my agents' instructions and
capabilities, and is any of it risky?"** across all of those files, directly from git history.

## Limitations

- Heuristics, not proof: expect some false positives and misses. Treat findings as review prompts. Severity is a
  judgement call; use `--fail-on` to pick your own threshold.
- TOML/YAML parsers are deliberate subsets (see above); exotic YAML is reported as `config-unparsable`. Goose / other YAML formats beyond Continue are not mapped yet.
- Only repository files are analysed — user-level configs (`~/.claude.json`, `~/.cursor/mcp.json`) are out of scope.
- Files larger than 1 MB are skipped.
- No suppression/allow-list file yet (see roadmap).

## Development

```bash
npm ci
npm run typecheck
npm test
```

Tests build real temporary git repositories; CI runs on Ubuntu, Windows and macOS with Node 20, 22 and 24.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

See the open [roadmap issues](https://github.com/cosmichackerx/agent-context-diff/issues?q=is%3Aissue+is%3Aopen+label%3Aroadmap):
npm publication, more agent tools and formats.

## License

[MIT](LICENSE) © Muhammad Arslan
