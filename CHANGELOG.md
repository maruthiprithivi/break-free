# Changelog

## Unreleased
- **A tier floor, so fallback never quietly gets weaker.** Every model carries a tier (3 frontier, 2 solid, 1 small/local) from `DEFAULT_TIERS`, overridable per provider or per `provider/model` in `tiers`. The floor for a call is the tier of the model actually asked for, so a tier 3 request is never answered by tier 1 behind the caller's back. `delegate`, `supervise` and each `run_plan` task take `min_tier` and `allow_downgrade`; globally there are `fallback.minTier` and `fallback.allowDowngrade`. When every candidate above the floor fails, the error names what was held back rather than reading like a provider outage. A downgrade that does happen is reported — `meta` carries `requested_model`, `tier` and `downgraded`, and `run_plan` prints `route: strong -> ollama/qwen3-coder:30b (auth) [tier 3 -> 1]` — while a same-tier fallback stays quiet.

## 3.4.0 — 2026-09-18
- **CI and deployments are blocking work.** A successful `git_push` or `gh_merge_pr` enqueues a `ci.pending` event for that commit, and the watcher resolves it by asking `gh` for the run's conclusion, in shell rather than through a model. Success drains silently; failure becomes a blocking `ci.failed` carrying the run URL and failing job, so the turn-end guard will not let the turn end on top of it. A green workflow is not treated as a healthy deploy: where the commit has deployments, their own status must succeed too. Bounded by `fleet.ciTimeoutMs` (20 minutes) and fully inert when `gh` is missing or unauthenticated, so an unverifiable run can never wedge a session.
- **Event-driven fleet supervision.** `src/fleet.ts` turns a snapshot diff (job states, harness pane digests) into actionable wake events on a durable append-only queue, with the drain cursor in a separate file so a crash between appending and draining cannot lose a wake-up. `fleet_status` exposes it; `--fleet-check` prints the same object and always exits 0.
- **Turn-end guard.** The installer now writes exactly one Claude Code `Stop` hook calling `--fleet-check --hook`, so the lead cannot silently end a turn while delegated work is still running. In hook mode the CLI prints a block decision when the fleet is busy, nothing at all when it is settled, always exits 0, and never writes to stderr. `--uninstall` removes it and leaves unrelated hooks intact; `--doctor` reports whether it is installed.
- **Crew aliases.** `ensign`, `commander`, `counselor`, `holodeck` and `subspace` resolve to the same chains as `fast`, `strong`, `reviewer`, `local` and `cloud`. Both names work. A crew alias points at the core alias by name, so it follows whatever that alias means at resolution time, including a user override; a regression test pins that.
- **Named project modes.** `mode` is one of `guarded` (default), `pr-only` or `local-only`, with `mergeAutonomy` as a separate opt-in. It derives `github.allowPush` / `github.allowMerge`, applied only where the raw config did not set them explicitly, so an explicit value still wins and every existing enforcement point picks the mode up unchanged. `mode` and `mergeAutonomy` are unreachable from an untrusted project `.model-gateway.json` (the sanitiser is an allowlist).
- **BREAKING: merge autonomy is now opt-in.** `github.allowMerge` previously defaulted to `true`, so a worker holding the `github` capability could merge a PR out of the box. Under `guarded` it now defaults to `false` unless `mergeAutonomy` is set. Push behaviour is unchanged. Set `"mergeAutonomy": true` to restore the old behaviour.
- **Scout task shape.** `shape: "ship" | "scout"` on `delegate`, `supervise` and `run_plan` tasks. A scout has its capabilities forced to `read` regardless of what was requested, and reports that it changed nothing — a read-only investigation with an obvious name instead of a hand-written capability list.
- **Visible crew.** `harness_spawn`, `harness_status` and `harness_list` return an `attach` command, so a tmux sub-agent can be watched or typed into rather than only read through `harness_read`.
- Install: `install.sh` works standalone — `curl -fsSL .../install.sh | bash` clones (or fast-forwards) `~/.break-free` (`BREAK_FREE_HOME`, `BREAK_FREE_BRANCH`), checks Node 20+ **before** writing anything, re-attaches `/dev/tty` so the interactive installer still prompts under a pipe, and passes flags through (`| bash -s -- --yes`).
- README rebuilt around the install experience: banner, pitch, videos, then Install as the first section — requirements table, a numbered walk through what the installer asks (replacing a 400-word paragraph), how to verify, and a symptom/cause/fix troubleshooting table. Reference material moved below.
- Visual assets: banner, a narrated intro covering why/what/how, and four scenario walkthroughs (delegate, run_plan in parallel, independent review, ledger and resume), all with burned-in subtitles and WebVTT tracks. Remotion source and the Docker render pipeline live in `videos/`.
- Distribution: no CI on this repo — install and update directly from GitHub. `setup.mjs --update` (and `/break-free-update`) self-update from a `git clone` (`git pull --ff-only` + hands-free re-install), reusing the scope/agents recorded in `last-install.json`.
- Harness support: Gemini CLI (MCP + skills + GEMINI.md), GitHub Copilot CLI, Cursor (MCP), Goose, Amp, Hermes, Aider, Cline, AdaL, OpenClaw, Droid, Kilo Code, Roo Code, Qoder and Zed — skills/rules in each tool's own conventions, with the exact manual-MCP step printed where a tool's MCP config can't be file-edited. Any tool that reads `AGENTS.md` + `.mcp.json` + `.agents/skills` (Crush, Windsurf, Trae, Junie, Warp, Continue, Augment, Freebuff, Devin) is covered at project scope.
- Re-install picks up the previous setup (`last-install.json`) and pre-selects the prior scope/agents/github-flow; the github-flow skill stays fully optional (`github_flow: "none"` skips it).
- New utilities: `setup.mjs --stats` (storage footprint + project/ledger/worktree stats) and `setup.mjs --clean` (reclaim disk: stale sessions/jobs + old log generations).
- Harness sub-agents over tmux: `harness_spawn`/`harness_send`/`harness_read`/`harness_status`/`harness_close`/`harness_list` run a task in *another coding harness* (Claude Code, Codex, omp, pi, grok, …) inside a detached tmux session — a real PTY — so the sub-agent runs in the interactive/subscription mode, not `claude -p` (print mode bills the API per token). Sessions persist under `sessions/harness/` for resume.

## 3.3.0 — 2026-09-15
- Worker-note quarantine: `ledger_note` output is `trust: worker, pending` and never injected until `note_review` promotes it; workers cannot overwrite lead notes.
- Cost accounting (`cost_report`, `meta.cost_usd`) with `configure_budget` caps per task / plan / day.
- Policy rules (`configure_policy`, `policy.rules`): `deny` paths hidden from workers; `review` paths trigger an automatic different-vendor review.
- Worktree overlap detection (changed files + declared `paths` claims) surfaced in `worktree_list` and worker prompts.
- `steward` / `--steward` maintainer routine and `ledger_doctor` hygiene with non-destructive archiving.

## 3.2.0 — 2026-09-15
- Ledger overlay per linked worktree (`.git/break-free/shadow/<branch>`), `ledger_merge_from` absorption with conservative merge semantics, pre-commit guard hook, PR guard workflow, `git_commit` strips `.break-free/` in worktrees.

## 3.1.0 — 2026-09-15
- Shared worktree registry (`worktree_*` tools; statuses with reasons; merged/deleted/inactive detection; hand-offs).
- Installer support for opencode, Kiro CLI, Kimi Code CLI, Antigravity, pi and oh-my-pi.

## 3.0.x — 2026-09-12/13
- MCP bridge (lend your MCP servers to workers), `run` capability, gateway-run `verify`, `run_plan` fan-out, async jobs, project ledger (tasks/notes/journal/handoff/code map), Codex Responses-API shim, chat-driven model switching at user/project scope, `break-free-*` naming, six-harness install.

## 2.x
- TypeScript rewrite of the original Go stub: providers, fallback chains, jailed worker tools, GitHub via `gh`, sessions, interactive installer with preflight/postflight, harness profiles, github-flow skill.
