# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
