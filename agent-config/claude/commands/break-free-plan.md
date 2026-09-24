---
description: Decompose a goal into parallel tasks and run them on worker models via run_plan, with verification and review gates; you lead, they execute.
argument-hint: <goal>
allowed-tools: mcp__break-free-gateway, Bash(git diff *), Bash(git status *), Bash(git log *)
---

> Operations named below that are not in your tool list (the compact profile advertises only the execution tools) are called with `bf_invoke` - `{operation, arguments}` - and `bf_discover` lists every one with its schema.
Follow the `break-free-model-gateway` skill's "lead's loop" for: `$ARGUMENTS`

1. `ledger_resume` (create with `init:true` if missing). `code_map` if you don't know the codebase yet.
2. Decompose the goal into self-contained tasks with dependencies, a crisp acceptance criterion and a `verify` command each. Independent tasks must be able to run in parallel.
3. Write the instructions for each task (scope, files, constraints, what not to touch, how to verify). Pick per-task `model` (mix vendors; `fast` routine, `strong` hard, `local` private), least-privilege `capabilities` (include `run` for implementation work), `review:true` for behaviour changes, `supervise:true` where iteration is needed.
4. Show the user the plan in one compact table (task, model, capabilities, verify) and then call `run_plan` (`async:true` if it will take more than a few minutes; poll `job_status` with `wait_ms`).
5. Judge the consolidated report: gateway verification is ground truth; `git diff`; `review` important changes with a different vendor; push back via `delegate` + `session_id` where needed.
6. Update the ledger (`task_update`, `note_write` for decisions/gotchas), commit, and report: what was delegated to which model, what was verified, what remains.
