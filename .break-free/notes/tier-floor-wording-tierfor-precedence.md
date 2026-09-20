---
title: Tier floor wording + tierFor precedence
tags: [decision, gotcha]
created: "2026-09-18T09:22:26.789Z"
updated: "2026-09-18T09:22:26.789Z"
source: worker
---
# Tier floor wording + tierFor precedence

router.resolveCandidatesWithFloor throws `no candidate at or above tier N — skipped spec (tier X); raise min_tier, set allow_downgrade, or add a tier N provider`. The task's example literally says "raise min_tier" even though lowering is the semantically correct remedy; kept verbatim to match the spec/tests. tierFor mirrors priceFor exactly: merged table ({...DEFAULT_TIERS, ...config.tiers}), then exact "provider/model" key before "provider" key, default 2 — so a user provider-level tier does NOT override a DEFAULT exact-model tier (same behavior as pricing).
