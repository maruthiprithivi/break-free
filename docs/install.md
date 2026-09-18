# Installing Break Free

## One command

```bash
curl -fsSL https://raw.githubusercontent.com/maruthiprithivi/break-free/main/install.sh | bash
```

That script clones into `~/.break-free`, checks that your Node is new enough, and hands over to the real installer. Re-run it any time — it fast-forwards the checkout and re-installs over the top. Flags pass straight through:

```bash
curl -fsSL https://raw.githubusercontent.com/maruthiprithivi/break-free/main/install.sh | bash -s -- --yes
```

`BREAK_FREE_HOME=/somewhere/else` moves the checkout; `BREAK_FREE_BRANCH` picks a branch.

Piping a script into a shell is a reasonable thing to be wary of. Read it first if you prefer:

```bash
curl -fsSL https://raw.githubusercontent.com/maruthiprithivi/break-free/main/install.sh -o install.sh
less install.sh && bash install.sh
```

## Or from a clone

```bash
git clone https://github.com/maruthiprithivi/break-free.git && cd break-free
./install.sh                    # identical to `node setup.mjs`
```

## What you need

| | |
|---|---|
| **Node** | 20 or newer (`node -v`) |
| **git** | any recent version |
| **An agent** | Claude Code and/or Codex — [other harnesses](usage.md#other-coding-agents-gemini-cli-copilot-cli-cursor-goose-amp-hermes-aider-cline-adal-openclaw-droid-kilo-code-roo-code-qoder-zed-opencode-kiro-cli-kimi-code-cli-antigravity-agy-pi-oh-my-pi-omp) are supported too |
| **One model, minimum** | any provider key, or a local Ollama / vLLM endpoint — no key needed |
| **`gh`** | optional; only for the `github` worker capability |

## What the installer asks

It runs **preflight → scope → build → providers and keys → install → postflight**, printing one line per check:

```
== Preflight
  PASS  Node 22.22.2
  PASS  Claude Code CLI — 2.1.x
  WARN  gh CLI not found — github capability will be unavailable
        fix: brew install gh
== Providers & API keys
  DeepSeek API key  [Enter = use DEEPSEEK_API_KEY from your shell; or type skip / env / keep]:
  PASS  deepseek: key accepted — 12 models available
  PASS  deepseek: deepseek-v4-flash works — 812 ms
== Postflight (real MCP handshake + live provider calls)
  PASS  MCP handshake ok in 210 ms — 13 tools
  ●  GREEN — everything checks out. Good to go.
```

The questions, in order:

1. **Scope, per agent** — user level, project level, both, or skip (and which project directory).
2. **Which providers to walk through** — a checklist showing each one's current state (saved key, env var, base URL, chosen model), so you can switch off the ones you no longer use.
3. **Where keys live** — a config file at mode `600`, or `${ENV_VAR}` references that resolve at runtime.
4. **Each key** — pasted hidden, or `env` / `keep` / `skip`. Every key is verified against the live API, the provider's real model list is fetched and shown as a numbered menu (type part of a name to filter a big catalog), and you pick the default from it. A failed verification offers: another model, another key, save anyway, or skip.
5. **Local endpoints** — your Ollama or vLLM URL is probed; models are listed with size and loaded state, and the default comes from what you have actually pulled.
6. **Policy** — protected branches, and whether workers may push or merge at all.
7. **Model chains** — a numbered catalog of every model your providers serve *right now*, with a suggested sequence for each alias (`fast`, `strong`, `reviewer`, `local`) and for the global fallback chain. Enter accepts the suggestion, or type the order you want (`3,1,7`).
8. **GitHub work tracking** — whether to also install [`break-free-github-flow`](operations.md#break-free-github-flow-work-tracking-ci-and-deployment-discipline-optional).

Suggestions are built from live model lists only, so a retired model name can never end up in your config, and an alias still pointing at a vanished model is flagged and replaced. Before the policy and chain steps a **review table** lists every provider (verified / unverified / off, default model) and lets you redo any row.

Every `FAIL` and `WARN` carries a fix. The verdict is **GREEN**, **GREEN with warnings**, or **RED** — and `RED` exits `1`. Full log: `~/.config/model-gateway/setup.log`; machine-readable result: `setup-report.json`.

Everything lands under the `break-free-*` prefix, and re-running the installer removes any earlier unprefixed install automatically:

| | |
|---|---|
| Skills | `break-free-model-gateway`, `break-free-github-flow` |
| Commands | `/break-free-plan` `/break-free-resume` `/break-free-delegate` `/break-free-review` `/break-free-panel` `/break-free-supervise` `/break-free-issue` `/break-free-ci` `/break-free-wrap-up` |
| MCP server | `break-free-gateway` (Claude Code) · `break_free_gateway` (Codex) |

**Scopes.** User level writes `~/.claude/skills/`, `~/.claude/commands/*.md`, the MCP server via `claude mcp add --scope user`, `~/.agents/skills/`, an `[mcp_servers.break_free_gateway]` table in `~/.codex/config.toml`, and a note in `~/.codex/AGENTS.md`. Project level writes `<repo>/.mcp.json`, `<repo>/.claude/{skills,commands}`, `<repo>/.agents/skills`, `<repo>/.codex/config.toml`, appends to `AGENTS.md`, and adds `.model-gateway.json` to `.gitignore`. Claude Code asks once to approve a project `.mcp.json`; Codex reads a project `.codex/config.toml` only for trusted projects.

## Check that it worked

```bash
node ~/.break-free/setup.mjs --doctor     # or ./setup.mjs --doctor from a clone
claude mcp list                           # break-free-gateway ... ✓ Connected
```

Then, inside Claude Code, either of these should answer:

```
/break-free-resume
list providers
```

## When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `node not found`, or "Node … is too old" | Node below 20 | `nvm install 20 && nvm use 20`, or `brew upgrade node` |
| The installer ends **RED** | a preflight or postflight check failed | read the `FAIL` line — it carries its own fix — then `node setup.mjs --doctor` |
| `claude mcp list` shows the server but not connected | the build did not run, or the path moved | `node setup.mjs --yes` re-builds and re-registers |
| Codex refuses to start, complaining about `wire_api` | a leftover `wire_api = "chat"` provider ([codex#7782](https://github.com/openai/codex/discussions/7782)) | `node setup.mjs --doctor` finds it and offers to rewrite it |
| One provider fails every call | wrong key, or a model that no longer exists | `node setup.mjs --doctor` reads the [runtime log](operations.md#runtime-log--diagnosing-problems) and names it; or ask the agent to "run gateway_logs" |
| The piped install cannot prompt | no terminal (CI, a container) | `curl … \| bash -s -- --yes --answers answers.json` |
| The installer itself misbehaves | — | `bash setup/selftest.sh` — it tests the installer against fake `claude`/`codex` CLIs, a throwaway `HOME` and a mock provider |

## Every installer command

| Command | What it does |
|---|---|
| `node setup.mjs` | interactive install / re-install (safe to re-run; merges into existing config, rolling `.bak` of every file it rewrites) |
| `node setup.mjs --doctor [--project DIR] [--last N]` | diagnose only, change nothing: prerequisites, config validity and permissions, skill freshness, MCP registrations, **model catalog drift** (every alias/default checked against each provider's live list, with closest replacements), **runtime-log analysis** (per-provider failure rates and fixes), real handshake + provider calls |
| `node setup.mjs --uninstall [--project DIR] [--purge]` | remove registrations, skills and commands; `--purge` also deletes config, keys and sessions |
| `node setup.mjs --yes` | **hands-free re-install / upgrade**: no prompts; keeps and re-verifies everything already in `~/.config/model-gateway/config.json` (keys, default models, aliases, chains, disabled providers), refreshes skills/commands/registrations, cleans up old names |
| `node setup.mjs --update` | **self-update**: `git pull --ff-only` the source, then re-run hands-free reusing the scope/agents saved in `last-install.json` (also `/break-free-update` inside Claude Code) |
| `node setup.mjs --stats [--project DIR]` | read-only storage footprint (sessions, jobs, logs, harness) + project ledger/worktree stats |
| `node setup.mjs --clean [--days N]` | reclaim disk: delete sessions/jobs older than N days (default 30) and old log generations |
| `node setup.mjs --answers my.json` | non-interactive with explicit answers (CI, dotfiles); template in `setup/answers.example.json` |
| `node setup.mjs --project DIR` | pre-select the project directory for project-level scope |
| `node setup.mjs --skip-tests` | skip the test suite that runs after building |
| `bash setup/selftest.sh` | tests the installer itself against fake `claude`/`codex` CLIs, a throwaway HOME and a mock provider — run this first if the installer misbehaves |

## Install it by hand

<details><summary>Manual steps</summary>

```bash
cd model-gateway && npm install && npm run build
cp config.example.json ~/.config/model-gateway/config.json && chmod 600 ~/.config/model-gateway/config.json   # edit keys
# Claude Code
claude mcp add --scope user --transport stdio break-free-gateway -- node /ABS/PATH/model-gateway/dist/index.js
cp -R ../agent-config/claude/skills/break-free-model-gateway ~/.claude/skills/ && cp ../agent-config/claude/commands/*.md ~/.claude/commands/
# Codex
codex mcp add break_free_gateway -- node /ABS/PATH/model-gateway/dist/index.js      # then apply agent-config/codex/config.toml.snippet (tool_timeout_sec, env_vars)
mkdir -p ~/.agents/skills && cp -R ../agent-config/codex/skills/break-free-model-gateway ~/.agents/skills/
```
Keys: env vars (`DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `MINIMAX_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `OLLAMA_API_KEY`, `GH_TOKEN`), the config file (literal or `"${VAR}"`), or the `configure_provider` tool from inside the agent. Server flags: `--workspace DIR` · `--config FILE` · `--stateless` · `--selftest` · `--print-config`.
</details>
