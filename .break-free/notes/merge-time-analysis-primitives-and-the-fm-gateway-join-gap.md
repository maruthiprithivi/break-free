---
title: Merge-time analysis primitives and the fm<->gateway join gap
tags: [finding, gotcha, decision]
created: "2026-09-19T16:23:28.486Z"
updated: "2026-09-19T16:23:28.486Z"
source: worker
---
# Merge-time analysis primitives and the fm<->gateway join gap

T-029 (analysis only, no files changed). Established by reading:

- fm-merge-local.sh:111-115 refuses any non-fast-forward ("REFUSED: ... it has diverged", "have the crewmate rebase"). It never performs a merge, so it has zero conflict detection — the conflict the user feels is discovered later, during the mandated rebase.
- The existing overlap primitive is path-set only: model-gateway/src/worktrees.ts:250-265 conflicts() intersects changedFiles() sets (worktrees.ts:240-247, `git diff --name-only <base>...HEAD` + `git status --porcelain`) and declared glob claims. It never runs a three-way merge, so it cannot say whether two branches that touch the same file actually conflict.
- Reverse-dependency data already exists: codemap.ts:91-93 computes importedBy for hubs and keeps the raw edge list in CodeMap.modules (codemap.ts:22-123). Tests are deliberately filtered OUT of the map (codemap.ts:39), so test ownership needs `git grep -l <module> -- '*test*'` or an unfiltered scan.
- Join gap: fm-spawn writes worktree=<path> into $FM_HOME/state/<id>.meta (fm-spawn.sh:285 placeholder, :358 printed), while the gateway registry (.git/break-free/worktrees.json, worktrees.ts:105-109) is keyed by branch/worktree name with ledger task ids in tasks[] (worktrees.ts:37). Nothing joins fm task id <-> gateway worktree record <-> branch.
- Squash merges make ancestry useless for "landed" (fm-fleet-sync.sh:228-231); trust recorded state, not `merge-base --is-ancestor`.
- Sandbox gotcha: `git --version` is refused by the workers.allowedCommands allow-list, and git_diff ref="--version" is rejected ("ref must not start with '-'"). Git version/layout of `git merge-tree --write-tree` could NOT be verified here; a new tool must probe at runtime and degrade.
