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
| `-f, --format` | `text` (default), `markdown`, `json`, `github` (workflow annotations) |
| `-o, --output <file>` | Write the report to a file |
| `--fail-on <level>` | `high`, `medium`, `low`, `info`, `never` (default `never`) |
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
      - uses: cosmichackerx/agent-context-diff@v0.1.0
        with:
          fail-on: high           # high | medium | low | info | never
```

On pull requests the base and head default to the PR's base/head SHAs. Findings appear as annotations, and a
Markdown report is added to the job summary (`summary: false` to disable). Inputs: `base`, `head`,
`working-directory`, `fail-on`, `format`, `output-file`, `summary`, `node-version`. The action builds the tool from
source with `npm ci --ignore-scripts` on the runner; it needs no secrets and makes no network calls beyond npm
installing the dev toolchain.

## What it understands

**Instruction files:** `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `.cursorrules`,
`.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `.github/instructions/*.md`,
`.cursor/rules/**/*.{md,mdc}`, `.windsurf/rules`, `.roo/rules*`, `.junie/guidelines.md`,
`.claude/{commands,agents,skills}/**/*.md`, `SKILL.md` (in any directory; `node_modules` is ignored).

**MCP / agent configs (JSON or JSONC):** `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`,
`.roo/mcp.json`, `.kiro/settings/mcp.json`, `.windsurf/mcp.json`, `.zed/settings.json`, `opencode.json(c)`,
`.claude/settings.json`, `.claude/settings.local.json`. Server blocks under `mcpServers`, `servers`,
`context_servers` and `mcp` are normalised (stdio command + args, argv-style `command`, Zed-style command objects,
remote `url`/`headers`).

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
| `hook-added` | high | New hook = new shell command on agent events |
| `ctx-guardrail-removed` | medium | A "never / do not / must not" line disappeared (moves are ignored) |
| `ctx-hidden-characters` | high | Zero-width, bidi or Unicode tag characters in added text |
| `ctx-injection-phrase` | high | "Ignore previous instructions", "don't tell the user" … |
| `ctx-dangerous-command` | medium / high | `curl … \| sh`, `--no-verify`, `--dangerously-skip-permissions`, `rm -rf /` … |
| `ctx-html-comment` | medium | Invisible-when-rendered comment added to an instruction file |
| `ctx-frontmatter-changed` | medium | `tools`, `allowed-tools`, `alwaysApply`, `permissionMode` changed |

Only **added** lines are scanned for risky content, so pre-existing text is not re-reported on every PR, and lines
that merely moved are not treated as new.

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

## Limitations (v0.1.0)

- Heuristics, not proof: expect some false positives and misses. Treat findings as review prompts. Severity is a
  judgement call; use `--fail-on` to pick your own threshold.
- TOML configs (for example Codex `~/.codex/config.toml`) and YAML configs are not parsed yet.
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
allow-list/baseline file, SARIF output, TOML/YAML configs, PR-comment mode, npm publication, more agent tools.

## License

[MIT](LICENSE) © Muhammad Arslan
