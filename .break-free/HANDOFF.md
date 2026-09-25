# Handoff

_Generated 2026-09-23T11:12:28.575Z. Read this first when resuming work in this repository._

## Where things stand
- 36 tasks total: todo 0, in_progress 0, blocked 4, review 1, done 31, cancelled 0
- BLOCKED T-032 Fix GitHub issue #91 in this repo: the fleet cursor file grows forever. — last: 2026-09-23T11:06:44.728Z failed: rejected by reviewer (deepseek/deepseek-flash): The diff does not implement issue #91 at all: model-gateway/src/fleet.ts is untouched (Cursors still has only baseline + byWorkspace, drainTo writes no timestamp, pruneQueue has no retirement), and model-gateway/test/cursor-retire.test.mjs does not exi
- BLOCKED T-033 Fix GitHub issues #80 and #81 in this repo, both in model-gateway/src/client.ts. They are the same c — last: 2026-09-23T11:06:38.615Z failed: rejected by reviewer (deepseek/deepseek-flash): The diff under review does not implement the task at all. It modifies model-gateway/src/context.ts (plus .break-free state files) — that is the sibling T-034 'context cost breakdown' work — while model-gateway/src/client.ts and model-gateway/test/first
- BLOCKED T-035 Fix GitHub issue #91 in model-gateway/src/fleet.ts. A previous attempt produced NO file writes at al — last: 2026-09-23T11:12:28.553Z cancelled: deepseek/deepseek-v4-pro: This operation was aborted
- BLOCKED T-036 Fix GitHub issues #80 and #81 in model-gateway/src/client.ts. A previous attempt produced NO file wr — last: 2026-09-23T11:12:28.566Z cancelled: deepseek/deepseek-v4-pro: This operation was aborted
- NEEDS REVIEW T-030 Build the A/B harness that issue #22 needs. The issue says criteria 2, 3, 8 and 11 are unmeasured be

## Ready to start or retry (dependencies satisfied)
- T-032 Fix GitHub issue #91 in this repo: the fleet cursor file grows forever.
- T-033 Fix GitHub issues #80 and #81 in this repo, both in model-gateway/src/client.ts. They are the same c
- T-035 Fix GitHub issue #91 in model-gateway/src/fleet.ts. A previous attempt produced NO file writes at al
- T-036 Fix GitHub issues #80 and #81 in model-gateway/src/client.ts. A previous attempt produced NO file wr

## Open tasks
- T-030 [review] Build the A/B harness that issue #22 needs. The issue says criteria 2, 3, 8 and 11 are unmeasured be
- T-032 [blocked] Fix GitHub issue #91 in this repo: the fleet cursor file grows forever.
- T-033 [blocked] Fix GitHub issues #80 and #81 in this repo, both in model-gateway/src/client.ts. They are the same c
- T-035 [blocked] Fix GitHub issue #91 in model-gateway/src/fleet.ts. A previous attempt produced NO file writes at al
- T-036 [blocked] Fix GitHub issues #80 and #81 in model-gateway/src/client.ts. A previous attempt produced NO file wr

## Worker notes awaiting your review (not injected until promoted)
- [[notes/context-cost-breakdown-api-t-034-issue-47-measurement-half|context cost breakdown API (T-034, issue #47 measurement half)]] — note_review {slug:"context-cost-breakdown-api-t-034-issue-47-measurement-half", action:"promote"|"reject"}

## Decisions, conventions & gotchas
- [[notes/firstmate-standing-rule-coverage-in-setup-mjs-installfirstma|firstmate standing rule coverage in setup.mjs (installFirstmate)]] — Superseded by #122: no Firstmate standing rule is written; stripLegacyFirstmateRules removes old FM_MARKER blocks from every instruction file on install and uninstall.
- [[notes/firstmate-integration-design-what-it-fixes-in-the-join-t-031|firstmate integration design: what it fixes in the join (T-031)]] — docs/firstmate-integration.md (T-031) draws the line: firstmate owns worktree lifecycle/crew spawning/watcher/fleet-sync/merge authority; break-free keeps routi
- [[notes/firstmate-vendoring-pin-by-sha-through-a-local-mirror-t-028|firstmate vendoring: pin by SHA through a local mirror (T-028 decision)]] — fm-update.sh CANNOT be told a target: it takes zero args (`[ $# -eq 0 ]`, fm-update.sh:86) and hardcodes `ff_target "$FM_ROOT" "firstmate" origin no no` (line 9
- [[notes/merge-time-analysis-primitives-and-the-fm-gateway-join-gap|Merge-time analysis primitives and the fm<->gateway join gap]] — T-029 (analysis only, no files changed). Established by reading:
- [[notes/tier-floor-wording-tierfor-precedence|Tier floor wording + tierFor precedence]] — router.resolveCandidatesWithFloor throws `no candidate at or above tier N — skipped spec (tier X); raise min_tier, set allow_downgrade, or add a tier N provider

## Other notes
- [[notes/context-cost-breakdown-api-t-034-issue-47-measurement-half|context cost breakdown API (T-034, issue #47 measurement half)]] (howto, finding, context)
- [[notes/firstmate-integration-adversarial-review-launch-boundary-and|Firstmate integration adversarial review: launch boundary and partial guarantees]] (finding)

## Recent activity
- 2026-09-19 16:22:00 run_plan started: 3 task(s) — Integration analysis: break-free wrapping firstmate for fleet and worktree coordination (issue #31) (T-027, T-028, T-029)
- 2026-09-19 16:23:30 boundary (T-027) done by deepseek/deepseek-flash
- 2026-09-19 16:24:03 worktrees (T-029) done by deepseek/deepseek-flash
- 2026-09-19 16:24:42 run_plan completed: 3/3 done
- 2026-09-19 16:24:42 update (T-028) done by deepseek/deepseek-flash
- 2026-09-19 17:13:13 run_plan started: 2 task(s) — Open items: #22 routing A/B harness and #31 firstmate integration design (T-030, T-031)
- 2026-09-19 17:16:18 firstmate-design (T-031) done by deepseek/deepseek-flash, review approve
- 2026-09-19 17:20:49 ab-harness (T-030) done by deepseek/deepseek-flash, review revise
- 2026-09-19 17:20:49 run_plan completed: 2/2 done
- 2026-09-20 11:01:01 handoff from worktree main [inactive]: Completed source/design review of break-free plus read-only .firstmate versus Devin claim. Read all four requested docs; checked gateway supervise/runPlan/verif
- 2026-09-20 12:24:59 handoff from worktree main [inactive]: Completed read-only adversarial MCP-to-CLI design review. Confirmed 53 tools / 8725 proxy schema tokens; current context_report total 10489 varies with ledger.
- 2026-09-20 14:27:25 handoff from worktree main [inactive]: Completed requested adversarial native-firstmate design review from source, taking user's four verified constraints as given. Recommend optional managed primary
- 2026-09-23 11:04:48 run_plan started: 3 task(s) — Three independent gateway fixes on disjoint files: cursor retirement (#91), first-byte/body-stall deadlines (#80, #81), and context cost measurement (#47) (T-032, T-033, T-034)
- 2026-09-23 11:06:38 deadlines (T-033) FAILED: rejected by reviewer (deepseek/deepseek-flash): The diff under review does not implement the task at all. It modifies model-gateway/src/context.ts (plus .break-free state files) — that is the sibling
- 2026-09-23 11:06:42 cost (T-034) done by deepseek/deepseek-flash, review approve
- 2026-09-23 11:06:44 cursor (T-032) FAILED: rejected by reviewer (deepseek/deepseek-flash): The diff does not implement issue #91 at all: model-gateway/src/fleet.ts is untouched (Cursors still has only baseline + byWorkspace, drainTo writes no
- 2026-09-23 11:06:44 run_plan INCOMPLETE: 1/3 done
- 2026-09-23 11:07:54 run_plan started: 2 task(s) — Retry #91 cursor retirement and #80/#81 deadlines - disjoint files, no per-task review (lead reviews and verifies in Docker) (T-035, T-036)
- 2026-09-23 11:12:28 cursor (T-035) cancelled: deepseek/deepseek-v4-pro: This operation was aborted
