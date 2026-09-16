---
description: Inspect the latest GitHub Actions run / deployment for this branch and troubleshoot to root cause if it failed (break-free-github-flow §4).
argument-hint: [run-id | workflow-file | branch]
allowed-tools: Bash(gh *), Bash(git *)
---
Current branch: !`git branch --show-current 2>/dev/null || true`
Recent runs: !`gh run list --limit 8 2>/dev/null || echo "(gh run list failed — is gh authenticated?)"`

Follow `break-free-github-flow` section 4 for `$ARGUMENTS` (default: the newest run on the current branch):
1. `gh run view <id>` and, if not successful, `gh run view <id> --log-failed`. Quote the actual failing step and error.
2. Diagnose the root cause (code vs workflow YAML vs secrets/permissions vs environment vs flaky). Say which, with evidence.
3. Propose or apply the fix; only re-run without changes if you can justify "transient".
4. If a deployment was involved, verify the deployment status and health endpoint separately from the workflow conclusion.
5. Record the outcome on the tracking issue (find it from the branch name / PR).
