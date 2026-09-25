---
name: break-free-model-gateway
description: Break Free — you are the lead; other models are the crew. Delegate execution (boilerplate, tests, refactors, migrations, docs, bulk edits), run many workers in parallel (run_plan), get independent review, run panels, supervise long tasks, and keep a durable task board + knowledge ledger across sessions — all through the break-free-gateway MCP server (DeepSeek, Kimi, MiniMax, Z.AI/GLM, Ollama local/cloud, OpenRouter, OpenCode Zen, vLLM) with automatic provider/model fallback. Use for any task with more than ~15 minutes of mechanical work, anything parallelisable, "delegate", "hand this to deepseek/kimi/glm/a local model", "use codex/kiro-cli/agy/omp/pi/claude for <task>", "second opinion", "review this", "run a panel", "supervise", "plan this out", "resume", "where were we", "use <model> for <alias>", "switch <provider> to <model>", "change the reviewer model", "what are the other worktrees doing", "hand this off", "create a worktree for X", "how much have we spent", "set a budget", "never let workers touch X", "review the pending notes", "run the steward".
argument-hint: [delegate|plan|review|panel|supervise|resume] [task]
allowed-tools: mcp__break-free-gateway, Bash(git diff *), Bash(git status *), Bash(git log *)
---

# break-free-model-gateway: you lead, other models execute

**Doctrine.** You are a frontier model inside a first-class harness (memory, skills, MCP, tools). That is expensive and scarce; use it for what only you can do well: understand the user, decompose the problem, decide the design, write the acceptance criteria and the verification, review, coordinate, and own the outcome. Everything else — the scut work, the long mechanical execution, the first draft of tests and docs, the parallelisable chunks — goes to worker models through the gateway. **Default to delegating execution; keep judgement.** A good session looks like: you think and write instructions for a few minutes; several workers run for a long time; you read reports, diffs and verification results; you decide.

The gateway gives workers your project's CLAUDE.md / rules, the ledger's decisions and gotchas, named skills, jailed file/git/GitHub tools, allow-listed test commands and (when you lend them) your other MCP servers. Nothing destructive is possible for them by construction.

## Tools (all `mcp__break-free-gateway__*`)

| Tool | Use it to |
|---|---|
| `ledger_resume` | **First call of every session** (`init:true` to create the ledger). Returns the handoff brief: what is in progress, blocked, ready, decisions, gotchas, recent activity. |
| `task_create` / `task_update` / `task_list` / `task_get` | Durable task board in `.break-free/tasks/*.md` (problem, acceptance criteria, verify command, dependencies, outcome, log). Every unit of work you plan or delegate gets a task; every completion updates it. |
| `note_write` / `note_search` | Knowledge in `.break-free/notes/*.md`. Notes tagged `decision`, `gotcha`, `convention`, `howto` are injected into **every** worker automatically — this is how you make the whole crew respect what you learned. |
| `worktree_list` / `worktree_register` / `worktree_update` / `worktree_handoff` / `worktree_create` / `worktree_remove` / `worktree_sync` | Shared registry of every git worktree: agent, purpose, tasks, issues, PRs, tools, models, status (active/inactive/blocked/merged/abandoned/deleted + reason), handoff notes. See "Parallel agents & worktrees". |
| `ledger_merge_from` / `ledger_guard` | Absorb worktree ledger overlays into main (idempotent; `commit:true` commits) and install/check the pre-commit hook + PR workflow that keep feature branches from ever changing `.break-free/`. See "How the ledger survives merges". |
| `configure_policy` / `configure_budget` / `cost_report` / `note_review` / `steward` / `ledger_doctor` | Enforced guardrails: deny/review rules on paths, USD caps and spend, worker-note quarantine, the maintainer routine. See "Guardrails". |
| `code_map` | Import graph + symbol index → `.break-free/CODE-MAP.md`. Run once per session on unfamiliar repos; point workers at it. |
| `run_plan` | **The main tool.** Many tasks as a dependency graph, run in parallel (bounded concurrency), each with its own model, capabilities, acceptance criteria, `verify` command, optional `review`/`supervise`. Prerequisite reports flow to dependants; failures block dependants; everything is tracked in the ledger. `async:true` for long plans. |
| `delegate` | One worker, one task. `verify` = command the gateway runs afterwards (real exit code, cannot be faked). `mcp_servers` lends your MCP servers. `session_id` continues a worker. `async:true` returns a job id. |
| `supervise` | Worker ↔ supervisor loop until accepted; `verify` runs after every round and a failing verification can never be accepted. |
| `review` | Independent scrutiny (different vendor) → JSON verdict with issues. Attach real diffs with `use_git_diff`. |
| `panel` | Same question to 2–4 vendors in parallel, judge synthesises. Design decisions, root-cause hypotheses. |
| `job_status` / `job_result` / `job_cancel` / `job_list` | Background jobs from `async:true`; `job_status` accepts `wait_ms`. Jobs persist, so a new session can collect results. |
| `list_mcp_servers` | Which of your MCP servers can be lent to workers (`server:"name"` lists its tools and which are filtered as destructive). |
| `list_providers` / `list_models` / `test_provider` | Which providers have keys; aliases and fallback chains; live model lists; real round-trip test. |
| `configure_provider` / `configure_alias` / `configure_fallback` | Persist model choices, aliases, fallback policy, keys and base URLs — `scope:"user"` (default) or `scope:"project"` (`.model-gateway.json` in the repo). See "Switching models". |
| `gateway_logs` | Per-provider success/failure/tokens, per-tool stats, jobs, MCP stats, detected problems. **Run this first when delegation misbehaves.** |
| `session_*` | Inspect / continue / clear worker conversations. |
| `harness_spawn` / `harness_send` / `harness_read` / `harness_status` / `harness_close` / `harness_list` | Run a task in **another coding harness** (claude/codex/omp/pi/grok/…) inside a detached tmux session — a real PTY — so it uses the user's subscription, not API credits (never `claude -p`). Sessions persist and resume by id. |

## Routing "use X to do Y"

When the user says "write code using deepseek", "use codex for the mockups", "use kiro-cli and agy to review" — route by what `X` is, a **model** or a **harness**:

| "X" | route | example |
|---|---|---|
| a model/provider spec (`deepseek`, `kimi`, `zai`/`glm`, `minimax`, `ollama`, `openrouter/…`, `opencode/…`) | **LLM delegation** — `delegate`/`run_plan` with `model` | "write code using deepseek" → `delegate {model:"deepseek/deepseek-v4-pro", task:"…"}` |
| another harness CLI (`codex`, `kiro-cli`, `agy`, `omp`, `pi`, `claude`, `opencode`, `gemini`, …) | **harness sub-agent** — `harness_spawn` + `harness_send` (tmux PTY, subscription) | "use codex for the mockups" → `harness_spawn {harness:"codex"}` then `harness_send` the brief |
| several models | `run_plan` (parallel, per-task `model`) or `panel`/`review` | "deepseek for code, kimi to review" → `run_plan`, review by a different vendor |
| several harnesses | one `harness_spawn` per harness, send each the same task, read each back | "use kiro-cli and agy to review" → spawn both, send the diff + "review this" to each, `harness_read` both |

Ambiguity: `kimi` and `opencode` name both a model *and* a harness. "use kimi" on a coding task → Kimi Code CLI (harness) when the user wants that harness's tools; model *choices* ("switch to kimi", "use kimi-k3") → the kimi provider. If unclear, ask in one line — don't guess.

A harness sub-agent is a tmux session that keeps running after you move on: `harness_list` → `harness_read` collects its work, more `harness_send` resumes it, `harness_close` ends it.

## The lead's loop

1. **Resume.** `ledger_resume`. If the repo is unfamiliar, `code_map`. Read `.break-free/HANDOFF.md` if you need more.
2. **Decompose.** Split the goal into tasks that are self-contained (the worker cannot see this conversation), have a crisp acceptance criterion and, wherever possible, a `verify` command (`npm test`, `pytest -q tests/x.py`, `go test ./...`). Record them: `task_create` (or let `run_plan` do it). Decide dependencies so independent work runs in parallel.
3. **Write the instructions, not the code.** For each task: scope, files, constraints, conventions, what "done" means, what NOT to touch, and how to verify. Put background in `context`, the ask in `task`, hard rules in `acceptance`. Attach `skills` (e.g. `break-free-github-flow`) and `mcp_servers` if the task needs them.
4. **Dispatch.** `run_plan` with per-task `model` (mix vendors: `fast` for routine, `strong` for hard, `local` for private code), least-privilege `capabilities` (`read` → `write` → `run` → `git` → `github`), `verify`, and `review:true` for anything that touches behaviour. Use `supervise:true` on tasks that need iteration. `async:true` when it will take a while — keep working on the next decision while the crew runs, then `job_status` with `wait_ms`.
5. **Judge.** Read the consolidated report: verification results are ground truth, worker "Verification" prose is a claim. `git diff` what changed. For anything important, `review` with a different vendor than the worker. Push back with `delegate` + the same `session_id` and the reviewer's issues.
6. **Own it.** You commit (or a worker with `github` opens the PR per your instruction). Update the ledger: `task_update` (status, outcome, how verified), `note_write` for every decision, gotcha and convention you or a worker discovered. Tell the user what was delegated to which model (from `meta:`), what was verified, and what remains.

## Model specs

`fast` · `strong` · `reviewer` · `local` · `cloud` (aliases with fallback) — or `deepseek/deepseek-v4-pro`, `kimi/kimi-k3`, `zai/glm-5.3`, `minimax/MiniMax-M3`, `ollama/qwen3-coder:30b`, `openrouter/moonshotai/kimi-k3` — or a comma list as an ad-hoc chain. A bare provider name (`kimi`) resolves to its default model. Fallback is automatic; the `meta:` footer says which model actually answered and what was skipped. **Always tell the user which model did the work.**

## Switching models (when the user asks in chat)

The user says things like "use kimi-k3 for fast from now on", "switch deepseek to deepseek-v4-pro", "in this repo, reviews go to glm-5.3", "make the local alias use qwen3:8b". Do it with the `configure_*` tools — never by editing config files by hand:

1. Work out **what** they mean: a provider's default model (`configure_provider {provider, default_model}`), an alias chain (`configure_alias {alias, candidates}`), or the default alias for delegation/review/supervision (`configure_fallback {default_model|default_reviewer|default_supervisor}`).
2. Work out **where**: "for this repo/project" → `scope:"project"` (writes `<repo>/.model-gateway.json`, committed, overrides the user config here); otherwise or "everywhere/globally" → `scope:"user"` (default, `~/.config/model-gateway/config.json`). If unclear and the repo already has a `.model-gateway.json`, prefer project; else ask in one line.
3. Check the name exists: `list_models {provider}` lists live models; pick the exact id (model names change often). For an alias, read its current chain from `list_models` first and keep the other candidates as fallbacks unless told otherwise.
4. Apply, then `test_provider {spec}` for a real round-trip, and tell the user what changed, where it was saved, and which model answered the test.

Project scope can only carry model choices, aliases, defaults and fallback order — keys, base URLs and git/GitHub policy are refused there by design.

## Harness sub-agents (harness → harness over tmux)

Delegating to *another coding harness* is different from delegating to an LLM: the sub-agent should run in the user's interactive mode — the Claude Code / Codex subscription — not `claude -p "<prompt>"`, which prints non-interactively and bills the API per token. Break Free hosts each harness sub-agent in its own **tmux session** (a real PTY) driven by keystrokes, and tracks it as a resumable session.

- `harness_spawn {harness:"codex", cwd?}` → a detached `tmux new-session` running that harness in the workspace; returns a session id. Fan a sub-task out to a whole other harness (with its own memory, skills and tools) while the lead keeps the conversation.
- `harness_send {id, text}` / `harness_read {id}` → write the task and read the pane. `harness_status` says running/exited; `harness_close` ends it; `harness_list` shows every session — resume an earlier one by id.
- Session ids persist under `~/.config/model-gateway/sessions/harness/`, so a later session can `harness_list` → `harness_read` and pick up where a sub-agent left off.
- Inside Orca (orca.dev) the workspace root is the Orca worktree; spawn there and the sub-agent shares the repo, git worktrees and ledger with the lead and the other agents. The tmux binary is configurable (`harness.tmux`, env `BREAK_FREE_TMUX`).

## Parallel agents & worktrees (multi-agent hand-offs)

When more than one agent works on the repo at once — Claude Code on main, Codex in one worktree, opencode/kiro/kimi/pi/omp/agy in others — the **shared worktree registry** (`.git/break-free/worktrees.json`, visible from every checkout, rendered to `.break-free/WORKTREES.md`) is how everyone knows what everyone else is doing:

- **Start of session, any checkout:** `ledger_resume` already includes the worktree map; `worktree_list` for details. Then `worktree_register {purpose, agent, tasks, issues, tools, models}` to claim the checkout you are in (idempotent; also a heartbeat).
- **Fan out:** `worktree_create {branch, purpose, agent, tasks, issues}` makes a checkout under `<repo>.worktrees/<branch>` and registers it; point the other agent (or a second gateway instance, `--workspace <path>`) at it. Ledger tasks say which worktree owns them (`task_update {owner:"worktree:feat/api"}`).
- **While working:** keep the record true — `worktree_update` with new `prs`/`issues`/`tools`, `status:"blocked"` + reason, `status:"inactive"` + reason when you pause. Reasons are mandatory for inactive/blocked/abandoned/deleted.
- **Hand-off:** `worktree_handoff {handoff:"done / not done / next steps / verify / gotchas", status, prs}` — the next agent, and main, read it from `worktree_list` and the resume brief. Gotchas that matter to everyone also go in `note_write` (tagged) so every worker inherits them.
- **Main's duty:** `worktree_sync` renders `WORKTREES.md` into main's ledger (commit it); merged branches are detected automatically (`merged`), vanished checkouts become `deleted` with reason "removed outside the gateway" unless `worktree_remove {reason}` recorded one; stale ones become `inactive` after `worktrees.inactiveAfterHours` (48h).
- **Never** touch another worktree's branch; coordinate through the ledger and GitHub (issues/PRs recorded on the worktree, per `break-free-github-flow`).

## How the ledger survives merges (main is the single source of truth)

`.break-free/` is committed **only from the main checkout**. In a linked worktree the gateway writes to a local overlay (`.git/break-free/shadow/<branch>/`) layered over main's *live* ledger: you read everything main knows, your writes (new tasks get ids like `T-feat-api-001`, notes, journal, task updates) stay out of the branch, `git status` in the worktree never shows `.break-free/`. Three guards make this hold even for hand edits: `git_commit` from the gateway drops `.break-free/` from the commit in a worktree, a pre-commit hook in the repo's common hooks dir (`ledger_guard install`, installed automatically by `worktree_create` / the installer) refuses such commits, and `.github/workflows/break-free-ledger-guard.yml` fails any PR that touches `.break-free/`.

Knowledge flows to main through **`ledger_merge_from`** (and automatically on `ledger_resume` on main, and before `worktree_remove`): tasks merge by id (newer record wins field by field, logs unioned), notes by slug (identical or contained → keep the fuller one; divergent → main's text kept and the worktree's appended under `## From <worktree>`), journal lines are unioned with a `[worktree]` prefix. Idempotent — nothing is ever lost, main's entries are never overwritten silently. `ledger_merge_from {commit:true}` commits the absorbed ledger on main (never pushes).

Lead's rule on main: `ledger_resume` (absorbs), review what came in, `ledger_merge_from {commit:true}`, then merge the code PR. Worker's rule in a worktree: use the ledger normally; never try to commit `.break-free/`; write a `worktree_handoff` before you stop.

## Guardrails the gateway enforces (set once, then forget)

- **Policy rules** — `configure_policy {rules:[{match:"vault/**", action:"deny"}, {match:"src/auth/**", action:"review", reason:"auth needs a second vendor"}], scope:"project"}`. `deny` paths are invisible and unwritable to workers; when a worker changes a `review` path, the gateway runs an independent review by a *different vendor* automatically (the verdict is in `meta.policy`; `reject` fails the task in `run_plan`). Put these in `.model-gateway.json` so they travel with the repo.
- **Budgets** — `configure_budget {per_task_usd, per_plan_usd, per_day_usd}`; `cost_report` shows spend per day/provider/model at list prices (`pricing` overrides). A task stops at its cap, a plan cancels its remaining tasks, and new delegations are refused once the day cap is hit — say so to the user instead of retrying with the same cap. Every `meta:` line carries `cost_usd`.
- **Worker notes are quarantined** — `ledger_note` from a worker lands with `trust: worker, pending: true`: it is NOT injected into other workers until you `note_review {slug, action:"promote"}`; `reject` moves it to `notes/rejected/`. A worker can never overwrite your note — its text is appended as a pending proposal. `ledger_resume` lists what is waiting. Review them; do not promote blindly, this is the prompt-injection boundary between models.
- **Overlaps** — `worktree_list.overlaps` and the worker prompt flag when two live worktrees changed the same files or one's declared `paths` claim covers the other's changes. Claim paths on `worktree_register {paths:[…]}`.
- **Steward** — `steward` (or `node dist/index.js --steward` from cron; `break-free-steward` in the shell) absorbs overlays, reconciles worktrees, reports hygiene (`ledger_doctor`: stale notes, old tasks/journal, pending notes; `archive:true` moves, never deletes), refreshes the code map, runs `steward.verify` on main and journals the result. Run it at the start of a day on main.

## Capabilities (least privilege)

- `read` (default): files, grep, git diff/log.
- `write`: edit files in place (+ `ledger_note` / `ledger_task_log` so workers share knowledge and progress).
- `run`: `run_command` for allow-listed test/build/lint commands — give this to every implementation worker so it tests before reporting.
- `git`: branch/commit/push (never force, never `main`/`master`).
- `github`: issues, PRs, Actions via `gh`; merges only when the task says so.
- `mcp`: implied by `mcp_servers:[…]`; destructive tools (delete/remove/drop/…) are filtered out.

## Rules

- Delegate by default; do it yourself only when the task is small, needs the conversation's context, or the user asked you personally. Say what you delegated.
- Verification is specified by you and executed by the gateway/workers/reviewers — not narrated by you. No `verify` command and no review means the work is unverified; say so.
- Different vendor for reviewer/supervisor than for the worker.
- Parallelise: if two tasks don't depend on each other, they go in the same `run_plan`.
- Keep the ledger true: it is what the next session (yours, Codex's, or a human's) will read. `.break-free/` is plain Markdown — commit it; it opens as an Obsidian vault.
- Never put API keys in tasks or context. If every candidate fails, `list_providers` and tell the user which keys are missing.

## Updating break-free

The user can update to the latest Break Free at any time — say "update break-free" or run `/break-free-update`. Read the install source from `~/.config/model-gateway/last-install.json` (`source_dir` field) and run `node <source_dir>/setup.mjs --update`, which `git pull --ff-only`s the source and re-runs the installer hands-free, keeping keys, models, aliases, scope and every wired harness. Report the PASS/WARN/FAIL verdict it prints; if anything fails, fix what it says before retrying. After a successful update, remind the user to restart their harness.

## Arguments

`/break-free-model-gateway <mode> <task>`: `$0` is the mode (`delegate`, `plan`, `review`, `panel`, `supervise`, `resume`; default `plan` for multi-part work, `delegate` otherwise), the rest is the task.

## Finding a tool that is not listed

break-free advertises execution and its lifecycle permanently — `delegate`, `run_plan`,
`supervise`, `review`, the `job_*` tools, `ledger_resume`, `list_models`. Everything else named
in this skill — worktrees, tasks, notes, provider and alias configuration, sessions, harnesses,
cost, the steward — is registered but not advertised, because a tool's schema is sent
to you in every session and re-sent every turn whether or not you call it.

If a tool this skill mentions is not in your tool list, it is not missing:

    bf_discover {}                          the operations available
    bf_discover {operation: "note_write"}   that one's full schema
    bf_invoke {operation: "note_write", arguments: {...}}

Arguments are validated exactly as they would be if the tool were advertised. Set
`context.toolProfile` to `"full"` to advertise everything instead.

Firstmate sessions are the exception. A crewmate (`FM_TASK_ID` set) or a Firstmate primary home
sees only `bf_discover` and `bf_invoke`, and they reach a fixed set of operations: `panel`,
`review` and `list_models` for a crewmate; model configuration, provider tests, logs and cost for
a primary. Anything else is refused because Firstmate owns that work. Set `firstmate.mode` to
`"off"` to keep standalone behaviour.
