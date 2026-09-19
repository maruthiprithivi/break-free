# Using Break Free

From Claude Code:
```
/break-free-resume                                   where were we? (reads .break-free/HANDOFF.md, collects finished jobs)
/break-free-plan add rate limiting to the API with tests, docs and a migration
/break-free-delegate fast write unit tests for src/router.ts covering alias expansion and fallback ordering
/break-free-review staged security
/break-free-panel should we move the session store to SQLite or keep JSON files?
/break-free-supervise implement rate limiting in src/server.ts --caps read,write,run --rounds 3
```
or just in prose: *"split this into parallel chunks and run them on deepseek, then have kimi review"*, *"hand the boilerplate to a cheap model"*, *"get a second opinion from three different vendors"*, *"have a local model do this, don't send the code anywhere"*, *"pick up where we left off"*. The skill tells the lead when to reach for the gateway, how to write instructions and verification, and how to judge what comes back.

From Codex: `$break-free-model-gateway plan …` or the same natural-language requests.

## run_plan: parallel crews with gates
```jsonc
run_plan({
  goal: "rate limiting",
  review: true,                                   // every task independently reviewed (different vendor)
  tasks: [
    { id: "core",  task: "implement TokenBucket in src/ratelimit.ts …", model: "strong", capabilities: ["read","write","run"], verify: "npm test -- ratelimit", acceptance: "…" },
    { id: "tests", task: "write tests for src/ratelimit.ts …",           model: "fast",   capabilities: ["read","write","run"], depends_on: ["core"], verify: "npm test -- ratelimit" },
    { id: "docs",  task: "document the limiter in docs/api.md …",        model: "local",  capabilities: ["read","write"],       depends_on: ["core"] },
    { id: "wire",  task: "wire the limiter into src/server.ts …",        model: "deepseek/deepseek-v4-pro", capabilities: ["read","write","run"], depends_on: ["core"], supervise: true, verify: "npm test" }
  ],
  async: true                                    // returns a job id; job_status {wait_ms} / job_result
})
```
`tests`, `docs` and `wire` run in parallel once `core` is done and receive its report as context; a failing `verify` fails the task and skips its dependants; a reviewer `reject` fails it, `revise` marks it for your attention; every task lands in the ledger with outcome and verification. `workers.maxConcurrency` (default 4) caps parallelism.

## Routing: when you'd rather not name a model
Drop `model` from a task and let routing pick the lane:

```jsonc
run_plan({ goal: "rate limiting", routing: "jev", tasks: [ … ] })   // session-level
```

Add `files` and `tags` per task so policy and the scorecards have something to work with — `files`
decides sensitivity (auth, secrets, migrations force a stronger lane *and* an automatic review),
`tags` join the ledger's scorecards so a lane that keeps failing stops being chosen. Jev answers a
whole plan in one call and hands anything below the confidence threshold back to you instead of
guessing. `routing: "off"` (also the global default) restores the old behaviour exactly: an omitted
model means `defaults.model`.

Turn it on or off at **session** (`routing: "jev"` on the call, or `BREAK_FREE_ROUTING`),
**project** (`routing.engine` in `.model-gateway.json`) or **global** (`routing.engine` in the user
config) level; the narrower one wins. A project file may enable Jev, and a user can veto that for
every repo with `routing.projectMayEnableJev: false`.

Full guide — lanes, thresholds, sensitivity modes, ledger fields, the learning loop, and the
measurements from `bf route` / `bf bench route` / `bf demo` / `bf scenarios`: **[routing.md](routing.md)**.

## The ledger: long-horizon memory in the repo
`.break-free/` is created on first use (`ledger_resume {init:true}`, `task_create`, `note_write` or a tracked `run_plan`) and is plain Markdown — commit it, diff it, or open the folder as an **Obsidian vault**:

| file | what | who writes |
|---|---|---|
| `HANDOFF.md` | resume brief: in progress / blocked / ready, decisions, gotchas, recent activity | generated |
| `PLAN.md` | board by status + Mermaid dependency graph | generated |
| `tasks/T-001.md` | frontmatter (status, owner, depends_on, verify, tags) + Problem / Acceptance criteria / Outcome / Log | lead (`task_*`), `run_plan`, workers (`ledger_task_log`) |
| `notes/<slug>.md` | decisions, gotchas, conventions, how-tos with `[[wikilinks]]` — those tagged `decision/gotcha/convention/howto` are injected into every worker | lead (`note_write`), workers (`ledger_note`) |
| `journal/<date>.md` | append-only: what was delegated to which model, verified how, outcome | gateway |
| `CODE-MAP.md` | directories, most-depended-on modules, Mermaid import graph, exported symbols (TS/JS, Python, Go, Rust) | `code_map` |

Both Claude Code and Codex read the same ledger, so you can start in one and continue in the other. Background jobs are persisted under `~/.config/model-gateway/sessions/jobs/`, so a new session can `job_list` → `job_result` what an earlier one started.

## Multi-agent work across worktrees
Run several agents on one repo — Claude Code on `main`, Codex in one worktree, opencode / kiro / kimi / pi / omp / agy in others — and let them share one map. The registry lives in the git **common dir** (`.git/break-free/worktrees.json`), so every checkout of the repository sees the same data instantly and it never diverges across branches; `worktree_sync` renders it to `.break-free/WORKTREES.md` (commit that from main for history).

| tool | does |
|---|---|
| `worktree_list` | every worktree with status + reason, agent, purpose, ledger tasks, issues, PRs, tools, models, last hand-off — reconciled with `git worktree list` on each call |
| `worktree_register` | claim the current checkout (purpose, agent, tasks, issues, PRs, tools, models); idempotent, acts as heartbeat |
| `worktree_create` | `git worktree add` under `<repo>.worktrees/<branch>` + register — hand the path to another agent or a second gateway (`--workspace`) |
| `worktree_update` / `worktree_handoff` | status changes with mandatory reasons (`inactive`, `blocked`, `abandoned`, `deleted`), new PRs/issues/tools, hand-off notes (done / next / verify / gotchas) |
| `worktree_remove` | remove a checkout (branch kept) with a reason; refuses main, the current tree, dirty trees and unmerged branches unless `force` |

Automatic states: a branch whose commits are all in its base → `merged`; a checkout that vanished → `deleted` ("removed outside the gateway" unless a reason was recorded); no commit/heartbeat for `worktrees.inactiveAfterHours` (48h) → `inactive`. The map is injected into every delegated worker's prompt and into `ledger_resume`, so a worker in one tree knows not to touch another tree's branch.

## How the ledger survives merges — main is the single source of truth
The obvious failure: every worktree commits its own `.break-free/` on its branch, and the PR that merges the code also merges (or conflicts on, or overwrites) main's tasks, notes and journal. Break Free avoids it structurally:

| where | what the gateway does |
|---|---|
| main checkout | reads and writes the committed `.break-free/` — the only copy git ever sees change |
| linked worktree | reads main's **live** `.break-free/` underneath a local overlay in `.git/break-free/shadow/<branch>/`; all writes (tasks with ids `T-<branch>-001`, notes, journal, task updates as copy-on-write) go to the overlay, so `git status` on the branch never shows ledger changes |
| `worktree_create` / installer (project scope) | install a pre-commit hook in the repo's **common** hooks dir (applies to every worktree; an existing hook is chained) that refuses to commit `.break-free/` from a linked worktree; `git_commit` from the gateway drops it from the index too |
| `ledger_guard {action:"install"}` | also writes `.github/workflows/break-free-ledger-guard.yml`, which fails any PR whose diff against the base touches `.break-free/` — the belt to the hook's braces, for branches pushed from elsewhere |
| `ledger_merge_from` (and `ledger_resume` on main, and `worktree_remove`) | absorbs each overlay into main: tasks by id (newer record wins field by field, logs unioned), notes by slug (identical/contained → fuller one; divergent → main's text kept, worktree's appended under `## From <worktree>`), journal lines unioned with `[worktree]` prefix; idempotent; `commit:true` commits on main, never pushes; the registry records `ledgerMergedAt` per worktree |

So a PR from a worktree branch carries code only; main's knowledge is never overwritten by a merge, and main is always the freshest view because it absorbs on every `ledger_resume`. Verified end to end in the test-suite: overlay isolation, hook refusal, `git_commit` stripping, absorb + idempotency, divergent-note merge, a real `git merge` of the branch leaving `.break-free/` untouched, workflow install.

## Other coding agents: Gemini CLI, Copilot CLI, Cursor, Goose, Amp, Hermes, Aider, Cline, AdaL, OpenClaw, Droid, Kilo Code, Roo Code, Qoder, Zed, opencode, Kiro CLI, Kimi Code CLI, Antigravity (agy), pi, oh-my-pi (omp)
The installer detects these (binary on PATH or config dir present), lets you pick which to wire (`extra_agents` in the answers file: list, `"detected"` or `"all"`; `extra_scope`: user / project / both), and installs the MCP server, both `break-free-*` skills, and the standing rules — in each tool's own conventions. Where a tool's MCP servers can't be edited by file (or its MCP support is experimental), the installer prints the exact one-line registration command instead:

| agent | MCP server | skills | standing rules |
|---|---|---|---|
| opencode | `~/.config/opencode/opencode.json` `mcp.break-free-gateway` (`type:"local"`); project `opencode.json` | `~/.config/opencode/skills/` (also reads `.agents/skills`) | `~/.config/opencode/AGENTS.md`; project `AGENTS.md` |
| Kiro CLI | `~/.kiro/settings/mcp.json`; project `.kiro/settings/mcp.json` | `~/.kiro/skills/`; `.kiro/skills/` | `~/.kiro/steering/break-free.md`; `.kiro/steering/break-free.md` |
| Kimi Code CLI | `~/.kimi/mcp.json` | `~/.kimi/skills/` (also `.agents/skills`) | project `AGENTS.md` |
| Antigravity (agy) | `~/.gemini/config/mcp_config.json`; project `.agents/mcp_config.json` | `~/.gemini/config/skills/` (also `.agents/skills`) | `~/.gemini/GEMINI.md`; `.agents/rules/break-free.md` |
| pi | `~/.pi/agent/mcp.json` (needs `pi install npm:pi-mcp-adapter` once); project `.mcp.json` | `~/.pi/agent/skills/`; `.pi/skills/` | `~/.pi/agent/AGENTS.md`; project `AGENTS.md` |
| oh-my-pi | `~/.omp/agent/mcp.json`; `.omp/mcp.json` | `~/.omp/agent/skills/`; `.omp/skills/` | `~/.omp/agent/AGENTS.md`; `.omp/AGENTS.md` |
| Gemini CLI | `~/.gemini/settings.json` `mcpServers`; project `.gemini/settings.json` | `~/.gemini/skills/`; `.gemini/skills/` (also `.agents/skills`) | `~/.gemini/GEMINI.md`; project `GEMINI.md` |
| GitHub Copilot CLI | manual: `copilot mcp add break-free-gateway -- node <dist/index.js>` | `~/.copilot/skills/` | `~/.copilot/AGENTS.md`; project `AGENTS.md` |
| Hermes Agent | manual: `mcp_servers:` block in `~/.hermes/config.yaml` (or `hermes import-agent claude-code`) | `~/.hermes/skills/` | `~/.hermes/AGENTS.md`; project `AGENTS.md` |
| Aider | manual (experimental MCP) | — | `~/.aider.conf.yml` / `.aider.conf.yml` `read: AGENTS.md` |
| Cline | manual (editor settings `cline_mcp_settings.json`) | — | `~/.clinerules`; project `.clinerules` |
| AdaL CLI | manual (AdaL UI) | — | `~/.adal/AGENTS.md`; project `AGENTS.md` |
| OpenClaw | manual: `openclaw mcp add break-free-gateway` | — | `~/.openclaw/AGENTS.md`; project `AGENTS.md` |
| Cursor | `~/.cursor/mcp.json`; project `.cursor/mcp.json` | (reads `.agents/skills`) | reads `AGENTS.md` + `.cursor/rules` |
| Goose (Block) | manual: `extensions` in `~/.config/goose/config.yaml` (or `goose configure`) | `~/.config/goose/skills/` | project `AGENTS.md` |
| Amp (Sourcegraph) | manual: skill `mcpServers` / Amp MCP config | `~/.config/agents/skills/` | project `AGENTS.md` |
| Droid (Factory) | reads project `.mcp.json` | `~/.agents/skills/`; `.agents/skills/` | project `AGENTS.md` |
| Kilo Code | manual | `~/.agents/skills/`; `.agents/skills/` | project `AGENTS.md` |
| Roo Code | manual | `~/.agents/skills/`; `.agents/skills/` | project `AGENTS.md` |
| Qoder | manual | `~/.agents/skills/`; `.agents/skills/` | project `AGENTS.md` |
| Zed | reads project `.mcp.json` | `~/.agents/skills/`; `.agents/skills/` | project `AGENTS.md` |

Existing entries in those files are preserved (JSON is merged, rules are marker-based and self-updating), `--doctor` reports each agent, `--uninstall` removes only what was added. All of them then share the same ledger and worktree registry, so a hand-off written by kiro in one worktree is what Claude Code reads on main.

Everything else that reads `AGENTS.md` + `.mcp.json` + `.agents/skills` — Crush, Windsurf, Trae, JetBrains Junie, Warp, Continue.dev, Augment, Freebuff, Devin — is covered automatically at project scope by the files `installProject` writes, with no per-tool config needed.

## Guardrails the gateway enforces
| what | how |
|---|---|
| **Policy rules** (`configure_policy`, or `policy.rules` in `.model-gateway.json` — allowed at project scope because rules only add restrictions) | `deny` globs are unreadable/unwritable/unsearchable for workers on that call; `review` globs trigger an automatic independent review by a different vendor when a worker changed a matching path (detected by snapshotting the tree before/after, including commits); a `reject` fails the task in `run_plan`, `supervise` un-accepts. Reported in `meta.policy`. |
| **Budgets** (`configure_budget`, `cost_report`) | every call is priced (list prices in `DEFAULT_PRICING`, override with `pricing`); `meta.cost_usd` everywhere; `perTaskUsd` stops a worker, `perPlanUsd` cancels the plan's remaining tasks, `perDayUsd` refuses new delegations; `cost_report` gives spend per day/provider/model and today vs cap. |
| **Worker-note quarantine** (`note_review`) | notes from `ledger_note` carry `trust: worker, pending: true` and are never injected into other workers until promoted; a worker cannot overwrite a lead note (its text becomes a pending proposal section); rejected notes go to `notes/rejected/`; absorption from worktrees preserves the pending flag. This closes the model-to-model prompt-injection path through the ledger. |
| **Overlap detection** (`worktree_list.overlaps`) | files changed by two live worktrees relative to their base, plus declared `paths` claims that cover another worktree's changes; surfaced in the worker prompt as `OVERLAP`. |
| **Steward** (`steward`, `--steward`, `break-free-steward`) | absorb overlays → reconcile worktrees (overlaps, removable merged checkouts) → hygiene (`ledger_doctor`: stale note paths, old done tasks, old journal; `archive:true` moves to `archive/`) → refresh `CODE-MAP.md` → run `steward.verify` on main → regenerate HANDOFF/WORKTREES → journal. Cron-friendly, exit 1 if verify fails. |

## Lending your MCP servers to workers
`list_mcp_servers` shows servers from `config.workers.mcp.servers`, `~/.claude.json` (user + project scope), `<workspace>/.mcp.json` and `~/.codex/config.toml`. Nothing is exposed unless a call names it: `delegate({ …, mcp_servers: ["postgres", "playwright"] })`. Tools appear to the worker as `mcp__postgres__query`; anything matching `workers.mcp.denyTools` (`*delete*`, `*remove*`, `*drop*`, `*destroy*`, `*purge*`, `*wipe*`, `*truncate*` by default) is never exposed, and a server entry may add `allowTools`. Stdio, streamable-HTTP and SSE transports; `${ENV}` expansion in env/args/url/headers.

## Model specs

Every alias has a crew name that resolves to the same chain. Both work; use whichever reads better to you.

| crew name | same chain as | what it is for |
|---|---|---|
| `ensign` | `fast` | the legwork: boilerplate, tests, refactors |
| `commander` | `strong` | hard implementation or supervision |
| `counselor` | `reviewer` | the independent read on whether something is sound, from a different vendor than the worker |
| `holodeck` | `local` | a simulation that never leaves the ship |
| `subspace` | `cloud` | the off-ship link |

`delegate({ model: "ensign" })` and `delegate({ model: "fast" })` are the same call. The crew name takes its candidate list from the core alias rather than copying it, so editing one cannot leave the other pointing at a retired model, and a test pins that.

`fast` `strong` `reviewer` `local` `cloud` (aliases, each an ordered fallback chain) · `deepseek/deepseek-v4-pro` · `kimi/kimi-k3` · `zai/glm-5.3` · `minimax/MiniMax-M3` · `ollama/qwen3-coder:30b` · `ollama-cloud/gpt-oss:120b` · `openrouter/moonshotai/kimi-k3` · `opencode/deepseek-v4-flash` · bare `kimi` (provider default) · `a,b,c` (ad-hoc chain).

## Switching models from chat
Say it to the agent — "use kimi-k3 for `fast` from now on", "switch deepseek to deepseek-v4-pro for this repo", "reviews should go to glm-5.3 globally" — or `/break-free-model <change>`. The skill maps it to `configure_provider {default_model}`, `configure_alias {candidates}` or `configure_fallback {default_model|default_reviewer|default_supervisor}`, checks the live model list, and writes to `scope:"user"` (`~/.config/model-gateway/config.json`) or `scope:"project"` (`<repo>/.model-gateway.json`, committed, wins over user config in that repo; may only hold model choices, aliases, defaults and fallback order — never keys, base URLs or git policy). It then runs `test_provider` and reports which model actually answered. `list_models` shows the effective `provider_defaults` and which config files are in play.

## Fallback semantics
For each candidate in order: transient failures (429, 5xx, timeout, network) are retried `retriesPerCandidate` times with backoff, then the next candidate is tried; missing key / disabled / 401 / unknown model skip immediately to the next; `bad_request` (400) stops, because the request itself is wrong. After the alias/explicit list, `fallback.chain` is appended. `retryOn` controls which reasons are allowed to fall through. Every tool result ends with `meta: {"model": "…", "fallback_attempts": […]}`.

## The circuit breaker: a dead host costs one timeout, not one per call

A wedged host is the worst kind of failure, because it looks healthy. It accepts the TCP connection and then says nothing, so the request sits until `timeoutMs` — which is deliberately generous for slow models — and with `retriesPerCandidate` it does that twice. One delegation burned twenty minutes that way, and every later call in the session burned twenty more, because nothing remembered.

Two consecutive **timeout or network** failures now open that provider's circuit. While it is open its candidates are skipped instantly with the attempt reason `circuit_open`, the chain carries on to the next candidate, and a `provider.circuit_open` event goes on the fleet queue so the trip is visible rather than inferred. Only host-level symptoms count as strikes: a 401 or an unknown model says nothing about whether the host is answering.

After `cooldownMs` the next call is a trial. The strikes are not forgiven, so one further failure re-opens the circuit immediately and only a real answer clears it. The state is persisted next to the session files, so a restart does not re-learn the same dead host, and `--doctor` reports `open_circuits` — an open circuit is otherwise indistinguishable from a healthy provider, since the key is present and the model is configured.

Tune it with `fallback.breaker`: `{ "enabled": true, "failures": 2, "cooldownMs": 300000 }`.

## The tier floor: fallback never quietly gets weaker

Fallback used to mean "anything that answers". A task pinned to a frontier model could land on a small local one and grind for half an hour, and the only sign was the `model` field in `meta`.

Every model has a **tier** — 3 frontier, 2 solid, 1 small/local — from `DEFAULT_TIERS`, overridable per provider or per `provider/model` in `tiers`. The floor for a call is the tier of the model you actually asked for, so a request for tier 3 is never answered by tier 1 behind your back. Candidates below the floor are not tried, and if the ones above it all fail, the error names what was held back:

```
All 1 candidate(s) failed:
  - deepseek/deepseek-v4-pro: [auth] HTTP 401 invalid api key

Not tried, below the tier 3 floor: ollama/qwen3-coder:30b (tier 1)
Pass allow_downgrade:true to use them anyway, or min_tier to move the floor.
```

Per call, `delegate`, `supervise` and each `run_plan` task take `min_tier` (move the floor: `1` accepts anything, `3` demands frontier) and `allow_downgrade` (drop the floor once everything above it has failed). Globally, `fallback.minTier` pins one floor for every call and `fallback.allowDowngrade` restores the old permissive behaviour. A downgrade that does happen is reported rather than silent: `meta` carries `requested_model`, `tier` and `downgraded`, and `run_plan` prints `route: strong -> ollama/qwen3-coder:30b (auth) [tier 3 -> 1]`. Falling back within a tier is not a downgrade and stays quiet.

## Project modes

One named mode derives the git and GitHub policy, instead of setting three flags and hoping they agree:

| `mode` | push | merge | protected branches |
|---|---|---|---|
| `guarded` (default) | non-protected branches only | only when `mergeAutonomy` is true | enforced |
| `pr-only` | non-protected branches only | never, always a PR | enforced |
| `local-only` | never | never | enforced |

`mergeAutonomy` is a separate opt-in, so letting workers merge is always a deliberate act. An explicit `github.allowPush` or `github.allowMerge` still wins over the mode, so an existing config keeps behaving exactly as it did. Neither `mode` nor `mergeAutonomy` can be set from a project `.model-gateway.json`: that file comes with a repository you may have just cloned, and a clone must never be able to grant itself push rights.

**Note for upgrades:** `github.allowMerge` used to default to `true`. It is now `false` under `guarded` unless you set `mergeAutonomy`, so a worker holding the `github` capability no longer merges out of the box.

## Task shapes: ship and scout

Every `delegate`, `supervise` and `run_plan` task takes a `shape`:

- **`ship`** (default) uses the capabilities you asked for.
- **`scout`** is a read-only investigation. Its capabilities are forced to `read` whatever you passed, and the report says it changed nothing.

A scout is the safest thing you can delegate, so it has a name rather than requiring you to remember to write `capabilities: ["read"]`:

```jsonc
delegate({ task: "Why does the retry loop double-count attempts? Point at files and lines.",
           model: "strong", shape: "scout" })
```

Asking for `["read","write","run"]` on a scout is not an error and not a warning — the write and run tools are simply never given to the worker.

## Capabilities and guardrails
| capability | tools | can't |
|---|---|---|
| `read` | `read_file` `list_files` `search` `git_status` `git_diff` `git_log` | leave the workspace (symlinks resolved), read `.env*`, keys, `.git/`, `.model-gateway.json`, `workspace.denyPatterns` |
| `write` | `write_file` `edit_file` (+ `ledger_note` `ledger_task_log` when a ledger exists) | delete files |
| `run` | `run_command` | anything outside `workers.allowedCommands` prefixes (`npm test`, `pytest`, `go test`, `cargo test`, `make test`, … — edit the list in config); no shell, so `;` `&&` `|` `$()` are rejected; timeout `workers.commandTimeoutMs` |
| `mcp` | `mcp__<server>__<tool>` for servers named in `mcp_servers` | servers not lent for this call; tools matching `workers.mcp.denyTools` |
| `git` | `git_create_branch` `git_commit` `git_push` | force-push, amend, reset, rebase, delete branches, push `github.protectedBranches` |
| `github` | `gh_repo_view` · issues: create/list/view/comment/close · PRs: create/list/view(+diff)/comment/review/merge · Actions: list workflows/runs, view run, logs, watch, rerun, dispatch | delete/transfer/archive repos, delete branches, secrets, collaborators, `gh api` — none are exposed. Merge can be disabled (`github.allowMerge=false`), push too |

Hardening (each covered by a test): every model-supplied string that reaches `git`/`gh` is validated (refs, branch names, enums, arrays — nothing may start with `-`, so `--output=`, `--force`, `--admin`, `--delete-branch` are unreachable); denied files are stripped from diffs and never staged by `git_commit`; symlinks are skipped by `search`/`list_files` and resolved by the jail; a project `.model-gateway.json` (untrusted — it comes with the repo) may only set `defaults`, `aliases`, `fallback` and per-provider `defaultModel`/`enabled`/`extraBody` — it can never change base URLs, keys, protected branches or the workspace root.

GitHub auth is whatever `gh` uses (`gh auth login` or `GH_TOKEN`). Recommended: a fine-grained PAT with Contents RW, Issues RW, Pull requests RW, Actions RW, Workflows RW, Metadata R — nothing else, so even a jailbroken worker cannot exceed that.
