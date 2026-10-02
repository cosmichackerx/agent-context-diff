# Contributing

```bash
npm ci
npm run typecheck
npm test        # builds, then runs node:test over dist/test
```

- Tests create real temporary git repositories (see `test/helpers.ts`); please keep them OS-independent
  (CI runs Ubuntu, Windows and macOS on Node 20/22/24).
- New rules go in `src/` next to the related module **and** in `src/rules.ts` (the catalogue behind `--list-rules`),
  with a test and a line in `CHANGELOG.md`.
- A finding must never contain a secret value. Use `redact`, `redactUrl`, `redactArg` from `src/secrets.ts`.
- Prefer low false-positive rates: this tool is meant to be run on every pull request.

Good first issues are labelled `good first issue`.
