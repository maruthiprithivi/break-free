---
title: firstmate standing rule coverage in setup.mjs (installFirstmate)
tags: [finding, gotcha, convention]
created: "2026-09-21T10:05:25.606Z"
updated: "2026-09-25T00:00:00.000Z"
source: worker
---
# firstmate standing rule coverage in setup.mjs (installFirstmate)

Superseded by #122: installFirstmate no longer writes a Firstmate standing rule, and the AGENTS.firstmate / CLAUDE.firstmate snippets are deleted. The gateway and GitHub-flow snippets instead open with a Firstmate carve-out.

Facts worth keeping:
- stripLegacyFirstmateRules (setup.mjs, FM_MARKER) removes any old `## Crew, worktrees and merge authority (firstmate)` block from ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, the project CLAUDE.md/AGENTS.md and every EXTRA_AGENTS user/project rules file, on both install and uninstall. The block ends at the next `\n## ` heading or end of file.
- report.info(msg) takes ONE argument (setup/lib.mjs); a second arg is silently dropped. report.pass/what/detail are the two-arg form.
