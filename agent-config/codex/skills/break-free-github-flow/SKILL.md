---
name: break-free-github-flow
description: Break Free — work-tracking discipline on GitHub for every piece of engineering work — bug fix, feature, refactor, debugging, deployment, CI/workflow change. Use at the START of any coding task (find or create the tracking issue before touching code), at milestones (update the issue), on completion (close it out with what changed, how it was verified, deployment/CI state), and whenever a push, merge, deploy, or GitHub Actions run happens (watch it, and troubleshoot to root cause if it fails). Triggers: "fix", "implement", "add", "refactor", "debug", "deploy", "release", "CI is failing", "the workflow broke", "open a PR", "why did the action fail".
---

# break-free-github-flow: every unit of work is tracked, verified, and closed out on GitHub

You never do engineering work in this repository without a GitHub issue that says what is being done, why, how it will be tested, and — when finished — what actually changed and how it was verified. This is not bureaucracy: the issue is the audit trail that lets a solo founder or a small team see, weeks later, what happened and why. Do it quietly and consistently; don't ask the user whether to track, just tell them the issue number.

Prerequisite: `gh auth status` succeeds. If it doesn't, say so once and continue the work untracked — never block on it.

## 1. Start: find or create the issue (before any code changes)

1. Detect the repo: `gh repo view --json nameWithOwner -q .nameWithOwner`. Not a GitHub repo → skip this skill.
2. Look for an existing issue: `gh issue list --state open --search "<key words>" --json number,title,labels --limit 10`. Also check whether the user gave you a number or link. If one matches, use it and add a comment "Picking this up: <one-line plan>".
3. Otherwise create one from `templates/issue.md`:
   ```
   gh issue create --title "<type>: <concise imperative summary>" --label "<bug|enhancement|chore|ci|deployment>" --body-file <filled template>
   ```
   Fill every section honestly: **Problem / goal**, **Context** (files, error messages, repro), **Proposed approach**, **Test criteria** (the exact commands/checks that will prove it), **Success criteria** (what "done" means, observable), **Out of scope**. If you don't know something yet, write "TBD — will update after investigation" rather than inventing it.
4. Tell the user: "Tracking in #123".
5. Name things after it: branch `<type>/<num>-<slug>`, commits mention `(#num)`, PR body contains `Closes #num`.

Tiny changes (a typo, a one-line config tweak the user asked for directly) still get an issue, but a short one. The exception is work the user explicitly says is throwaway or exploratory; then say "not tracking this — tell me if you want an issue".

## 2. During: keep the issue truthful

Comment on the issue (`gh issue comment <num> --body-file …`) when something worth knowing happens: the plan changed, a decision was made, a blocker appeared, scope moved, an approach was abandoned and why. One comment per meaningful event — not a running log. If you delegate part of the work through `model-gateway`, pass the issue number in the task and require the worker to comment on the issue with what it did (workers with the `github` capability can).

## 3. Finish: close out with evidence

Before saying "done", post the completion comment from `templates/completion.md`: **What changed** (files, PR link, commits), **How it was verified** (the test criteria from section 1, each with the actual result — command output, not "tests pass"), **Deployment / CI state** (see section 4), **Known limitations / follow-ups** (open a separate issue for anything real). Then close: via the PR (`Closes #num` in the body → merge closes it) or `gh issue close <num> --comment "Done in <sha/PR>"`. If success criteria were NOT fully met, do not close — say what's missing and leave it open with a comment.

## 4. Deployments and GitHub Actions: watch, don't assume

Any push, merge, tag, or deploy you trigger has consequences you must observe:

1. `gh run list --branch <branch> --limit 5` (or `--workflow <file>`), then `gh run watch <id> --exit-status` for the run you caused. Report the conclusion on the issue.
2. Failure → root-cause it, don't re-run blindly: `gh run view <id> --log-failed`, read the actual error, reproduce locally if possible (`act`, or the same command the workflow runs), fix the cause (code, workflow YAML under `.github/workflows/`, secrets/permissions, runner image, caching), push, watch again. Re-run (`gh run rerun --failed`) only when the failure is clearly transient (network, rate limit) — and say that you judged it transient.
3. Deployments: check the deployment's own status, not just the workflow's — `gh api repos/{owner}/{repo}/deployments?per_page=3` and `…/deployments/<id>/statuses`, or the environment URL / health endpoint the workflow prints. "Workflow green" ≠ "deployed and healthy". Record the deployed SHA and the health check in the issue.
4. A red main branch is an incident: open/attach an issue labelled `ci`, fix or revert, and don't start unrelated work on top of it.

## 5. Working with the user

State the issue number early and the completion status at the end. Never paste secrets into issues or comments (tokens, keys, connection strings, full `.env` contents). Never close someone else's issue without saying why. If the user disagrees with tracking something, respect it once, for that task.

## Resources
- [templates/issue.md](templates/issue.md) — issue body
- [templates/completion.md](templates/completion.md) — completion comment
- Invoke explicitly with `$break-free-github-flow` at the start of a task, when a run fails, or when wrapping up; Codex also applies it automatically for matching tasks.

## Worktrees

If this checkout is a git worktree registered with the break-free gateway (`worktree_list`), record every issue you open/adopt and every PR you create on it: `worktree_update {name, issues:["#12"], prs:["#13"]}` — that is how main and the other agents see what this branch is doing. When the PR merges, `worktree_update {status:"merged"}` (or let the gateway detect it) and write a `worktree_handoff` if anything remains.

Before merging a PR from a worktree branch into main: on the main checkout run `ledger_merge_from {worktree, commit:true}` (or `ledger_resume`, which absorbs automatically) so the branch's tasks, notes and journal land in main's `.break-free/` first; the PR itself must not contain `.break-free/` changes (the `break-free ledger guard` workflow fails it if it does).
