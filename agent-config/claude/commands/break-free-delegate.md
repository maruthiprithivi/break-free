---
description: Delegate a task to another model (DeepSeek/Kimi/GLM/MiniMax/Ollama/…) via break-free-gateway, then verify the result.
argument-hint: [model-or-alias] <task>
allowed-tools: mcp__break-free-gateway__delegate, mcp__break-free-gateway__review, mcp__break-free-gateway__list_providers, mcp__break-free-gateway__list_models, Bash(git diff *), Bash(git status *)
---
Follow the `break-free-model-gateway` skill's "Delegate then verify" playbook.

Arguments: `$ARGUMENTS`. If the first word is a model alias or `provider/model` (e.g. `fast`, `strong`, `local`, `kimi`, `deepseek/deepseek-v4-pro`), use it as `model`; otherwise use the default. The rest is the task.

1. Collect the context the worker needs (files, constraints, expected output) — it cannot see this conversation.
2. Call `delegate` with the smallest `capabilities` that fit (default `["read"]`; `["read","write","run"]` when files should be edited in place — `run` lets the worker test), and a `verify` command (e.g. `npm test`) the gateway runs afterwards. Lend MCP servers only via `mcp_servers` when the task needs them.
3. Verify the report (read diffs, run tests where cheap). State which model actually answered (from `meta.model`) and any fallbacks.
