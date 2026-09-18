# Claim sources

Every line the videos say, and the thing that makes it true. Anything that cannot be
traced to code, a passing test, or `SKILL.md` does not get said.

`SKILL.md` below means `agent-config/claude/skills/break-free-model-gateway/SKILL.md`.
Test names are from `model-gateway/test/gateway.test.mjs` (46 passing).

## Cut from the previous version

| Claim that shipped | Why it is wrong |
|---|---|
| "The frontier model leads, other models execute" | Implies the lead picks the crew. The user names the worker: SKILL.md "Routing 'use X to do Y'". |
| "Decides which vendor does what" | Attributed a user decision to the model. |
| "Break Free splits the job in two" | Framed the product as an automatic split. It executes an instruction the user gives. |
| Harness hand-off absent entirely | `harness_spawn`/`harness_send` is half the product and was never mentioned. |
| "One MCP server that you install once" (as the whole what) | True but not the point; the point is what you can then say. |

## Claims kept, with sources

| Claim | Source |
|---|---|
| You say "use X to do Y" and it routes on what X is | SKILL.md, "Routing 'use X to do Y'" table |
| A model name delegates to a worker model | SKILL.md routing table; `delegate` tool |
| A harness name opens that harness in a tmux session | SKILL.md, "Harness sub-agents"; test: "harness sub-agents: spawn, send, read, status, list, close over tmux" |
| A harness sub-agent runs on the subscription, not metered API calls | SKILL.md: "interactive mode ... not `claude -p`, which bills the API per token" |
| You give the check; the gateway runs it after the worker | test: "delegate.verify is run by the gateway and reported honestly" |
| Work runs in parallel, dependants are skipped when a check fails | test: "run_plan runs independent tasks in parallel, honours dependencies, hands results down and skips dependants of failures" |
| Review goes to a different vendor and returns a structured verdict | test: "review returns a parsed JSON verdict with a real git diff attached"; "run_plan review gate rejects on 'reject' and flags 'revise'" |
| No shell for workers; only allow-listed commands | test: "run capability executes only allow-listed commands without a shell" |
| Push is refused on protected branches | test: "write capability gates write_file; git_push refuses protected branch" |
| Decisions and gotchas reach every worker | SKILL.md `note_write`: notes tagged decision/gotcha/convention "are injected into every worker automatically" |
| The ledger is Markdown in the repo and survives sessions | test: "ledger: tasks, notes, resume brief, worker context and run_plan tracking persist as Markdown" |
| The report names the model that actually answered | SKILL.md, Model specs: "the `meta:` footer says which model actually answered" |
