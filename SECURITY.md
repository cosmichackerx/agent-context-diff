# Security policy

`agent-context-diff` only reads files from a git repository and prints a report. It makes no network requests and
never executes anything from the repositories it inspects.

Credentials found in configs are **never printed**; reports only show that a literal credential exists and its length.

If you find a vulnerability (for example a way to make the tool execute code, leak a secret into its output, or crash
on crafted files), please open a private security advisory on GitHub
(*Security → Report a vulnerability*) instead of a public issue.
