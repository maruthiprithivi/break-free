# Changelog

## Unreleased
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
