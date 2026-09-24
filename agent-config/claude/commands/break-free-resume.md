---
description: Resume long-running work — read the .break-free ledger handoff (tasks, blockers, decisions, recent activity) and propose the next moves.
allowed-tools: mcp__break-free-gateway, Bash(git status *), Bash(git log *)
---

> Operations named below that are not in your tool list (the compact profile advertises only the execution tools) are called with `bf_invoke` - `{operation, arguments}` - and `bf_discover` lists every one with its schema.
Call `ledger_resume`. If there is no ledger, say so and offer to create one (`init:true`) — do not invent state.

Then, from the brief and `git status`/`git log -n 10`: summarise where things stand in a few sentences, list what is ready to run (dependencies satisfied) and what is blocked and why, surface open decisions, and propose the next `run_plan` (which tasks, which models, verify commands). Collect results of any finished background jobs (`job_list` → `job_result`) and fold them into the ledger with `task_update`. Ask before starting anything that changes files.

Extra instructions: `$ARGUMENTS`
