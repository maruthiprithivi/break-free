---
title: "firstmate integration design: what it fixes in the join (T-031)"
tags: [decision, finding]
created: "2026-09-19T17:14:54.193Z"
updated: "2026-09-19T17:14:54.193Z"
source: worker
---
# firstmate integration design: what it fixes in the join (T-031)

docs/firstmate-integration.md (T-031) draws the line: firstmate owns worktree lifecycle/crew spawning/watcher/fleet-sync/merge authority; break-free keeps routing+tiers, circuit breaker, gateway verify, review/panel, CI-run watching, and OWNS the new merge forecast. Key findings worth carrying forward:
- fm-merge-local.sh:111 is `git merge-base --is-ancestor` (ff-only) and refuses divergence, so a bad merge ORDER costs a mandatory manual rebase, not a detected conflict. Design: greedy order that prefers branches still ff-able against the accumulating base, ties broken by blast radius (codemap.ts:22 buildCodeMap, hubs at :91-93) then finish time; pairwise `git merge-tree --write-tree` predicts the rebase cost.
- worktrees.ts conflicts() (lines 250-265) must NOT be replaced outright: `git merge-tree` sees commits only, while changedFiles() also sees uncommitted work, so path overlap stays as the second signal. Add `mergeForecast()` + `MergePair.verdict` instead.
- worktrees.ts:179-186 marks "merged" by ancestry (rev-list base..HEAD == 0) — wrong for squash-merged PRs (fm-fleet-sync.sh:228-231); PR-merged branches stay "active" and keep claiming paths forever. Unresolved (listed in §5).
- surface: main() in index.ts branches on flags only (1405-1478), no worktree CLI verb, so the forecast belongs on an MCP tool (merge_forecast + additive field on worktree_list).
- broke-free Stop hook (setup.mjs:1146-1149 appends to the hooks.Stop array; blocking mode index.ts:1423-1448 blocks on ci.pending and running.jobs too) overlaps firstmate's turn-end hook. Recommendation: firstmate owns the block; break-free's --fleet-check goes back to reporting, and if a gate is kept, only ci.failed at the current HEAD.
- no changelog.d/ convention existed; fragment added at changelog.d/31-firstmate-design.md per the task instruction (CHANGELOG.md untouched).
