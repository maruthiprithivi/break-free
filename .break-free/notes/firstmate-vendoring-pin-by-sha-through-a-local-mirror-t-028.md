---
title: "firstmate vendoring: pin by SHA through a local mirror (T-028 decision)"
tags: [decision, gotcha]
created: "2026-09-19T16:24:11.948Z"
updated: "2026-09-19T16:24:11.948Z"
source: worker
---
# firstmate vendoring: pin by SHA through a local mirror (T-028 decision)

fm-update.sh CANNOT be told a target: it takes zero args (`[ $# -eq 0 ]`, fm-update.sh:86) and hardcodes `ff_target "$FM_ROOT" "firstmate" origin no no` (line 91), so it always installs origin/<default>'s live tip — after its own `git fetch origin --prune --quiet` (fm-ff-lib.sh:218, 390-399). But ff_target supports an arbitrary local commit as base (`base_mode` = commit-ish, fm-ff-lib.sh:354-361) and fm-update.sh honours FM_ROOT_OVERRIDE/FM_HOME (lines 68-72).

Decision: break-free owns WHICH commit and WHEN; upstream owns HOW to move a checkout. Give the live clone (and every secondmate home) an `origin` that is a break-free-controlled bare MIRROR; fetch upstream only into the mirror; move the mirror's refs/heads/main only to an approved SHA; then run the UNMODIFIED revisions/<sha>/bin/fm-update.sh with FM_ROOT_OVERRIDE + FM_HOME set explicitly. Its fetch then resolves origin/<default> to the pin, so primary + all secondmate homes converge to the approved revision in one pass, no fork.

Gotchas: (1) fast-forwards cannot go backwards — rollback must be a revision-symlink swap, not a mirror rewind (ff_target reports `skipped: diverged` instead, ff-lib.sh:438-468); (2) FM_HOME must be OUTSIDE the revision dir, else a revision swap hides the user's state/data/backlog; (3) always pass FM_ROOT_OVERRIDE explicitly — relying on the script's own location is a documented trap (fm-update.sh:99-104); (4) fm-guard.sh (called at line 78) writes state under FM_HOME, so never dry-run a candidate against the live home.
