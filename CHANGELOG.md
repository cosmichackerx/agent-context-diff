# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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

[0.1.0]: https://github.com/cosmichackerx/agent-context-diff/releases/tag/v0.1.0
