# Operating Break Free

## Runtime log & diagnosing problems

Every MCP call, every provider attempt (with the fallback reason), and every tool a worker invoked is appended as one JSON line to `~/.config/model-gateway/gateway.log` (mode 0600, rotated at 10 MB × 3; path via `logFile` in config or `MODEL_GATEWAY_LOG`; `"logFile": false` disables). API keys and anything that looks like a token are redacted before writing; git SHAs are left alone. Events share a `call` id so one delegation can be reconstructed end to end:

```
{"ts":"…","kind":"tool.start","call":"mtx3-1","tool":"delegate","args":{"task":"hi","model":"kimi,deepseek"}}
{"ts":"…","kind":"route.attempt","call":"mtx3-1","spec":"kimi/kimi-k2.7-code","ok":false,"reason":"auth","status":401,"ms":69}
{"ts":"…","kind":"route.attempt","call":"mtx3-1","spec":"deepseek/deepseek-v4-flash","ok":true,"ms":812,"usage":{…}}
{"ts":"…","kind":"worker.tool","call":"mtx3-1","name":"read_file","ok":true,"ms":3,"model":"deepseek/deepseek-v4-flash"}
{"ts":"…","kind":"tool.end","call":"mtx3-1","tool":"delegate","ok":true,"ms":1420,"meta":{"model":"deepseek/deepseek-v4-flash","fallback_attempts":["kimi/kimi-k2.7-code [auth]"]}}
```

Three ways to read it:
- `node setup.mjs --doctor` — a "Runtime log" section with per-provider success rates, dominant failure reasons, a fix per provider, and pattern findings such as *"kimi: every one of the last 8 attempts failed (auth×8)"*.
- From inside Claude Code / Codex: *"run gateway_logs"* — the same analysis as a tool, with `raw:true` / `kind:` / `call:` filters. The skill tells the agent to check it before blaming a model.
- `node model-gateway/dist/index.js --logs 200 | jq` for scripts.

## Operational notes
- Sessions live in `~/.config/model-gateway/sessions/<id>.json` (trimmed to `defaults.maxSessionMessages` / `maxHistoryChars`). `--stateless` for CI.
- Long runs: Claude Code moves tool calls > 2 min to background automatically; for Codex set `tool_timeout_sec`. Per-provider `timeoutMs` is configurable.
- DeepSeek thinking mode: `configure_provider provider=deepseek extra_body={"thinking":{"type":"enabled"}}` (reasoning is stripped from the reply; only the answer is returned).
- Z.AI coding-plan subscribers: `configure_provider provider=zai base_url=https://api.z.ai/api/coding/paas/v4`.
- Add any OpenAI-compatible endpoint: `configure_provider provider=lmstudio base_url=http://localhost:1234/v1` (set `requiresKey:false` in the config file for unauthenticated servers).
- Startup messages also go to stderr (`[model-gateway] …`), visible in Claude Code's MCP debug output; the durable record is `gateway.log` above.

## break-free-github-flow: work tracking, CI and deployment discipline (optional)

Installed by `setup.mjs` when you say yes at the "GitHub work tracking" step (or `"github_flow": "full" | "skill" | "none"` in an answers file). It is a second skill for Claude Code and Codex — `agent-config/*/skills/break-free-github-flow` — with three slash commands and an optional standing rule.

What the agent then does on every engineering task in a GitHub repo:

1. **Start** — finds an existing issue (`gh issue list --search`) or creates one from `templates/issue.md` with *Problem / goal, Context, Proposed approach, Test criteria, Success criteria, Out of scope*, tells you the number, and names the branch `<type>/<num>-<slug>`.
2. **During** — comments on the issue at real milestones (plan changed, decision, blocker); delegated workers carrying the `github` capability comment too.
3. **Finish** — posts `templates/completion.md`: what changed (files/PR), how each test criterion was verified with actual output, CI/deployment state, follow-ups; closes the issue only if the success criteria are met.
4. **Push / merge / deploy** — watches the run it caused (`gh run watch --exit-status`); on failure reads `--log-failed`, diagnoses code vs workflow YAML vs secrets vs environment, fixes the cause and pushes again — re-running only for demonstrably transient failures; checks deployment status and health separately from "workflow green"; treats a red main branch as an incident.

The model-gateway skill likewise gets a short **delegation rule** in `~/.claude/CLAUDE.md` (Claude Code) and `~/.codex/AGENTS.md` (Codex), so both agents consider handing off sizeable or routine work without needing trigger words. For github-flow, `full` also appends a short **standing rule** to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (and the project's `CLAUDE.md`/`AGENTS.md` for project scope) so the policy applies even when a prompt doesn't look like "engineering work". `skill` installs the skill and commands only. Commands: `/break-free-issue [n | description]`, `/break-free-ci [run-id | workflow | branch]`, `/break-free-wrap-up [n]`. Needs `gh auth login` (or `GH_TOKEN`); a fine-grained PAT with Contents/Issues/Pull requests/Actions/Workflows RW is enough. `--uninstall` removes the skills, commands and rules cleanly.
