# Contributing to Break Free

Thanks for helping. Break Free is a small, deliberately dependency-light codebase (Node ≥ 20, TypeScript, `@modelcontextprotocol/sdk`, `zod`, nothing else at runtime). The bar for a change is: it keeps the guardrails honest, it is covered by a test, and the installer selftest still passes.

## Set up

```bash
git clone https://github.com/maruthiprithivi/break-free.git && cd break-free
cd model-gateway && npm install && npm run build && cd ..
```

## Run the checks

```bash
cd model-gateway && npm test            # 45 end-to-end tests against a mock provider + mock MCP server (~40 s)
cd .. && bash setup/selftest.sh         # installer end-to-end with fake claude/codex/opencode/kiro/omp CLIs, a throwaway HOME, mock provider
```

Both must be green before a PR. Neither needs an API key or touches your real `~/.claude`, `~/.codex`, `~/.config/model-gateway`.

## Where things live

| area | files |
|---|---|
| MCP tools & CLI flags | `model-gateway/src/index.ts` |
| provider catalog / routing / fallback / cost | `providers.ts`, `router.ts`, `client.ts`, `config.ts` |
| worker loop & tools (jail, git, gh, run, MCP bridge) | `agent.ts`, `workspace.ts`, `github.ts`, `runcmd.ts`, `mcpbridge.ts` |
| orchestration (delegate / review / panel / supervise / run_plan) | `orchestrate.ts`, `prompts.ts` |
| ledger, worktrees, policy, steward | `ledger.ts`, `worktrees.ts`, `policy.ts`, `steward.ts`, `codemap.ts` |
| Codex Responses-API shim | `serve.ts` |
| installer / doctor / uninstall | `setup.mjs`, `setup/lib.mjs`, `setup/selftest.sh` |
| skills, commands, standing rules per harness | `agent-config/` |
| tests | `model-gateway/test/` (`mock-provider.mjs`, `mock-mcp.mjs`, `gateway.test.mjs`) |

## Rules of the road

- **Guardrails are structural, not prompt text.** Anything that keeps workers from deleting, force-pushing, reading secrets, overwriting main's ledger or spending past a cap must be enforced in code, with a test that tries to break it.
- **Every model-supplied string that reaches `git`, `gh` or the shell is validated** (see `noFlag`, `gitRef`, `enumArg`, `isAllowedCommand`). Never pass one through unchecked.
- **Untrusted by default:** worker output, worker-written notes, project config from a cloned repo. Widening what any of them can do needs a clear reason in the PR.
- **One skill body for every harness.** Edit `agent-config/claude/skills/.../SKILL.md` and mirror to `agent-config/codex/skills/...` (the Codex copy is the generic form the other harnesses receive).
- Add a line to `CHANGELOG.md` under *Unreleased*.

## Adding a provider

Add an entry to `PROVIDER_CATALOG` in `providers.ts` (OpenAI-compatible `/chat/completions` base URL, key env var, default model, quirks in `extraBody`), a price in `DEFAULT_PRICING` (`config.ts`), and — if it has an Anthropic-compatible endpoint — a case in `anthropicBase()` in `setup.mjs` so harness profiles work.

## Adding a harness

Add an entry to `EXTRA_AGENTS` in `setup.mjs`: detection (binary names / config dirs), user- and project-level paths for the MCP config (`mcpServers` or `opencode` shape), skills directory, and the rules file (marker-based append or an owned file). Add a fake binary and assertions to `setup/selftest.sh`.
