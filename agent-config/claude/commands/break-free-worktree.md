---
description: Multi-agent worktrees — list what every worktree/agent is doing, claim this checkout, create one for another agent, or write a hand-off.
argument-hint: [list|claim|create <branch> <purpose>|handoff <note>|status <name> <status> <reason>]
allowed-tools: mcp__break-free-gateway, Bash(git worktree *), Bash(git status *), Bash(git branch *)
---
Follow the `break-free-model-gateway` skill's "Parallel agents & worktrees" section for: `$ARGUMENTS`

- no args / `list` → `worktree_list` and summarise: who is where, status + reason, open PRs/issues, last hand-offs; flag inactive/abandoned ones and anything merged that can be removed.
- `claim` → `worktree_register` for this checkout with purpose, agent (say which tool you are), ledger tasks, issues, tools, models.
- `create <branch> <purpose>` → `worktree_create`, then print the path and the one-line instruction to give the other agent (including `ledger_resume` first).
- `handoff <note>` → `worktree_handoff` with done / not done / next steps / verify / gotchas; add durable gotchas via `note_write`.
- `status <name> <status> <reason>` → `worktree_update`.
Finish with `worktree_sync` when on the main checkout.
