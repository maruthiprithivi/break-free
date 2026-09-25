# break-free wrapping firstmate — integration design (issue #31)

Status: **design, no implementation.** This document changes no source file. It records the
split of ownership between break-free and the vendored firstmate distro, how that distro is
pinned and updated, the one capability the join is missing (merge coordination), the
collisions that are still open, and what is not decided.

Non-goals, stated once and applied everywhere below: firstmate is **never forked**
(third-party, `github.com/kunchenguid/firstmate`), and break-free **never rebuilds** something
firstmate already provides. Where firstmate has a capability, break-free calls it or drops its
own version.

Provenance convention used throughout: **[read]** = I read it in this task; **[given]** =
stated as verified in the task brief and not re-derived here; **[unverified]** = not checked,
so it is listed as open rather than asserted.

---

## 1. Ownership

`after` = who owns the capability once the integration lands. "The artifact" names the file
that implements it, in whichever repo owns it.

| Capability | Owner after integration | Implementing artifact |
|---|---|---|
| Distro content: `AGENTS.md`, skills, ~410 shell scripts the harness follows | **firstmate** (vendored, pinned by sha — §2) | the managed firstmate checkout; break-free never edits it in place |
| Worktree lifecycle (create / lease / release, pool slots, project lock) | **firstmate** | `bin/fm-spawn.sh` via treehouse **[given]** |
| Crew spawning into terminals (tmux / Herdr / cmux / zellij / Orca) | **firstmate** | `bin/fm-spawn.sh` + its backend shims **[given]** |
| Fleet supervision + watcher | **firstmate** | `bin/fm-watch-arm.sh` **[given]** |
| Fleet sync + branch pruning | **firstmate** | `bin/fm-fleet-sync.sh` **[given]** |
| Merge authority (who may merge, crewmate release hold) | **firstmate** | `bin/fm-merge-authority-lib.sh`, `bin/fm-merge-local.sh` **[given]** |
| Model routing, tiers, the tier floor | **break-free** | `model-gateway/src/router.ts` (`resolveCandidatesWithFloor`); firstmate has no router **[given]** |
| Per-provider circuit breaker | **break-free** | breaker reported at `model-gateway/src/index.ts:1411` (`getBreaker(ctx.config).list()`) and consulted by the router **[read: the call site]** |
| Gateway-run verification | **break-free** | `runCommand` / verify in the run's own tree **[given]** |
| Cross-vendor review / panel / tripwire | **break-free** | `review`, `panel` MCP tools (`index.ts:606-647`) **[read]** |
| CI run watching (Actions runs — not actionlint) | **break-free** | `--fleet-check` + `fleetCheck()` (`index.ts:1422-1455`) **[read]**; upstream `bin/fm-lint-workflows.sh` is actionlint, not run watching **[given]** |
| Merge-conflict **prediction** and **merge ordering** | **break-free** (new — nobody has it) | `WorktreeRegistry` in `model-gateway/src/worktrees.ts:250-265`, upgraded per §3 |
| Worktree registry / cross-worktree observability | **break-free** (read-only view over firstmate-created worktrees) | `model-gateway/src/worktrees.ts:99-358`; registry `<repo>/.git/break-free/worktrees.json` (`worktrees.ts:105-109` **[read]**) |
| Ledger (`tasks/`, `notes/`, journal) and the guard keeping it off feature branches | **break-free** | `worktrees.ts:361-448` (`installGuardHook`, `LEDGER_GUARD_WORKFLOW`) **[read]** |

### Rows break-free drops, and what happens to the code it drops

| Dropped capability | File + symbol | Disposition |
|---|---|---|
| Worktree **creation / removal** (the registry itself stays) | `model-gateway/src/worktrees.ts` — `WorktreeRegistry.create()` (line 295) and `remove()` (line 309) **[read]** | **Delegate behind a flag; do not delete yet.** `worktree_create` / `worktree_remove` (`index.ts:1290-1314` **[read]**) keep their names so existing agent prompts do not change, but route to firstmate `fm-spawn.sh` when the distro is present. New config `worktrees.lifecycle = "firstmate" \| "local"` (default `firstmate`). `register()` / `update()` / `reconcile()` / `render()` stay local — that is the registry, which firstmate does not provide. Callers of `create()`/`remove()` beyond those two MCP tools are **[unverified]**, which is why this is a flag and not a deletion. |
| Crew spawning into terminals | `model-gateway/src/harnessctl.ts` — `HarnessController.spawn` / `.close`, exposed as `harness_spawn` / `harness_close` (`index.ts:1360-1396`) **[read]** | **Deprecate the tool surface behind a flag** (`tools.harnessSpawn`, default off when the distro is present); announce in the tool description for one release, then remove. Keep the module: `orchestrate.ts:19,35` holds `HarnessController` in the gateway context **[read]** and other callers are **[unverified]**. |
| Any break-free worktree pool / project lock | — | **None found.** I searched `model-gateway/src` only; elsewhere in the repo is **[unverified]**. If one exists it is deleted, not kept. |
| Any break-free merge authority | — | **None exists.** `worktrees.ts` never merges, and `mergeSummary(absorbWorktreeLedgers())` (`index.ts:1309` **[read]**) absorbs *ledger* state, not branches. Nothing to drop; §3 therefore stays advisory and never becomes a second merge authority. |

Nothing above forks or reimplements a firstmate capability: the two dropped items are the only
break-free code that overlaps firstmate at all.

---

## 2. Where the distro lives, and how it updates

> Superseded (#123): break-free no longer installs, pins, updates or launches Firstmate.
> Firstmate owns its own lifecycle; this section is kept as the design record only.

### One managed location, not one per repo

```
$BREAK_FREE_HOME/firstmate/            # the vendored checkout (a clone, never a fork)
  pin                                  # the approved commit sha + who approved it + when
  mirror/firstmate.git                 # bare mirror of upstream — the only thing that fetches upstream
  revisions/<sha>/                     # a checkout of each approved commit, kept as a rollback target
  active -> revisions/<sha>            # symlink: the revision currently installed
```

Every firstmate home on the machine — the primary and every secondmate home — is given **one
shared `origin`: the bare mirror**, never `github.com/kunchenguid/firstmate`. Upstream is
fetched **only** into the mirror. That is the supply-chain gate this section exists for: an
upstream push to its default branch would otherwise become the instructions the user's agent
obeys, unreviewed. With the mirror in between, nothing upstream publishes reaches a running
agent until a human moves the pin.

### Pinning

- `pin` holds one line: `<sha> <approved-by> <date>`, plus the upstream tag/date for humans.
- The mirror's `refs/heads/main` moves **only** to the pinned sha
  (`git -C mirror/firstmate.git update-ref refs/heads/main <sha>`), never by `git pull`.
- `FM_ROOT_OVERRIDE` and `FM_HOME` are set explicitly on every invocation. `fm-update.sh:69-72`
  **[read]** reads `FM_ROOT="${FM_ROOT_OVERRIDE:-…}"`, `FM_HOME="${FM_HOME:-…}"`,
  `STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"`, so the distro's own tooling can be aimed at a
  managed home with no upstream patch.

### Moving the tree: break-free decides WHICH commit, firstmate moves the tree

`fm-update.sh` takes **no arguments** (`[ $# -eq 0 ] || { usage; exit 1; }`, `fm-update.sh:86`
**[read]**) and hardcodes its base: `ff_target "$FM_ROOT" "firstmate" origin no no`
(`fm-update.sh:91` **[read]**). It therefore cannot express a pin by itself. The pin is
expressed in the mirror's `refs/heads/main`, and then the **unmodified**
`revisions/<sha>/bin/fm-update.sh` is run with `FM_ROOT_OVERRIDE` and `FM_HOME` set. Its own
`git fetch origin` then resolves `origin/<default>` to the pinned commit, and the primary home
plus every secondmate home converge in one pass. No fork, no patch, and no second
implementation of fast-forwarding (which lives once, in `fm-ff-lib.sh`, shared by every update
path). Its parseable summary (`reread-firstmate: yes|no`, `restart-secondmates:`,
`nudge-secondmates:` — `fm-update.sh:244-246` **[read]**) is what tells break-free whether the
instructions changed and whether live mates must be restarted.

### What a human sees before it goes live

1. **Fetch, never install:** `git -C mirror/firstmate.git fetch upstream` (mirror only).
2. **Show the instruction surface first, not just the diff stat.** The files the agent obeys
   are the ones that matter: `AGENTS.md`, `skills/`, agents/commands definitions, any hook
   installer, and `bin/`. The preview prints, for `<pin>..<candidate>`: the commit list, a
   `--stat` of the whole diff, and a **separate** full diff of the instruction surface, with a
   count of scripts under `bin/`.
3. **Say what it implies:** `reread-firstmate: yes` means a running agent's instructions change
   and every live mate must be restarted; that line is printed as part of the preview, not only
   after the fact.
4. **Approve one sha.** Approval writes `pin`, materialises `revisions/<sha>/`, flips `active`,
   then runs that revision's own `fm-update.sh`.
5. **Report after:** each home's own status line (`updated` / `already current` / `skipped`)
   is surfaced, and a `skipped` home (dirty or diverged) is reported as a failure to converge —
   never quietly healed.

### What must never be auto-applied

- **Never** move the pin automatically. A scheduled fetch may populate the mirror; only a human
  (or an explicit `bf firstmate approve <sha>` invocation by a human) may write `pin` and move
  `refs/heads/main`.
- **Never** auto-apply a candidate whose instruction surface changed without showing that diff
  and the resulting `reread-firstmate` value first.
- **Never** auto-apply anything when a mate's own status is `skipped` (dirty, diverged,
  offline): that is a `skipped` report plus the divergence record, never a force.
- **Never** `git reset --hard`, `--force`, `stash`, or `clean` a firstmate home. `fm-update.sh`
  itself never does (its header states fast-forward only, never force, never stash
  **[read: fm-update.sh:1-12]**), and break-free must not add one around it.
- **Never** auto-touch `data/`, `state/`, `config/`, `projects/`, `.no-mistakes/`: `fm-update.sh`
  leaves them alone **[read: fm-update.sh:13-15]** and break-free's update path must not move
  state in or out of them.
- **Never** auto-apply a **rollback**. A rollback is not a mirror rewind — see below.
- **Never** install a revision whose scripts have not come from the pinned sha (i.e. never run a
  "hot patched" copy of `fm-update.sh` or any other `bin/` script out of band).

### Rollback

Fast-forwards cannot go backwards: `ft_target` reports `skipped: diverged` rather than rewinding
(the brief's T-028 gotcha, **[given]**). So rollback is a **revision-symlink swap**, not a ref
rewind:

- `revisions/<sha>/` for the previous N approved revisions are kept (checkout of the mirror at
  that sha, read-only, so `bin/` scripts of the old revision are still runnable).
- Rollback = point `active` back at the previous revision, re-point the mirror's
  `refs/heads/main` to the same sha, and re-run **that** revision's own `fm-update.sh` — which
  is a fast-forward in the mirror's terms only if the homes are behind; otherwise those homes
  are `skipped: diverged` and are replaced by re-materialising their checkout at the target sha
  (one `git worktree`/`checkout` operation, not a force-reset of a tree with local work).
- Record the rollback in the pin file and in the ledger journal, and restart mates exactly as an
  update does.

---

## 3. Merge coordination

The problem: five worktrees finish at different times. Merging them back has no visibility —
`bin/fm-merge-local.sh` is fast-forward only (`git merge-base --is-ancestor "$DEFAULT" "$BRANCH"`,
`fm-merge-local.sh:111`; on failure it prints `REFUSED: … it has diverged` and
`Have the crewmate rebase …`, lines 112-113 **[read]**). It never performs a merge, so it has
zero conflict detection: the conflict is discovered later, during the mandated rebase.
`bin/fm-fleet-sync.sh` never compares two branches **[given]**. And ancestry cannot prove
"landed": PRs in this fleet are squash-merged (`fm-fleet-sync.sh:228-231` **[given]**), so a
merged branch is never an ancestor of the default branch.

### 3a. Upgrade `conflicts()` from path intersection to a real merge probe

**The function to change:** `WorktreeRegistry.conflicts()` in
`model-gateway/src/worktrees.ts:250-265` **[read]**. Today it intersects `changedFiles()`
(`worktrees.ts:240-247` **[read]** — `git diff --name-only <base>...HEAD` plus
`git status --porcelain`) and declared glob claims, so it reports an overlap whenever two
branches touch a common path, whether or not the merge is clean.

Design:

- **Keep** the path-overlap signal. It is cheap, and it is the only signal that sees
  **uncommitted** work: `git merge-tree` sees commits only, so an uncommitted edit in a
  worktree is invisible to a merge probe. The two signals are complementary, not alternatives.
- **Add** a per-pair merge probe using `git merge-tree --write-tree` (in-memory, no worktree,
  no checkout; 15 branch pairs in 1s on this repo, git 2.50.1 **[given]**), run through the
  existing `tryGit()` helper (`worktrees.ts:70-72` **[read]**) in `this.root`.
- **Add** `WorktreeRegistry.mergeForecast()` as the new public entry point, and have
  `conflicts()` delegate to the same internal per-pair function so `summary()`
  (`worktrees.ts:350-353`) and `worktree_list` (`index.ts:1258`) can show a verdict instead of
  an overlap.

Return shape (extended, additive so existing consumers do not break):

```ts
export interface MergePair {
  a: string;                      // worktree name
  b: string;                      // worktree name
  verdict: "clean" | "conflict" | "unknown";
  probe: "merge-tree" | "path-overlap";   // how the verdict was reached
  conflicted: string[];           // paths git reported as conflicting (conflict only)
  overlap: string[];              // old signal: paths both branches changed
  claims: string[];               // old signal: declared glob claims that collide
  ff: boolean;                    // is `a`'s branch an ancestor of `b`'s branch (merge-base --is-ancestor)
  error?: string;                 // probe could not run (missing branch, old git, delete/modify)
}

export interface MergeForecast {
  base: string;                   // integration branch probed against
  order: { name: string; ffNow: boolean; cleanVsBase: boolean; blast: Blast; links: MergePair[] }[];
  stuck: string[];                // no probed order starts clean — hand to a human with paths
  probes: MergePair[];
}
```

Per-pair probe, concretely: `git merge-tree --write-tree <branchA> <branchB>`; exit 0 means the
merge result is a real tree and the pair is clean, exit 1 means conflicts and the output names
them. Cache per (a, b, tip-sha) so five worktrees cost at most ten pairs per refresh.
**[unverified]** the exact parse of the conflicted-path list on the installed git (2.50.1) and
whether a *tree oid* is accepted as a `merge-tree` argument — both are needed for the cumulative
simulation in 3b, and must be pinned down by a small test before implementation. Note also that
a delete/modify or rename conflict can be reported as an informational message even when the
probe succeeds; the implementation must not treat those as hard conflicts without checking.

### 3b. Merge order rule

**Rule (greedy, recomputed per step):** maintain `base` (initially the integration branch).
Repeat until no branch remains:

1. Compute `ffNow` for every remaining branch: `git merge-base --is-ancestor <base> <branch>`
   — exactly the test `fm-merge-local.sh:111` will apply.
2. Prefer branches with `ffNow = true` — those are the merges that need **no rebase** and
   therefore cannot stall.
3. Among the `ffNow = true` set, verify `merge-tree --write-tree <base> <branch>` is clean
   (a fast-forward is trivially clean, but a branch that is both an ancestor *and* has
   followed-up work is not; keep the check).
4. Among the clean candidates, pick **smallest blast radius first** (3c), tie-broken by earliest
   branch head commit time — i.e. "first to finish goes first" once risk is equal.
5. Advance `base` to the merge result and repeat.
6. If no remaining branch is clean, the rest are mutually conflicting: pick the one with the
   fewest conflicted paths (fewest hunks) and hand it to a human with the exact conflicted
   paths.

Justification: the cost of a bad order is not a merge conflict in git's hands — it is a
**mandatory manual rebase**, because `fm-merge-local.sh:111-115` refuses anything that is not a
fast-forward **[read]**. So the objective that actually reduces human work is "maximise the
number of branches that are still fast-forwardable when their turn comes", and the secondary
question — what the mandated rebase will cost — is exactly what `merge-tree` predicts: two
branches that merge cleanly as a pair will rebase cleanly onto each other (the three-way merge
is the same computation). Ancestry is used here **only** for ff-ability of a branch against the
current base, never as evidence that work landed; "landed" for squash-merged PRs is a separate,
unsolved question (§5).

### 3c. Blast radius per merge

`model-gateway/src/codemap.ts` **exists** **[read]**: `buildCodeMap()` (`codemap.ts:22`) returns
`CodeMap` (`codemap.ts:12-18`) with `modules: Record<string, { imports, symbols, lines }>` and
`hubs: { module, importedBy }[]`, where the reverse edge count is computed at `codemap.ts:91-93`.

Per candidate merge, the blast radius is computed from that map plus the branch's diff:

- `files`: count of files changed by the branch (from `changedFiles()`, `worktrees.ts:240-247`).
- `importers`: for each changed file, map path → module (`modOf`, `codemap.ts:45`), sum the
  reverse edges (`modules[*].imports` containing it) — i.e. how many other modules import
  something this merge changes. `hubs` (`codemap.ts:93`, top 15) flags "this merge touches a hub".
- `tests`: `git grep -l <module> -- '*test*'` for changed modules. Necessary because
  `codemap.ts:39` deliberately filters test files out of the map, so test ownership is invisible
  to the map itself.
- Score: `importers` as the primary number, `touchesHub` as a boolean escalation, smaller is
  merged earlier. A merge that touches a hub is never merged before a smaller one that is
  equally clean.

Honest limitations to carry into the implementation: `buildCodeMap()` indexes the **current
checkout** (`git ls-files`, `codemap.ts:25`), so files that exist only on a branch are absent
from the map; the radius for those degrades to a path/directory heuristic. There is no
per-file → importer index in `CodeMap`, only module → imports; a small addition (or a parallel
scan) is required to answer "which modules import *this file*".

### 3d. User-facing surface

`main()` in `index.ts` branches on flags only — `--selftest` (1405), `--logs` (1415),
`--fleet-check` (1422), `--serve` (1457), `--steward` (1463), `--ledger-guard` (1468),
`--print-config` (1478) **[read]** — and there is no worktree subcommand. So the natural surface
is an **MCP tool**, not a new CLI verb:

- New tool `merge_forecast` (`inputSchema: { base?: string }`), plus an additive `forecast`
  field on `worktree_list` (`index.ts:1258`) so an agent that already calls `worktree_list`
  before parallel work gets the ordering for free.
- The forecast is **advisory**. It never merges: merging stays with firstmate
  (`fm-merge-local.sh` mechanically, `fm-merge-authority-lib.sh` for authority).

Sketch, five in-flight worktrees (this is the shape of the output, not real data):

```
merge_forecast — integration branch `main` @ 8f3a1c2 · 5 worktrees · probed 10 pairs in 0.4s

order  worktree            ff   conflicts   blast (files/importers/hub/tests)   note
  1    t-031-docs          yes   clean        1/0/no/0      docs only
  2    t-029-analysis      yes   clean        2/3/no/1      rebase after #1: clean
  3    work/registry-ui    yes   clean        4/6/yes/2     touches hubs: command, ledger
  4    t-028-vendor-pin    NO    conflict     3/1/no/0      conflicts with t-031-docs in AGENTS.md
                                                           (2 hunks) — rebase onto main after #3
  5    t-030-bench         NO    conflict     9/12/yes/4    CONFLICT vs #4 in router.ts, worktrees.ts
                                                           (7 hunks) — merge last, or split: #5 owns
                                                           worktrees.ts, #4 owns bin/ only

stuck: none — an ff order exists for 1→2→3; 4 and 5 need a rebase, conflict paths above.
next: `git -C <t-031-docs.path> ...` → firstmate merge for #1 (fm-merge-local.sh), then refresh.
```

For the case where nothing is fast-forwardable, the same view prints `order: (none ff)`,
names the cheapest branch to merge first and every other branch's predicted conflict paths, so
the human rebases in that order instead of discovering conflicts one at a time.

---

## 4. Collisions still open

Each is a decision with a recommendation; none is implemented here.

### 4a. Two turn-end Stop hooks

`setup.mjs:1146-1149` **[read]** validates `hooks.Stop` as an array, strips break-free's own
marker (`STOP_HOOK_MARKER = "--fleet-check --hook"`, `setup.mjs:1122-1124` **[read]**) and then
**appends** its group rather than replacing: `j.hooks.Stop = … [...groups, { hooks: [{ type:
"command", command: stopHookCommand() }] }]`. firstmate installs a turn-end hook of its own
**[given]**, so both commands run on every turn end and Claude Code treats a block from either
as "the turn may not end". break-free's hook blocks on CI failures **and on pending CI and
running jobs** (`index.ts:1430-1440` **[read]**: `decision: "block"` with a reason built from
`ci.failed`, `ci.pending` and `running.jobs`) — so a long CI run can hold a turn that firstmate
would have let end.

I could **not** find firstmate's Stop-hook installation when grepping `.firstmate/bin/*.sh` for
`hooks.Stop` / `"Stop"` **[no matches]** — the distro's hook may be installed by a skill, by
`setup`/`fm-guard.sh`, or from a path my pattern missed. So the contract of firstmate's hook is
**[unverified]**.

**Recommendation:** one arbiter of "may this turn end", and it must be firstmate's hook, because
turn lifecycle is firstmate's. Concretely: drop break-free's blocking mode
(`--fleet-check --hook`, `index.ts:1423-1448`) so that `--fleet-check` remains a *reporting*
command consumed by the tool/`fleet_status`, and break-free surfaces its findings as
information. If a blocking CI gate is genuinely wanted, narrow it to **CI FAILED at the current
HEAD sha** (`ci.failed` only — never `ci.pending`, never `running.jobs`, both of which are
liveness, not failure) so the two hooks cannot both hold a turn over "something is still
running". Deciding this needs firstmate's hook contract read first; until then, do not remove
break-free's hook, because a missing guard is worse than a redundant one.

**Status (#121):** partly resolved. `--fleet-check --hook` now prints nothing and exits 0 in a
Firstmate worker (`FM_TASK_ID` set) or primary home (`bin/fm-spawn.sh` plus an `AGENTS.md`
starting `# Firstmate`), even with `ci.pending` queued, so firstmate's hook is the sole arbiter
there. Standalone sessions keep the full blocking guard.

### 4b. Two project-mode vocabularies

firstmate: `no-mistakes` / `direct-PR` / `local-only` (+ `yolo`) **[given]**. break-free:
`guarded` / `pr-only` / `local-only` plus a separate `mergeAutonomy` **[given]**.

**Recommendation:** one stored vocabulary (break-free's, since break-free is what the user
configures) and a **translation at the firstmate boundary**, in one place, one direction:
break-free mode → firstmate project mode, written by break-free when it hands a project to
firstmate; never the reverse, and never both stored. Shape of the mapping (to be confirmed
against both definition files — I have read neither, so this is the shape, not the final table):
`guarded → no-mistakes`, `pr-only → direct-PR` (no local merge by them), `local-only +
mergeAutonomy:auto → local-only + yolo`. A config validator should refuse to start when both
vocabularies are set to values that do not map onto each other, rather than silently picking one.

### 4c. Two task boards

firstmate `fm-backlog-*` in `FM_HOME` **[given]** vs the break-free ledger in `.break-free/`
(committed, shared through every worktree, guarded by `worktrees.ts:361-423` and the
`LEDGER_GUARD_WORKFLOW` at `worktrees.ts:426-448` **[read]**).

**Recommendation:** **two boards, one writer each, one recorded link.** The ledger stays the
system of record for break-free's own work (it is committed, it survives squash merges, and it
has the guard that keeps it off feature branches). The firstmate backlog stays the crew's queue
and is **never mirrored** into the ledger. The bridge is one field, written once, in one
direction: when break-free hands a task to firstmate, the firstmate id is recorded in the
ledger task frontmatter (the frontmatter already carries `owner` / `depends_on` / `tags` — see
`.break-free/tasks/T-031.md:1-10` **[read]**) as `fm_id`, and `task_get` returns it. Bidirectional
sync is explicitly rejected: two writers over the same ids diverges, and no reconciliation rule
exists for "reopened in one board".

---

## 5. What is not decided

Honest list, no recommendations smuggled in.

1. **Where the managed distro home actually lives** — `$BREAK_FREE_HOME` under the user's home,
   or inside a repo. §2 assumes a single managed home; the exact path, its env var name, and how
   it is discovered by `bf` are open. I read `FM_ROOT`/`FM_HOME` handling in `fm-update.sh:69-72`
   **[read]** but not firstmate's `data/secondmates.md` registry semantics
   (`fm-update.sh:72,180-235`) beyond the fact that it exists.
2. **The upstream remote URL and how the mirror is seeded.** The brief names
   `github.com/kunchenguid/firstmate` **[given]**; I did not read the remote of the local
   `.firstmate` checkout. Also open: how `revisions/<sha>/` is materialised (worktree of the
   mirror vs clone) and how many revisions are retained.
3. **Who may approve a pin, and where the approval is recorded.** One developer, or a CI job?
   Is approval a commit to a pin file, a ledger note, or an interactive prompt?
4. **Whether break-free's Stop hook keeps any blocking power at all** — needs firstmate's hook
   contract read first (§4a). Firstmate sessions are settled by #121 (break-free's hook stands
   down); standalone sessions still block alone, and whether that blocking should narrow is open.
5. **The `merge-tree` output parse.** Exact form of the conflicted-path list on the installed
   git, and whether a tree oid may be passed where a commit-ish is expected (needed for the
   cumulative simulation in §3b). Not verified here; it is a one-test question before
   implementation.
6. **How "landed" is decided for squash-merged PRs.** `reconcile()` currently marks a worktree
   `merged` when its branch has commits and `rev-list --count <base>..HEAD == 0`
   (`worktrees.ts:179-186` **[read]**) — ancestry, which the squash-merge fact
   (`fm-fleet-sync.sh:228-231` **[given]**) makes wrong for every PR-merged branch. Such a
   branch stays "active" forever and keeps claiming paths in the forecast. Candidates to
   evaluate: PR state via the `prs[]` field, or patch-id equivalence (`git cherry`); neither is
   decided, and patch-id equivalence is not proof either.
7. **Whether the registry, or firstmate, is authoritative for worktree *state*.** firstmate
   `fm-spawn.sh` writes `worktree=<path>` into `$FM_HOME/state/<id>.meta` **[given]**, while the
   gateway registry is keyed by path/branch in `.git/break-free/worktrees.json`
   (`worktrees.ts:105-109` **[read]**). Which one is reconciled into which, and what identifies
   the same worktree in both (branch? path? task id?), is open — today `reconcile()` can only
   see `git worktree list` **[read: `worktrees.ts:152-197`]**, so a firstmate-created worktree
   appears as an unregistered record with no purpose/agent/tasks until someone registers it.
8. **Blast-radius fidelity.** Whether to extend `CodeMap` with a per-file reverse index
   (changing `model-gateway/src/codemap.ts`) or to compute it in `worktrees.ts` without touching
   the map. Also whether test ownership (`git grep -l <module> -- '*test*'`) is cheap enough to
   run per candidate merge or should be cached.
9. **The exact scope of the `harness_*` deprecation.** I confirmed the module is in the gateway
   context (`orchestrate.ts:19,35` **[read]**) but did not enumerate every caller, so "remove
   the six `harness_*` tools" versus "keep the reader, drop the spawner" is undecided.
10. **Migration of existing registries.** What happens to `.git/break-free/worktrees.json`
    entries whose worktrees firstmate now owns and creates — auto-registered on first sight, or
    only on explicit `worktree_register`.
11. **Whether the `merge_forecast` order is enforced or advisory.** §3d says advisory
    (authority stays with `fm-merge-authority-lib.sh`); whether break-free should *refuse* to
    hand an out-of-order branch to firstmate is not decided.
12. **The changelog fragment convention.** Acceptance for this task requires
    `changelog.d/31-firstmate-design.md`; no `changelog.d/` directory and no fragment convention
    exist in the repository today (only the released-versions `CHANGELOG.md`), so how fragments
    are assembled into `CHANGELOG.md` is undecided.
