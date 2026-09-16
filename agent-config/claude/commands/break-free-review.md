---
description: Independent code review of the current diff (or a PR/branch) by a different model via model-gateway.
argument-hint: [staged|HEAD|main...HEAD|<ref>] [focus]
allowed-tools: mcp__break-free-gateway__review, mcp__break-free-gateway__list_models, Bash(git diff *), Bash(git status *), Bash(git log *)
---
Current status:
!`git status --short | head -50 || true`

Arguments: `$ARGUMENTS`. First word (if it looks like a git ref or `staged`) → `use_git_diff`; default `HEAD` if there are unstaged changes, else `main...HEAD`. Remaining words → `focus`.

Call `review` with `model:"reviewer"` (or a vendor different from whoever wrote the code), `task_description` = what the change is meant to do (ask the user or infer from commits), and `subject` = a one-paragraph description of the change. Then:
- Present the verdict and issues grouped by severity, each with file:line.
- For every critical/major issue, check it yourself against the code before repeating it — reviewers can be wrong.
- Offer to fix the confirmed issues.
