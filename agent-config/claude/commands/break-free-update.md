---
description: Update Break Free to the latest version — pull the install source and re-run the installer hands-free, reusing the scope, coding agents and providers chosen last time.
argument-hint: [--doctor]
allowed-tools: Bash(node *), Bash(git *)
---
Read the install source from `~/.config/model-gateway/last-install.json` (`source_dir` field). If it is missing, ask the user where they cloned break-free.

Then run:

```bash
node <source_dir>/setup.mjs --update
```

This does `git pull --ff-only` on the source and re-runs the installer non-interactively (`--yes`, with the saved scope/agents), keeping keys, models, aliases and every harness registration. The re-run prints its own PASS/WARN/FAIL verdict — report that verdict to the user. If `git pull` fails, the checkout has uncommitted changes or no upstream; the installer continues with the current files and says so. If anything FAILs, fix what it says before retrying.

After a successful update, remind the user to restart Claude Code / Codex (and any other wired harness) so they pick up the refreshed skills, commands and MCP registration.
