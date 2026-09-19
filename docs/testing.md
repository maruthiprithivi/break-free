# Testing

**Unit/e2e without any API key** (mock provider, ~18 s):
```bash
cd model-gateway && npm test
```
covers (199 tests): tool listing, provider usability + `${ENV}` keys, alias chains, live `/models`, fallback on 429/401/500/404/timeout and the global chain, `retryOn` enforcement, jailed reads (denied `.env`, blocked `../`), write gating, protected-branch push refusal, gh tool exposure, session persistence, review JSON with real diff, parallel panel + judge, supervise revise→accept, config persistence with 0600, git/gh option-injection refusal, secret-staging prevention, project-config sanitising, runtime log + redaction, harness context injection — and v3: MCP bridge discovery (config + `.mcp.json`, self excluded) with destructive-tool filtering and per-call lending, `run` capability allow-list without a shell, gateway-side `verify` (honest pass/fail/refused), supervise unable to accept a failing verification, `run_plan` parallelism/dependencies/context hand-down/skip-on-failure/cycle detection, review gate, async jobs (status/result/cancel/persistence), the ledger end to end (tasks, notes, resume brief, worker injection, worker notes, run_plan tracking, journal), `code_map`, token/job/MCP stats in `gateway_logs`, the Codex Responses-API shim (request translation, streaming events, tool-call reassembly, reasoning, error mapping), project-scope model switching, the worktree registry (two gateway instances in two checkouts sharing one registry, merged/deleted detection, reasons, hand-offs, guarded removal), ledger safety across worktrees (overlay, guard hook, absorb/merge semantics, merge leaves main's ledger untouched), cost accounting with task/plan/day caps, policy deny/review enforcement, worker-note quarantine and review, worktree overlap detection, and the steward routine.

**Routing tests** run entirely offline against `src/jev-double.ts`, a deterministic TypeSafe endpoint (in-process, no clock, no randomness; the same request produces the same bytes):

| file | covers |
|---|---|
| `test/routing.test.mjs` | engine precedence (call → env → config), the policy globs, the rules table and its judgement/implementation split, lane mapping, the confidence threshold, both sensitivity modes, the single batched TypeSafe call and its question shape, the state budget and its fixed trim order, retry/backoff on 429/529, degradation to rules on 401 and on a malformed body, cost at `$0.042`/Mtok, ledger frontmatter round-trip, scorecard aggregation |
| `test/routing-e2e.test.mjs` | the real MCP server over stdio: a plan routed in one call, per-task models, the route table, escalation handing a task back un-run, ledger provenance and journal lines, scorecards, the `route` tool, `cost_report.routing_savings`, `overridden_by`, and `routing.engine: "off"` behaving exactly as before |
| `test/route-cli.test.mjs` | the `bf` contract: route table, bench guardrails, reproducibility, and the demo's three arms |
| `test/scenarios.test.mjs` | the 10-workflow comparison: the data set's label integrity, the cost model's machine-independence, the under-routing guardrail ordering (off > rules > Jev), and that a missing recording fails loudly instead of answering with defaults |

**Tripwire tests** — the same double, pointed at diffs:

| file | covers |
|---|---|
| `test/tripwire.test.mjs` | the decision rule in isolation (it is pure): `block` only from `test_weakened`/`destructive_data`/`risk` with `security_touch` and `scope_creep` stopping at review, the calibrated defaults (`blockAt` 0.99 means 0.97 reviews rather than rejects), every threshold configurable, hunk splitting and capping, the summary's reasons, and an unavailable provider reported as `unknown` rather than clean |
| `test/tripwire-e2e.test.mjs` | the real MCP server end to end: a worker that deletes the failing assertion while `verify` goes green is caught and blocked, a clean diff of the same shape is accepted, a `check` rule scopes it (a path outside the rule is never sent; no rule means no tripwire at all), a clean tripwire standing in for a blanket review says that it did, and an engine that cannot answer does not count as a clean one |
| `test/llm-arm.test.mjs` | the frontier-LLM baseline: tolerant parsing of what chat models actually return (fences, prose, an invented lane, a forgotten task), that the arm gets the same lane definitions Jev gets, that an unanswered chunk is escalated rather than guessed at, that an unpriced provider is reported UNPRICED rather than free, and that thinking tokens hidden from `completion_tokens` are still billed |
| `test/tripwire-cli.test.mjs` | the `bf bench tripwire` contract: the offline arm replays the recording rather than answering blank, a missing recording fails loudly, a recording for a *different* set is refused rather than scored as a flawless zero, and the published numbers are pinned on both corpora (seeded: 90% recall, 14% false flags, 0 false blocks; natural: 4% false flags over 175 real merged diffs) so a threshold change cannot silently invalidate the docs |

The bench, demo and scenario comparison replay `bench/jev-recording.json`, `bench/demo-recording.json` and `bench/scenario-recording.json` through the real TypeSafe client, so they need no key, as does `bf bench tripwire` with `bench/tripwire-recording.json`. **Both are live captures from api.typesafe.ai** (recorded 2026-09-19 against `jev-1.13.0`), not synthetic fixtures — only the latency column is re-measured. Regenerate with `bf bench route --live --record bench/jev-recording.json` (needs `TYPESAFE_API_KEY`); `bench/make-recording.mjs` produces a
stand-in for contributors without a key.

**Provider status** (no calls made):
```bash
node dist/index.js --selftest          # exit 0 if ≥1 provider usable
```

**Real round-trip per provider** — inside Claude Code / Codex:
> "run test_provider for deepseek, kimi, zai, minimax, openrouter, opencode, ollama and ollama-cloud and show me a table"

or, without an agent, with the MCP inspector:
```bash
npx @modelcontextprotocol/inspector node dist/index.js
```
then call `list_providers` (`probe:true`) and `test_provider` (`spec:"deepseek"`). `test_provider` reports latency, the reply, and whether tool-calling works for that model.

**Exercise the mock provider interactively** (no keys):
```bash
node test/mock-provider.mjs &                  # http://127.0.0.1:8787/v1, key test-key
export MODEL_GATEWAY_CONFIG=/tmp/mg.json
cat > /tmp/mg.json <<'EOF'
{"providers":{"mock":{"baseUrl":"http://127.0.0.1:8787/v1","apiKey":"test-key"}},
 "aliases":{"fast":["mock/flaky429","mock/good"]},"fallback":{"chain":["mock/good"]}}
EOF
npx @modelcontextprotocol/inspector node dist/index.js
```
`delegate` with `model:"fast"` shows the 429 fallback in `meta`.

**Installer self-check**: `node setup.mjs --doctor` any time; `bash setup/selftest.sh` to test the installer itself in isolation.

**End-to-end in Claude Code**:
1. `claude mcp list` → `break-free-gateway … ✓ Connected`.
2. `/break-free-model-gateway` (or "list providers") → table of usable providers.
3. `/delegate local summarise what src/index.ts does` (Ollama running) — check the `meta.model` line.
4. Make an uncommitted change → `/review HEAD` → JSON verdict with file:line issues.
5. `/panel …` with three vendors → three seats + judge synthesis; a seat whose key is missing is reported as failed/fell back, not silently dropped.
6. In a throwaway repo with `gh` authenticated: `delegate` with `capabilities:["github"]`, task "create branch test/gateway, add hello.txt, commit, push, open a draft PR; do not merge" → PR appears; then ask it to `git_push` on `main` → refused.
