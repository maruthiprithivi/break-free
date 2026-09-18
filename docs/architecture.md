# Architecture and layout

## The operating model

| Lead (Claude Code / Codex, frontier model) | Crew (DeepSeek, Kimi, GLM, MiniMax, Ollama, …) | Gateway (this server) |
|---|---|---|
| Talks to the user; decomposes the goal into self-contained tasks with dependencies | Executes one task each, in parallel, with jailed tools | Schedules the graph with bounded concurrency; hands prerequisite reports to dependants |
| Writes acceptance criteria and **the `verify` command** for each task | Runs tests itself (`run` capability) before reporting | **Runs `verify` after the worker** — real exit code, cannot be faked; failure blocks dependants |
| Decides which vendor does what (`fast`/`strong`/`local`, different vendor for review) | Records decisions/gotchas it hits (`ledger_note`) | Routes with fallback; injects CLAUDE.md/AGENTS.md, skills and ledger knowledge into every worker |
| Reads the consolidated report, diffs, review verdicts; pushes back; commits; owns the result | | Tracks every task, outcome and verification in `.break-free/` so any later session resumes |

The `break-free-model-gateway` skill (auto-invoked via a CLAUDE.md / AGENTS.md rule) carries this doctrine: *delegate execution by default, keep judgement, specify verification instead of narrating it, keep the ledger true.*

## The picture

```
Claude Code / Codex  ──MCP(stdio)──▶  break-free-gateway
   (lead)                              ├─ run_plan    N tasks as a dependency graph, parallel, per-task model/caps/verify/review
                                       ├─ delegate    one worker (+ verify command, session, lent MCP servers, async)
                                       ├─ supervise   worker ⇄ supervisor loop; failing verification can't be accepted
                                       ├─ review      independent scrutiny (different vendor) → JSON verdict
                                       ├─ panel       N models in parallel + judge
                                       ├─ jobs        async delegations/plans: status, result, cancel; persisted
                                       ├─ ledger      .break-free/ tasks · notes · journal · HANDOFF.md · CODE-MAP.md (Obsidian-ready)
                                       ├─ mcp bridge  lends the lead's other MCP servers to workers (destructive tools filtered)
                                       ├─ router      alias → [candidates…] + global chain, retry/fallback
                                       └─ worker tools read_file/search/git_diff · write_file/edit_file · run_command (allow-list) ·
                                                      git_commit/push (no force, no main) · gh issues/PRs/Actions · mcp__<server>__<tool>
```

Two things in that picture do the real work. `verify` is a shell command **the gateway runs after the worker finishes**, so a pass is an exit code rather than a claim. The ledger is plain Markdown inside your repository, so the next session — or the next person — starts from what already happened.

## Repository layout

```
model-gateway/            the MCP server (npm project)
  src/                    index (tools) · config · providers · client · router · agent · workspace · github · runcmd · mcpbridge · jobs · ledger · worktrees · policy · steward · codemap · serve · sessions · orchestrate · prompts · harness · logger
  test/                   mock OpenAI-compatible provider + mock MCP server + 46 e2e tests
  config.example.json
agent-config/
  claude/skills/break-free-model-gateway/SKILL.md     Claude Code skill (auto- and /model-gateway-invocable)
  claude/skills/break-free-github-flow/               work-tracking / CI / deployment skill (optional install)
  claude/commands/break-free-{plan,resume,model,worktree,delegate,review,panel,supervise,update,issue,ci,wrap-up}.md
  claude/mcp.json.example                  project-scoped registration
  codex/skills/break-free-model-gateway/SKILL.md      Codex skill (+ agents/openai.yaml)
  codex/config.toml.snippet · codex/AGENTS.md.snippet
setup.mjs · setup/       interactive installer, doctor, uninstaller (+ selftest.sh, answers.example.json)
install.sh                thin wrapper around setup.mjs
```
