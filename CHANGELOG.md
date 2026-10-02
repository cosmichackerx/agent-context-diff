# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-10-03

### Changed
- Maintenance release, no change in what the tool reports. The action now uses `actions/setup-node` 7.0.0 (node24),
  CI uses `actions/checkout` 7.0.1 (both pinned by commit SHA), TypeScript 7.0.2 builds the tool, a `dependabot.yml`
  keeps dependencies current (major `@types/node` bumps are ignored: it tracks the oldest supported Node, 20), and CI
  runs `dependabot-gaps` in pull request mode.

## [0.3.0] - 2026-10-03

### Added
- Sticky pull request comment (issue #5): action input `comment` (+ `github-token`) and the `agent-context-diff-comment`
  binary. One hidden-marker comment, created or updated in place; forks and non-PR events are skipped; 401/403 gives a
  `pull-requests: write` hint; output is truncated at 60 000 characters; it never fails the job. CI self-test runs it twice
  on same-repo PRs and asserts exactly one comment exists.
- TOML support (issue #3): Codex `.codex/config.toml` with `[mcp_servers.*]` and the rules `codex-approval-widened`,
  `codex-sandbox-widened`, `codex-network-enabled`, `codex-env-inherit-all`, `codex-project-trusted`.
- YAML support (issue #4): Continue `.continue/{config,mcpServers}.yaml`, `.continue/mcpServers/*.yaml`, `.continue/agents/*.yaml`
  (list and map forms, `uses:` hub blocks). Dependency-free parsers that reject anchors/aliases/tags/merge keys instead of misreading.
- `mcp_servers` key and `cmd` / `envs` / `uri` aliases in MCP extraction.

### Fixed
- Multi-line TOML strings are LF-normalised for CRLF input.

## [0.2.0] - 2026-10-02

### Added
- Allow-list `.agent-context-diff.json` (issue #1): `ignore` entries with `rule` (glob), `file` (glob), `server`, `contains`,
  mandatory `reason` and optional `expires`. It is read from the **base** ref, so a change cannot silence its own findings.
  Entries added by a change are reported as `allowlist-entry-added`; an invalid allow-list is reported as `allowlist-invalid`
  and ignores nothing. Ignored findings are listed (text, Markdown, JSON `ignored`) and exported to SARIF as `suppressions`;
  stale and expired entries are listed.
- `--allowlist <file>` (trusted file outside the change) and `--no-allowlist`.

### Changed
- `action.yml` description shortened to the 125 characters GitHub Marketplace allows; a test now checks the name, description length, branding icon/color and composite `runs`.

## [0.1.1] - 2026-10-02

### Added
- `--format sarif` (SARIF 2.1.0) for GitHub code scanning: every rule is declared with a `security-severity`,
  head-side findings carry `region.startLine`, base-side findings are attached to the file without a region, stable
  `partialFingerprints`. The test suite validates the output against the official schema. (#2)
- Opt-in `--check-divergence` (Action input `check-divergence`): rule `ctx-files-diverge` (low) reports an
  `AGENTS.md` / `CLAUDE.md` pair in the same directory whose content differs after a change touched one of them.
  A `CLAUDE.md` that imports `@AGENTS.md` (alone or with extra Claude-specific text) is recognised as in sync. (#7)
- More agent files: Aider `CONVENTIONS.md`, Amazon Q (`.amazonq/rules`, `mcp.json`, `default.json`, `cli-agents`),
  Kiro steering, Continue (`.continue/rules`, `.continue/mcpServers`), Augment and Trae rules, Copilot prompt files and
  custom agents, `.claude/rules`, `.cursor/commands`. (#8)
- `scripts/corpus-check.mjs`: measure the noise of the tool on any list of local clones.
- README: "Reducing noise" (documents expected findings and how to handle them) and "Measured on real repositories".
- Regression tests distilled from real findings (`test/tuning.test.ts`, `test/root-commit.test.ts`).

### Changed (false-positive tuning, measured on 16 real repositories)
- Prohibitions (`ctx-guardrail-removed`, `ctx-file-removed`, `ctx-section-removed`) must be imperative: "Never …",
  "Do not …", "Avoid …", `NEVER`; descriptive prose ("runs that don't time out") no longer counts. Prohibitions inside
  a removed section are reported as individual guardrail findings; the section itself is `low`.
- A prohibition that was only reworded (or extended) is not reported as removed; long lines are quoted around the
  prohibition.
- Lines that moved between *different* instruction files (`CLAUDE.md` → `AGENTS.md`, `.cursorrules` → `.cursor/rules`)
  are neither a removed guardrail nor new risky text. Pure renames/consolidations are `info`.
- `ctx-file-added` / `ctx-file-removed`: `medium` only for files loaded into every session; skills, commands and scoped
  rules are `low`.
- `ctx-section-added` is `info`; more than six section-level notices in one file collapse into one summary finding.
- `ctx-injection-phrase`: "silently/quietly" only when followed by an action verb; "do not tell the user *to* …" is no
  longer treated as hiding; gerunds ("without telling the user …") are caught.
- `ctx-dangerous-command`: lines that forbid a command are skipped; `--force-with-lease`, `eval` as part of a word and
  union types listing `bypassPermissions` are not flagged; `curl … | sh` over https is `medium` (`high` for http,
  `sudo` or a raw IP).
- `ctx-html-comment`: comments inside code fences and bare tool markers (`<!-- BEGIN:x -->`, `prettier-ignore`,
  `markdownlint-disable`, `toc`) are ignored.
- `hook-added` is `medium` for plain local commands and `high` when the command uses the network, eval, sudo or
  command substitution.
- Claude permission rules: dev-loop runners (`npm test`, `npx tsc`, `cargo test` …), read-only `gh`/`git`/`grep` commands,
  `WebSearch` and domain-scoped `WebFetch` are `low`.
- `mcp-url-changed` is `low` when only the query string changed; adding `disable-model-invocation: true` to a skill
  is `info`.

### Fixed
- Reviewing the very first commit of a repository (`<sha>^`, `HEAD~1` on a one-commit history) now diffs against the
  empty tree instead of failing with "unknown git ref".

## [0.1.0] - 2026-10-02

First public release.

### Added
- `agent-context-diff` CLI: compares agent instruction files and agent/MCP configs between two git refs
  (`a..b`, `a...b` merge-base form) or against the working tree, including untracked files.
- Instruction files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`,
  `.github/copilot-instructions.md`, `.cursor/rules/**`, `.claude/{commands,agents,skills}/**`, `SKILL.md` and more.
  Section-aware Markdown diff, removed-prohibition detection, frontmatter changes, and scanning of *added* lines for
  hidden Unicode (zero-width, bidi, tag characters), HTML comments, prompt-injection phrasing, risky commands and
  credentials.
- MCP configs: `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `opencode.json(c)`,
  `.zed/settings.json` and others (JSON with comments). Detects added/removed/changed servers, command, package,
  URL and transport changes, env/header changes, auto-approval, unpinned `npx`/`uvx`/`docker` packages, literal
  credentials (never printed), shell wrappers and plain-http remotes.
- `.claude/settings*.json`: permission allow/ask/deny changes with breadth-based severity, `defaultMode`, hooks,
  `enableAllProjectMcpServers`, session env, `apiKeyHelper` and `ANTHROPIC_BASE_URL`.
- Output formats `text`, `markdown` (PR comments / job summaries), `json` and `github` (workflow annotations);
  `--fail-on <severity>` exit code gate.
- Composite GitHub Action (`action.yml`).
- Zero runtime dependencies; Node.js 20+; tested on Linux, Windows and macOS.

[0.1.1]: https://github.com/cosmichackerx/agent-context-diff/releases/tag/v0.1.1
[0.1.0]: https://github.com/cosmichackerx/agent-context-diff/releases/tag/v0.1.0
