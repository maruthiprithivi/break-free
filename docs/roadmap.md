# Roadmap

Done in 3.3: note quarantine, cost & budgets, policy rules, worktree overlaps, steward, self-update (`setup.mjs --update` / `/break-free-update`), `--stats`/`--clean` utilities, and 21 extra agents — Gemini CLI, Copilot CLI, Cursor, Goose, Amp, Hermes, Aider, Cline, AdaL, OpenClaw, Droid, Kilo, Roo, Qoder, Zed on top of opencode/kiro/kimi/agy/pi/omp, with every AGENTS.md-reading tool covered at project scope. Next, in order:

1. **Events + harness hooks + hand-off packs.** A small local event log (`.git/break-free/events.jsonl`) and `bf watch` / desktop notifications when a worktree is blocked, hands off, or a job finishes; harness hooks (Claude Code hooks, Codex notify) that register the worktree and heartbeat at session start; `handoff_pack` that bundles task, overlay, transcript summary and the exact command to continue in another harness.
2. **Scorecards → evidence-based routing → semantic search.** Per-task-type scorecard from review verdicts, verify pass rates, latency and cost; a `route` recommendation used by `run_plan` when `model` is omitted; local-embedding search over notes/journal/outcomes so workers get the notes relevant to *their* task.
3. **Repo vitals, real-CLI tests, dashboard.** Tests/lint/coverage per commit in the ledger; CI against the real harness CLIs; a local HTML dashboard generated from ledger + registry + log.
4. **Multi-machine registry** via a git ref or a small shared store; MCP over HTTP for remote/IDE harnesses.
