---
description: Find or create the GitHub issue that tracks the current task (break-free-github-flow), before touching code.
argument-hint: [issue-number | short description]
allowed-tools: Bash(gh *), Bash(git *)
---
Follow the `break-free-github-flow` skill, section 1, for: $ARGUMENTS

- If `$ARGUMENTS` is a number or issue URL, use that issue: read it (`gh issue view`), comment that you're picking it up with a one-line plan.
- Otherwise search open issues for a match; if none, create one from the skill's `templates/issue.md` with every section filled from what you know about the task (repo context: !`git remote get-url origin 2>/dev/null || true`, branch: !`git branch --show-current 2>/dev/null || true`).
- Report the issue number and the branch name you will use (`<type>/<num>-<slug>`).
