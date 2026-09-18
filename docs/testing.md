# Testing

**Unit/e2e without any API key** (mock provider, ~2 s):
```bash
cd model-gateway && npm test
```
covers (46 tests): tool listing, provider usability + `${ENV}` keys, alias chains, live `/models`, fallback on 429/401/500/404/timeout and the global chain, `retryOn` enforcement, jailed reads (denied `.env`, blocked `../`), write gating, protected-branch push refusal, gh tool exposure, session persistence, review JSON with real diff, parallel panel + judge, supervise revise→accept, config persistence with 0600, git/gh option-injection refusal, secret-staging prevention, project-config sanitising, runtime log + redaction, harness context injection — and v3: MCP bridge discovery (config + `.mcp.json`, self excluded) with destructive-tool filtering and per-call lending, `run` capability allow-list without a shell, gateway-side `verify` (honest pass/fail/refused), supervise unable to accept a failing verification, `run_plan` parallelism/dependencies/context hand-down/skip-on-failure/cycle detection, review gate, async jobs (status/result/cancel/persistence), the ledger end to end (tasks, notes, resume brief, worker injection, worker notes, run_plan tracking, journal), `code_map`, token/job/MCP stats in `gateway_logs`, the Codex Responses-API shim (request translation, streaming events, tool-call reassembly, reasoning, error mapping), project-scope model switching, the worktree registry (two gateway instances in two checkouts sharing one registry, merged/deleted detection, reasons, hand-offs, guarded removal), ledger safety across worktrees (overlay, guard hook, absorb/merge semantics, merge leaves main's ledger untouched), cost accounting with task/plan/day caps, policy deny/review enforcement, worker-note quarantine and review, worktree overlap detection, and the steward routine.

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
