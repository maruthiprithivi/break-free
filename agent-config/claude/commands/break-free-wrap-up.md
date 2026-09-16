---
description: Close out the tracking issue for the current work with what changed, how it was verified, and CI/deploy state (break-free-github-flow §3).
argument-hint: [issue-number]
allowed-tools: Bash(gh *), Bash(git *)
---
Branch: !`git branch --show-current 2>/dev/null || true`
Recent commits: !`git log --oneline -8 2>/dev/null || true`
Working tree: !`git status --short 2>/dev/null | head -20 || true`

Follow `break-free-github-flow` section 3 for issue `$ARGUMENTS` (if empty, infer it from the branch name `<type>/<num>-…` or the open PR):
1. Re-read the issue's test and success criteria (`gh issue view <num>`).
2. Run or re-check each test criterion NOW; paste real results into the completion comment (`templates/completion.md`). Include the workflow run conclusion and deployment state if any push/merge happened.
3. If every success criterion is met: post the comment and close the issue (or confirm the PR's `Closes #num` will). If not: post the comment, keep it open, and tell the user exactly what remains.
