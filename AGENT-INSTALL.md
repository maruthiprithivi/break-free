# Installing Break Free — instructions for a coding agent

You are a coding agent installing **Break Free** on your user's machine. Follow this file top to
bottom. It is written for you, not for a human: every step says what to run, what a good result
looks like, and what to do when it is not good.

Break Free is an MCP server plus skills and slash commands that let the agent your user is
talking to (you) delegate execution to cheaper models, with verification the gateway runs itself.
Source: <https://github.com/maruthiprithivi/break-free>

## Rules for you

1. **Never put an API key in your transcript, in a file you write, or in a command line.** Keys
   reach the installer through the user's environment or through the installer's own hidden
   prompt. If you need a key, ask the user to `export` it themselves and tell you when it is done.
2. **Never run any of this with `sudo`.** Everything installs under the user's home directory.
3. **Do not invent answers.** Where a step says to ask the user, ask, and wait.
4. Report progress as you go, and finish with the report in [Step 6](#step-6-report-back).
5. If a step fails, stop and read [Troubleshooting](#troubleshooting) before retrying. Do not
   re-run a failing command unchanged.

## Step 1: check the prerequisites

```bash
node -v          # must be v20 or newer
git --version    # any recent version
gh auth status   # optional: only needed for the github worker capability
```

- **Node is missing or older than 20** — stop. Tell the user, and suggest `nvm install 20 && nvm use 20`,
  or `brew install node` on macOS. Do not try to install Node yourself unless they ask.
- **git is missing** — stop and tell the user.
- **`gh` missing or not authenticated** — fine. Continue, and mention in your report that the
  `github` capability will be unavailable until they run `gh auth login`.

Also check which agent harness is present, because the installer registers itself per harness:

```bash
command -v claude; command -v codex
```

At least one must exist. If neither does, stop and tell the user to install
[Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex) first.

## Step 2: get the source

```bash
git clone https://github.com/maruthiprithivi/break-free.git ~/.break-free 2>/dev/null \
  || git -C ~/.break-free pull --ff-only
cd ~/.break-free
```

`~/.break-free` is the same location the one-line installer uses, so this stays consistent with
`curl -fsSL https://raw.githubusercontent.com/maruthiprithivi/break-free/main/install.sh | bash`.

## Step 3: ask the user the four things you cannot decide

Ask all four in one message, then wait for the answers.

1. **Which models should the crew use?** List the options and ask which they have keys for:
   `deepseek`, `kimi` (Moonshot), `zai` (GLM), `minimax`, `openrouter`, `opencode`,
   `ollama` (local, no key), `ollama-cloud`, `vllm` (local, no key).
   *A local Ollama needs no key and no account — a good answer if they have none.*
2. **Where should it install?** `user` (available in every project — the usual answer),
   `project` (this repository only), or `both`.
3. **May delegated workers push to git and merge pull requests?** Default to **no** for both
   unless they say otherwise. Protected branches default to `main,master,production,release`.
4. **Do they want GitHub work tracking** (the `break-free-github-flow` skill: an issue per task,
   CI watching)? `full` adds a standing rule, `skill` installs the commands only, `none` skips it.

Then, for each cloud provider they named, tell them to export the key **in their own shell** and
confirm when done:

```bash
export DEEPSEEK_API_KEY=...      # MOONSHOT_API_KEY, ZAI_API_KEY, MINIMAX_API_KEY,
                                 # OPENROUTER_API_KEY, OPENCODE_API_KEY, OLLAMA_API_KEY
```

You will not see these values, and you do not need to.

## Step 4: install

Write an answers file from what they told you. **Every key field is the literal string `env`** —
that tells the installer to read the environment variable and store a `${VAR}` reference rather
than the secret itself. Adjust the provider list, scopes and policy to match their answers:

```bash
cat > /tmp/break-free-answers.json <<'JSON'
{
  "providers": ["deepseek", "ollama"],
  "claude_scope": "user",
  "codex_scope": "user",
  "key_storage": "env",
  "deepseek_api_key": "env",
  "ollama_base_url": "http://localhost:11434/v1",
  "ollama_enabled": true,
  "protected_branches": "main,master,production,release",
  "allow_push": false,
  "allow_merge": false,
  "github_flow": "skill",
  "harness_profiles": false,
  "extra_agents": "detected"
}
JSON

node setup.mjs --yes --answers /tmp/break-free-answers.json
rm -f /tmp/break-free-answers.json
```

Notes that matter:

- `key_storage: "env"` means the user must export those variables in the shell that launches
  Claude Code or Codex, not only in the shell that ran the installer. Say this in your report.
- `"providers"` limits the run to the providers named. Anything omitted is left untouched.
- Omit `"project_dir"` unless a scope is `project` or `both`; then set it to the repository path.
- Set `"harness_profiles": true` only if the user wants to run Claude Code or Codex *on* one of
  these models. It is unrelated to delegation and off by default here.
- The installer is safe to re-run. It merges into any existing config and keeps a `.bak` of every
  file it rewrites.

Read the output. The last line is the verdict:

| Verdict | Meaning | What you do |
|---|---|---|
| `GREEN` | everything checked out | continue to Step 5 |
| `GREEN with warnings` | usable; something optional is missing | continue, and list the warnings in your report |
| `RED` (exit 1) | something must be fixed | stop, read the `FAIL` lines — each carries its own `fix:` — and see [Troubleshooting](#troubleshooting) |

## Step 5: verify it actually works

Do not take the installer's word for it. Run these and read the output:

```bash
node ~/.break-free/setup.mjs --doctor     # expect: no FAIL lines
claude mcp list                           # expect: break-free-gateway ... Connected
```

For Codex, check that `~/.codex/config.toml` now contains an `[mcp_servers.break_free_gateway]`
table.

Then confirm a model actually answers. From inside the user's agent session:

```
list providers
```

A table of usable providers means the install is live. If you can call MCP tools directly, call
`list_providers` with `probe: true` and then `test_provider` with `spec: "<provider>"`; the latter
reports latency, the reply, and whether tool-calling works.

## Step 6: report back

Give the user exactly this, filled in:

- **Verdict** from the installer, and any warnings.
- **Installed**: which harnesses were registered, at which scope.
- **Providers**: which verified, with the default model each resolved to.
- **Environment variables they must keep exported**, and in which shell.
- **What is not available yet** (for example: `github` capability until `gh auth login`).
- **What to try first**, verbatim:
  ```
  /break-free-resume
  /break-free-delegate fast write unit tests for <a real file in their project>
  ```
- **Uninstall**, if they want it gone: `node ~/.break-free/setup.mjs --uninstall` (add `--purge`
  to also delete config, keys and sessions).

## Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| `Node ... is too old` | Node below 20 | Stop. `nvm install 20 && nvm use 20`, then re-run Step 4. |
| Installer ends `RED` | a preflight or postflight check failed | Read the `FAIL` line; it carries its own `fix:`. Then `node setup.mjs --doctor`. |
| A provider fails verification | wrong key, or a model that no longer exists | Confirm the variable is exported **in this shell** (`printenv DEEPSEEK_API_KEY | wc -c`, never print the value). The installer offers another model or another key. |
| `claude mcp list` shows it but not connected | the build did not run, or the path moved | `node ~/.break-free/setup.mjs --yes` rebuilds and re-registers. |
| Codex refuses to start, mentions `wire_api` | a leftover `wire_api = "chat"` provider | `node setup.mjs --doctor` finds it and offers to rewrite it. |
| Everything fails and you suspect the installer | — | `bash ~/.break-free/setup/selftest.sh` tests the installer in isolation against fake CLIs and a mock provider. |
| A worker misbehaves later | — | `node setup.mjs --doctor` reads the runtime log and names the failing provider, or run the `gateway_logs` tool. |

## Do not

- Do not commit the answers file, or any file containing a key, to any repository.
- Do not set `allow_push` or `allow_merge` to `true` without the user explicitly asking.
- Do not remove `protected_branches`.
- Do not install with `sudo`, and do not write outside the user's home directory.
- Do not report success on a `RED` verdict.
