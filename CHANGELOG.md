# Changelog

## Unreleased

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
