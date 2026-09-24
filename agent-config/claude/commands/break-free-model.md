---
description: Switch which model a provider or alias uses (e.g. "fast → kimi/kimi-k3", "deepseek default → deepseek-v4-pro"), at user or project level, and verify it.
argument-hint: <what to change> [for this project|globally]
allowed-tools: mcp__break-free-gateway
---

> Operations named below that are not in your tool list (the compact profile advertises only the execution tools) are called with `bf_invoke` - `{operation, arguments}` - and `bf_discover` lists every one with its schema.
Follow the `break-free-model-gateway` skill's "Switching models" playbook for: `$ARGUMENTS`

Decide provider-default vs alias vs default-role; decide `scope` ("for this project/repo" → project, "globally/everywhere" → user; ask in one line if unclear). Check the model id with `list_models {provider}`; keep existing fallbacks when changing an alias; apply with `configure_provider` / `configure_alias` / `configure_fallback`; run `test_provider`; report what changed, the file it was saved to, and which model answered.
