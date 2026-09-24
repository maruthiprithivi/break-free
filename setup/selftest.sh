#!/usr/bin/env bash
# Exercises setup.mjs end-to-end WITHOUT touching your real ~/.claude, ~/.codex or keys:
# fake `claude`/`codex` CLIs, a throwaway HOME, a mock OpenAI-compatible provider, a temp git repo.
# Runs: install (non-interactive) -> doctor -> uninstall -> doctor (expects RED).
#   bash setup/selftest.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d /tmp/mg-selftest-XXXXXX)"
trap 'kill $MOCK_PID 2>/dev/null || true; [ -f "$T/home/.config/model-gateway/serve.pid" ] && kill "$(cat "$T/home/.config/model-gateway/serve.pid")" 2>/dev/null; [ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/bin" "$T/proj"
( cd "$T/proj" && git init -q -b main )

cat > "$T/bin/claude" <<'EOF'
#!/usr/bin/env bash
DB="${MODEL_GATEWAY_HOME_OVERRIDE}/claude-mcp.txt"
case "$1 $2" in
  "--version ") echo "fake-claude 1.0";;
  "mcp add") shift 2; echo "$@" > "$DB"; echo "Added";;
  "mcp get") [ -f "$DB" ] && { echo "break-free-gateway:"; echo "  Command: $(cat "$DB")"; } || { echo "No MCP server found" >&2; exit 1; };;
  "mcp remove") rm -f "$DB"; echo removed;;
  "mcp list") [ -f "$DB" ] && echo "break-free-gateway: ok";;
  *) echo "unknown $*" >&2; exit 1;;
esac
EOF
cat > "$T/bin/codex" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "--version ") echo "fake-codex 1.0";;
  "mcp list") grep -o '^\[mcp_servers\.[a-z_]*\]' "${MODEL_GATEWAY_HOME_OVERRIDE}/.codex/config.toml" 2>/dev/null | sed 's/\[mcp_servers\.//; s/\]//';;
  *) echo "unknown $*" >&2; exit 1;;
esac
EOF
for b in opencode kiro-cli kiro kimi kimi-cli agy antigravity pi omp gemini copilot hermes aider cline adal openclaw goose amp droid kilo roo qoder zed; do printf '#!/usr/bin/env bash\necho "fake $0"\n' > "$T/bin/$b"; done
mkdir -p "$T/home/.config/opencode" && printf '{ "$schema": "https://opencode.ai/config.json", "model": "x/y", "mcp": { "other": { "type": "remote", "url": "https://x" } } }\n' > "$T/home/.config/opencode/opencode.json"
mkdir -p "$T/home/.cursor"
chmod +x "$T/bin/"*

( cd "$ROOT/model-gateway" && [ -d node_modules ] || npm install --silent --no-audit --no-fund )
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
MOCK_PORT="$(free_port)"
SHIM_PORT="$(free_port)"
while [ "$SHIM_PORT" = "$MOCK_PORT" ]; do SHIM_PORT="$(free_port)"; done
export BREAK_FREE_SERVE_PORT="$SHIM_PORT"
PORT="$MOCK_PORT" node "$ROOT/model-gateway/test/mock-provider.mjs" > "$T/mock.log" 2>&1 &
MOCK_PID=$!
sleep 1

mkdir -p "$T/home/.config/model-gateway"
cat > "$T/home/.config/model-gateway/config.json" <<EOF
{ "providers": { "deepseek": { "baseUrl": "http://127.0.0.1:$MOCK_PORT/v1", "defaultModel": "good" } } }
EOF
cat > "$T/answers.json" <<EOF
{ "fix_stale_wire_api": true, "extra_agents": "detected", "extra_scope": "both", "claude_scope": "both", "codex_scope": "both", "project_dir": "$T/proj", "key_storage": "config",
  "deepseek_key_source": "paste", "deepseek_api_key": "test-key",
  "kimi_key_source": "skip", "zai_key_source": "skip", "minimax_key_source": "skip", "openrouter_key_source": "skip", "opencode_key_source": "skip", "ollama-cloud_key_source": "skip",
  "firstmate": true, "ollama_enabled": false, "vllm_enabled": false, "fallback_chain": "deepseek/good", "skip_tests": false, "github_flow": "full", "harness_profiles": true, "harness_shell_rc": true }
EOF

# An agent config that exists but is EMPTY. Zero bytes is not corruption: there is no
# configuration there to lose, so the install must seed it rather than refuse and go RED.
mkdir -p "$T/home/.gemini/config" && : > "$T/home/.gemini/config/mcp_config.json"

REAL_GIT="$(command -v git)"
export MODEL_GATEWAY_HOME_OVERRIDE="$T/home" PATH="$T/bin:$PATH" NO_COLOR=1

# A local stand-in for the firstmate upstream, so provisioning is exercised without network.
FMUP="$T/firstmate-upstream"
mkdir -p "$FMUP/bin"
printf '# firstmate\n\nhard rule 1\n' > "$FMUP/AGENTS.md"
printf '#!/usr/bin/env bash\necho "reread-firstmate: no"\necho "restart-secondmates: none"\necho "nudge-secondmates: none"\n' > "$FMUP/bin/fm-update.sh"
chmod +x "$FMUP/bin/fm-update.sh"
"$REAL_GIT" -C "$FMUP" init -q -b main
"$REAL_GIT" -C "$FMUP" -c user.name=t -c user.email=t@t add -A
"$REAL_GIT" -C "$FMUP" -c user.name=t -c user.email=t@t commit -q -m "firstmate"
export BREAK_FREE_FIRSTMATE_ORIGIN="$FMUP"

fail() { echo "SELFTEST FAIL: $1" >&2; exit 1; }

mkdir -p "$T/home/.claude/skills/model-gateway" "$T/home/.claude/commands" "$T/home/.agents/skills/github-flow"
echo "old" > "$T/home/.claude/skills/model-gateway/SKILL.md"; echo "uses model-gateway" > "$T/home/.claude/commands/delegate.md"; echo "old" > "$T/home/.agents/skills/github-flow/SKILL.md"
mkdir -p "$T/home/.codex" && printf '[mcp_servers.model_gateway]\ncommand = "node"\n\n[model_providers.mine]\nname = "mine"\nbase_url = "http://localhost:11434/v1"\nwire_api = "chat"\n' > "$T/home/.codex/config.toml"
printf '# my rules\n\n<!-- Append to your repo'"'"'s AGENTS.md (or ~/.codex/AGENTS.md for all projects). -->\n\n## Delegating to other models\n\nThe `break_free_gateway` MCP server is available. Use the `break-free-model-gateway` skill old text.\n' > "$T/home/.codex/AGENTS.md"
mkdir -p "$T/home/.claude" && printf '# mine\n\n## Delegating to other models (break-free-model-gateway)\nOLD VERSION of the rule.\n' > "$T/home/.claude/CLAUDE.md"
cat >> "$T/home/.claude/CLAUDE.md" <<'EOF'
## Crew, worktrees and merge authority (firstmate)
Obsolete crew rule.
## My instructions
Keep this section verbatim.
EOF
mkdir -p "$T/home/.omp/agent" && cat > "$T/home/.omp/agent/AGENTS.md" <<'EOF'
## Crew, worktrees and merge authority (firstmate)
Obsolete crew rule.
## My instructions
Keep this section verbatim.
EOF
cat > "$T/home/.claude/settings.json" <<'EOF'
{
  "permissions": { "allow": ["Bash(echo hi:*)"] },
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "echo unrelated-stop" } ] }
    ]
  }
}
EOF

echo "### install"
node "$ROOT/setup.mjs" --answers "$T/answers.json" > "$T/install.out" 2>&1 || fail "install exited non-zero (see $T/install.out)"
grep -q "MCP handshake ok" "$T/install.out" || fail "no MCP handshake"
grep -q "through MCP: deepseek/good" "$T/install.out" || fail "provider call through MCP failed"
grep -q "GREEN" "$T/install.out" || fail "not GREEN"
grep -q "is not valid JSON" "$T/install.out" && fail "an empty (0-byte) agent config was treated as corrupt"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!j.mcpServers["break-free-gateway"])process.exit(1)' "$T/home/.gemini/config/mcp_config.json" || fail "empty agy mcp_config.json was not seeded with the server"
grep -q "PASS  self-tests" "$T/install.out" || fail "self-tests step did not pass (see $T/install.out)"
[ -f "$T/home/.claude/skills/break-free-model-gateway/SKILL.md" ] || fail "claude user skill missing"
[ ! -d "$T/home/.claude/skills/model-gateway" ] || fail "legacy claude skill not removed"
[ ! -f "$T/home/.claude/commands/delegate.md" ] || fail "legacy command not removed"
[ ! -d "$T/home/.agents/skills/github-flow" ] || fail "legacy codex skill not removed"
grep -q 'mcp_servers.model_gateway' "$T/home/.codex/config.toml" && fail "legacy codex table not removed"
[ -f "$T/home/.agents/skills/break-free-model-gateway/SKILL.md" ] || fail "codex user skill missing"
[ -f "$T/home/.claude/skills/break-free-github-flow/SKILL.md" ] || fail "github-flow claude skill missing"
[ -f "$T/home/.claude/commands/break-free-wrap-up.md" ] || fail "github-flow commands missing"
[ -f "$T/proj/.agents/skills/break-free-github-flow/SKILL.md" ] || fail "github-flow codex project skill missing"
grep -q "Work tracking (break-free-github-flow)" "$T/home/.claude/CLAUDE.md" || fail "CLAUDE.md rule missing"
grep -q "Delegating to other models (break-free-model-gateway)" "$T/home/.claude/CLAUDE.md" || fail "CLAUDE.md delegation rule missing"
grep -q "OLD VERSION" "$T/home/.claude/CLAUDE.md" && fail "stale CLAUDE.md rule not replaced"
grep -q "^# mine" "$T/home/.claude/CLAUDE.md" || fail "user's own CLAUDE.md content lost"
grep -q 'Keep this section verbatim.' "$T/home/.claude/CLAUDE.md" || fail "Claude rule migration ate the adjacent section"
grep -q 'Keep this section verbatim.' "$T/home/.omp/agent/AGENTS.md" || fail "omp rule migration ate the adjacent section"
grep -q 'In a session launched by Firstmate (a `FIRSTMATE_OP` launch brief)' "$T/home/.claude/CLAUDE.md" || fail "Claude carve-out missing"
grep -q 'In a session launched by Firstmate (a `FIRSTMATE_OP` launch brief)' "$T/home/.codex/AGENTS.md" || fail "Codex carve-out missing"
node - "$ROOT" "$T/home/.claude/CLAUDE.md" "$T/home/.codex/AGENTS.md" <<'NODE' || fail "adjacent delegation or work tracking section changed beyond the carve-out"
const fs = require('fs');
const path = require('path');
const [root, claude, codex] = process.argv.slice(2);
for (const [file, snippet] of [
  [claude, 'claude/CLAUDE.gateway.snippet'],
  [claude, 'claude/CLAUDE.md.snippet'],
  [codex, 'codex/AGENTS.md.snippet'],
  [codex, 'codex/AGENTS.github-flow.snippet'],
]) {
  if (!fs.readFileSync(file, 'utf8').includes(fs.readFileSync(path.join(root, 'agent-config', snippet), 'utf8').trim())) process.exit(1);
}
NODE
[ "$(grep -c "Delegating to other models" "$T/home/.codex/AGENTS.md")" = "1" ] || fail "codex AGENTS.md should have exactly one delegation rule (v2 removed, v3 added)"
grep -q "run_plan" "$T/home/.codex/AGENTS.md" || fail "codex AGENTS.md rule is not the v3 rule"
grep -q "old text" "$T/home/.codex/AGENTS.md" && fail "v2 codex rule not removed"
grep -q "Delegating to other models" "$T/proj/AGENTS.md" || fail "project AGENTS.md delegation rule missing"
grep -q "Work tracking (break-free-github-flow)" "$T/proj/AGENTS.md" || fail "project AGENTS.md rule missing"
grep -q '\[mcp_servers.break_free_gateway\]' "$T/home/.codex/config.toml" || fail "codex toml missing"
grep -q 'break-free-gateway' "$T/proj/.mcp.json" || fail "project .mcp.json missing"
[ -f "$T/proj/.codex/config.toml" ] || fail "project codex toml missing"
[ -f "$T/proj/.github/workflows/break-free-ledger-guard.yml" ] || fail "ledger guard workflow missing"
grep -q "break-free ledger guard" "$T/proj/.git/hooks/pre-commit" || fail "ledger guard hook missing"
[ "$(stat -c %a "$T/home/.config/model-gateway/config.json" 2>/dev/null || stat -f %Lp "$T/home/.config/model-gateway/config.json")" = "600" ] || fail "config not 0600"
grep -q -- '--fleet-check --hook' "$T/home/.claude/settings.json" || fail "Stop hook missing after install"
echo "ok"

echo "### firstmate provisioning"
[ -f "$T/home/.break-free/firstmate/AGENTS.md" ] || fail "firstmate was not cloned"
grep -q '"pin"' "$T/home/.config/model-gateway/config.json" || fail "firstmate was cloned but not pinned"
grep -R -F -q "Crew, worktrees and merge authority (firstmate)" "$T/home" "$T/proj" && fail "install left a firstmate standing rule"
# Migration must preserve the neighbouring delegation rule.
grep -q "Delegating to other models" "$T/home/.omp/agent/AGENTS.md" || fail "omp lost its delegation rule when the firstmate rule was added"
grep -q "firstmate" "$T/install.out" || fail "the install said nothing about firstmate"
echo ok

echo "### install idempotence (Stop hook)"
node "$ROOT/setup.mjs" --answers "$T/answers.json" > "$T/install2.out" 2>&1 || fail "second install exited non-zero (see $T/install2.out)"
[ "$(grep -c -- '--fleet-check --hook' "$T/home/.claude/settings.json")" = "1" ] || fail "Stop hook should appear exactly once after re-install"
echo "ok"

echo "### other agents"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!j.mcp["break-free-gateway"]||j.mcp["break-free-gateway"].type!=="local"||!j.mcp.other||j.model!=="x/y")process.exit(1)' "$T/home/.config/opencode/opencode.json" || fail "opencode.json not merged correctly"
[ -f "$T/home/.config/opencode/skills/break-free-model-gateway/SKILL.md" ] || fail "opencode skill missing"
[ ! -d "$T/home/.config/opencode/skills/break-free-model-gateway/agents" ] || fail "codex-only agents/ dir should be stripped"
grep -q "Delegating to other models (break-free-model-gateway)" "$T/home/.config/opencode/AGENTS.md" || fail "opencode AGENTS.md rule missing"
grep -q "break-free-gateway" "$T/home/.config/opencode/AGENTS.md" || fail "generic rule should name break-free-gateway"
grep -q 'break_free_gateway' "$T/home/.config/opencode/AGENTS.md" && fail "generic rule must not mention the codex server name"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!j.mcpServers["break-free-gateway"].args)process.exit(1)' "$T/home/.kiro/settings/mcp.json" || fail "kiro mcp.json missing"
[ -f "$T/home/.kiro/steering/break-free.md" ] || fail "kiro steering missing"
grep -q "Work tracking (break-free-github-flow)" "$T/home/.kiro/steering/break-free.md" || fail "kiro steering should include github-flow rule"
[ -f "$T/home/.kiro/skills/break-free-github-flow/SKILL.md" ] || fail "kiro github-flow skill missing"
[ -f "$T/home/.omp/agent/mcp.json" ] || fail "omp mcp.json missing"
grep -q "Delegating to other models" "$T/home/.omp/agent/AGENTS.md" || fail "omp AGENTS.md rule missing"
[ -f "$T/proj/.omp/mcp.json" ] || fail "omp project mcp missing"
[ -f "$T/proj/.kiro/steering/break-free.md" ] || fail "kiro project steering missing"
[ -f "$T/proj/opencode.json" ] || fail "opencode project config missing"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!j.mcpServers["break-free-gateway"].args)process.exit(1)' "$T/home/.kimi/mcp.json" || fail "kimi mcp.json missing"
[ -f "$T/home/.kimi/skills/break-free-model-gateway/SKILL.md" ] || fail "kimi skill missing"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!j.mcpServers["break-free-gateway"])process.exit(1)' "$T/home/.gemini/settings.json" || fail "gemini settings.json missing MCP"
[ -f "$T/home/.gemini/skills/break-free-model-gateway/SKILL.md" ] || fail "gemini skill missing"
grep -q "Delegating to other models" "$T/home/.gemini/GEMINI.md" || fail "gemini GEMINI.md rule missing"
[ -f "$T/home/.copilot/skills/break-free-model-gateway/SKILL.md" ] || fail "copilot skill missing"
grep -q "Delegating to other models" "$T/home/.copilot/AGENTS.md" || fail "copilot AGENTS.md rule missing"
[ -f "$T/home/.hermes/skills/break-free-model-gateway/SKILL.md" ] || fail "hermes skill missing"
grep -q "Delegating to other models" "$T/home/.hermes/AGENTS.md" || fail "hermes AGENTS.md rule missing"
grep -q "read:" "$T/home/.aider.conf.yml" || fail "aider read: key missing"
grep -q "Delegating to other models" "$T/home/.clinerules" || fail "cline .clinerules rule missing"
grep -q "Delegating to other models" "$T/home/.adal/AGENTS.md" || fail "adal AGENTS.md rule missing"
grep -q "Delegating to other models" "$T/home/.openclaw/AGENTS.md" || fail "openclaw AGENTS.md rule missing"
[ -f "$T/proj/.aider.conf.yml" ] || fail "aider project config missing"
[ -f "$T/proj/.clinerules" ] || fail "cline project .clinerules missing"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!j.mcpServers["break-free-gateway"].args)process.exit(1)' "$T/home/.cursor/mcp.json" || fail "cursor global mcp.json missing"
[ -f "$T/proj/.cursor/mcp.json" ] || fail "cursor project mcp.json missing"
[ -f "$T/home/.config/goose/skills/break-free-model-gateway/SKILL.md" ] || fail "goose skill missing"
[ -f "$T/home/.config/agents/skills/break-free-model-gateway/SKILL.md" ] || fail "amp skill missing"
echo "ok"

echo "### harness profiles"
[ -f "$T/home/.config/model-gateway/harness/deepseek.env" ] || fail "deepseek harness env missing"
grep -F -q "ANTHROPIC_BASE_URL='http://127.0.0.1:$MOCK_PORT'" "$T/home/.config/model-gateway/harness/deepseek.env" || fail "anthropic base url not derived from provider baseUrl"
grep -q "ANTHROPIC_MODEL='good'" "$T/home/.config/model-gateway/harness/deepseek.env" || fail "anthropic model missing"
grep -q "break-free-claude-deepseek()" "$T/home/.config/model-gateway/harness/break-free.sh" || fail "claude shell function missing"
grep -q "break-free-codex-deepseek()" "$T/home/.config/model-gateway/harness/break-free.sh" || fail "codex shell function missing"
grep -q '\[model_providers.break_free_deepseek\]' "$T/home/.codex/config.toml" || fail "codex model_provider missing"
grep -q '\[profiles.break_free_deepseek\]' "$T/home/.codex/config.toml" || fail "codex profile missing"
grep -F -q "base_url = \"http://127.0.0.1:$SHIM_PORT/deepseek/v1\"" "$T/home/.codex/config.toml" || fail "codex provider should point at the shim"
grep -A6 'model_providers.break_free_deepseek' "$T/home/.codex/config.toml" | grep -q 'wire_api = "responses"' || fail "codex provider must use wire_api=responses"
grep -q 'wire_api = "chat"' "$T/home/.codex/config.toml" && fail "stale wire_api=chat should have been rewritten"
grep -q "break-free-serve()" "$T/home/.config/model-gateway/harness/break-free.sh" || fail "shim shell function missing"
grep -q "Codex shim: /deepseek/v1/responses answered" "$T/install.out" || fail "shim round-trip not verified (see $T/install.out)"
curl -sf "http://127.0.0.1:$SHIM_PORT/healthz" >/dev/null || fail "shim not running after install"
curl -sf -X POST -H 'content-type: application/json' -d '{"input":"hi","stream":true}' "http://127.0.0.1:$SHIM_PORT/deepseek/v1/responses" | grep -q "response.completed" || fail "shim streaming failed"
grep -q "break-free harness profiles" "$T/home/.zshrc" || fail "zshrc line missing"
grep -q "test-key" "$T/home/.config/model-gateway/harness/deepseek.env" || fail "env file should carry the key (mode 600)"
[ "$(stat -c %a "$T/home/.config/model-gateway/harness/deepseek.env" 2>/dev/null || stat -f %Lp "$T/home/.config/model-gateway/harness/deepseek.env")" = "600" ] || fail "harness env not 0600"
# the generated function must actually work: source it and check the env it sets
( set -a; . "$T/home/.config/model-gateway/harness/deepseek.env"; set +a; [ "$ANTHROPIC_MODEL" = "good" ] && [ "$ANTHROPIC_AUTH_TOKEN" = "test-key" ] ) || fail "sourcing env file failed"
echo "ok"

echo "### runtime log"
LOG="$(node "$ROOT/model-gateway/dist/index.js" --logs 50 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.file);if(!j.enabled||!j.providers.deepseek||j.providers.deepseek.ok<1)process.exit(1)})')" || fail "runtime log has no successful deepseek attempt"
grep -q "test-key" "$LOG" && fail "API key leaked into runtime log"
echo "ok ($LOG)"

echo "### doctor"
node "$ROOT/setup.mjs" --doctor --project "$T/proj" > "$T/doctor.out" 2>&1 || fail "doctor exited non-zero"
grep -q "GREEN" "$T/doctor.out" || fail "doctor not GREEN"
echo "ok"

echo "### uninstall"
cat >> "$T/home/.claude/CLAUDE.md" <<'EOF'
## Crew, worktrees and merge authority (firstmate)
Obsolete crew rule.
EOF
cat >> "$T/home/.omp/agent/AGENTS.md" <<'EOF'
## Crew, worktrees and merge authority (firstmate)
Obsolete crew rule.
EOF
node "$ROOT/setup.mjs" --uninstall --project "$T/proj" --yes > "$T/uninstall.out" 2>&1 || fail "uninstall failed"
[ ! -d "$T/home/.claude/skills/break-free-model-gateway" ] || fail "claude skill still present"
[ ! -d "$T/home/.claude/skills/break-free-github-flow" ] || fail "github-flow skill still present"
grep -q "Work tracking (break-free-github-flow)" "$T/home/.claude/CLAUDE.md" && fail "CLAUDE.md rule still present"
grep -q "Delegating to other models" "$T/home/.claude/CLAUDE.md" && fail "CLAUDE.md delegation rule still present"
grep -q 'mcp_servers.break_free_gateway' "$T/home/.codex/config.toml" && fail "codex table still present"
grep -q "Delegating to other models" "$T/home/.codex/AGENTS.md" && fail "codex AGENTS.md delegation rule still present"
grep -q "Delegating to other models" "$T/proj/AGENTS.md" && fail "project AGENTS.md delegation rule still present"
grep -q 'break-free-gateway' "$T/proj/.mcp.json" && fail "project registration still present"
[ ! -d "$T/home/.config/model-gateway/harness" ] || fail "harness dir still present"
sleep 0.5; curl -sf "http://127.0.0.1:$SHIM_PORT/healthz" >/dev/null && fail "shim still running after uninstall"
grep -q "break-free harness profiles" "$T/home/.zshrc" && fail "zshrc line still present"
grep -q 'break_free_deepseek' "$T/home/.codex/config.toml" && fail "codex profile still present"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(j.mcp["break-free-gateway"]||!j.mcp.other||j.model!=="x/y")process.exit(1)' "$T/home/.config/opencode/opencode.json" || fail "opencode entry not removed (or user config damaged)"
[ ! -d "$T/home/.config/opencode/skills/break-free-model-gateway" ] || fail "opencode skill still present"
grep -q "Delegating to other models" "$T/home/.config/opencode/AGENTS.md" && fail "opencode rule still present"
[ ! -f "$T/home/.kiro/steering/break-free.md" ] || fail "kiro steering still present"
[ ! -f "$T/home/.kiro/settings/mcp.json" ] || fail "kiro mcp.json should be removed when empty"
[ ! -f "$T/proj/.omp/mcp.json" ] || fail "omp project mcp still present"
[ ! -f "$T/home/.gemini/settings.json" ] || fail "gemini settings.json not removed"
[ ! -f "$T/home/.clinerules" ] || fail "cline .clinerules not removed"
grep -q "read:" "$T/home/.aider.conf.yml" && fail "aider read: not removed"
[ ! -f "$T/home/.cursor/mcp.json" ] || fail "cursor mcp.json not removed"
( ! grep -q -- '--fleet-check --hook' "$T/home/.claude/settings.json" ) && grep -q 'echo unrelated-stop' "$T/home/.claude/settings.json" || fail "Stop hook not removed or unrelated hook damaged"
echo "ok"

# A rule left pointing at a distro that is gone reads as an instruction, not a suggestion.
grep -R -F -q "Crew, worktrees and merge authority (firstmate)" "$T/home" "$T/proj" && fail "uninstall left a firstmate standing rule"
echo ok

echo "### doctor after uninstall (expect RED, exit 1)"
if node "$ROOT/setup.mjs" --doctor > "$T/doctor2.out" 2>&1; then fail "doctor should be RED after uninstall"; fi
grep -q "RED" "$T/doctor2.out" || fail "expected RED verdict"
echo "ok"

echo "### update (self-update re-install)"
cat > "$T/bin/git" <<EOF
#!/usr/bin/env bash
echo "git \$*" >> "$T/git.log"
if [ "\$1" = "pull" ]; then echo "Already up to date."; exit 0; fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$T/bin/git"
grep -q '"claude_scope": "both"' "$T/home/.config/model-gateway/last-install.json" || fail "last-install.json missing claude_scope"
grep -q '"source_dir":' "$T/home/.config/model-gateway/last-install.json" || fail "last-install.json missing source_dir"
node "$ROOT/setup.mjs" --update > "$T/update.out" 2>&1 || fail "update exited non-zero (see $T/update.out)"
grep -q "pull" "$T/git.log" || fail "--update did not git pull"
grep -q "GREEN" "$T/update.out" || fail "update re-install not GREEN"
[ -f "$T/home/.claude/skills/break-free-model-gateway/SKILL.md" ] || fail "update did not re-install the skill"
echo "ok"

echo "### stats + clean"
node "$ROOT/setup.mjs" --stats > "$T/stats.out" 2>&1 || fail "stats exited non-zero (see $T/stats.out)"
grep -q "footprint" "$T/stats.out" || fail "stats did not report footprint"
node "$ROOT/setup.mjs" --clean --days 0 > "$T/clean.out" 2>&1 || fail "clean exited non-zero (see $T/clean.out)"
grep -q "Clean up" "$T/clean.out" || fail "clean section missing"
echo "ok"
echo
echo "SELFTEST PASSED — the installer works on this machine (fake CLIs, mock provider). Now run: node setup.mjs"
