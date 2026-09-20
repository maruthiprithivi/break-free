---
title: "Firstmate integration adversarial review: launch boundary and partial guarantees"
tags: [finding]
created: "2026-09-20T14:27:20.219Z"
updated: "2026-09-20T14:27:20.219Z"
source: orchestrator
trust: lead
---
# Firstmate integration adversarial review: launch boundary and partial guarantees

Read-only review for issue #31, 2026-09-20. Recommendation, not a user-approved design decision: ship optional managed primary-harness launcher (automated option b), explicitly firstmate-led; retain standalone break-free. MCP connection alone cannot instantiate the distro. fm-session-start.sh leaves supervision to the harness and reports lock refusal with exit 0. fm-lock.sh:54 requires harness ancestry; fm-guard.sh:39 is warning-only. Script execution is feasible but does not inherit policy: fm-merge-authority-lib.sh:54 resolves no-away-record to attended, and fm-merge-local.sh checks holds/clean FF but relies on caller for explicit approval. Ordinary ship/scout cannot delegate (user-verified); --secondmate is a distinct supervisor role with seeded home/charter/parent channel, not a flag that makes a generic gateway worker a nested lead. FM_HOME and code root are separate; one shared code install does not imply one operational session or gateway instance. Firstmate crew routing and delivery remain firstmate-owned; gateway guarantees apply only on actual gateway paths. Existing serve.ts:161-191 chooses provider then fetches directly, not the full tier-floor/breaker/fallback pipeline. Proposed provider-transport integration would avoid worker delegation but needs implementation and cannot itself provide task verification/review. firstmate.ts currently detects/plans, not runtime orchestration: plan target is not bound to update command; status does not establish active/loaded revision or clean pin; instruction filter omits docs and harness hooks/extensions; parse failures can appear as empty safe results. config.ts enabled defaults true; recommend explicit opt-in and false for fresh installs. No source edits or runtime fleet tests. gh auth status failed, so no issue comment was posted.
