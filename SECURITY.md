# Security

Break Free hands real tools (files, git, GitHub, shell commands, your MCP servers) to third-party models. The design assumes those models may be wrong, over-confident or actively hostile (prompt-injected by content they read), so the interesting bugs are guardrail bypasses.

**In scope:** path-jail escapes, git/gh option injection, denied-file reads via symlinks/diffs/search, `run_command` allow-list bypasses, MCP bridge exposing filtered tools, ledger-guard bypasses that let a feature branch change `.break-free/` through the gateway, worker notes reaching other workers without promotion, budget caps not stopping work, secrets appearing in the runtime log or in worker prompts, the Responses shim leaking keys.

**Reporting:** please open a private security advisory on the GitHub repository (Security → Report a vulnerability) rather than a public issue. Include the minimal config and the tool calls that reproduce it. You will get a reply within a few days.

**What Break Free deliberately does not protect against:** a malicious *user* config (it is yours), a compromised provider returning bad code (that is what review/verify/policy rules are for, not a sandbox), and harnesses' own permission systems — the gateway only ever runs with the permissions you gave it.
