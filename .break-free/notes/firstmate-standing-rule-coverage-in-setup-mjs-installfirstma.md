---
title: firstmate standing rule coverage in setup.mjs (installFirstmate)
tags: [finding, gotcha, convention]
created: "2026-09-21T10:05:25.606Z"
updated: "2026-09-21T10:05:25.606Z"
source: worker
---
# firstmate standing rule coverage in setup.mjs (installFirstmate)

installFirstmate (setup.mjs:663, rule-writing block now ~704-757) writes the FM_MARKER rule not only to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md but to every agent in state.extraAgents, using the same scope resolution as installExtraAgents (state.extraScope -> user/project paths in EXTRA_AGENTS[k].user.rules / .project.rules).

Facts worth keeping:
- The Codex snippet agent-config/codex/AGENTS.firstmate.snippet names no harness-specific server (no break_free_gateway, unlike the gateway/github-flow snippets), so it is used verbatim as the generic form; only __FM_ROOT__ is substituted. genericRule() is NOT used (it only handles gateway/github-flow).
- rulesOwned (kiro steering, agy project .agents/rules, cline .clinerules) get the rule APPENDED, never truncated. installExtraAgents rewrites those files from scratch on every run, and it runs BEFORE installFirstmate in main() (line 1933 vs 1934), so append-once stays idempotent and no duplicate accumulates.
- aider (rulesKind "aider") is skipped on purpose: its rule is a `read:` key in .aider.conf.yml, a different mechanism; upsertAiderRead refuses to touch an existing read: list anyway.
- report.info(msg) takes ONE argument (setup/lib.mjs:52) — the second arg is silently dropped. report.pass/what/detail are the two-arg form.
- installFirstmate runs after installExtraAgents, so state.extraAgents/extraScope are always set by then (chooseExtraAgents sets them at lines 1087-1089).
- Pre-existing, NOT fixed: uninstall() (setup.mjs:1712) never strips FM_MARKER from any file and never removes the distro, so FM rules survive uninstall for claude/codex too — the gap this change widens, not creates. Also appendOnce->stripBlock deletes the block from the previous "\n## " heading to the next blank line, so a changed rule text on a re-run can eat the neighbouring delegation rule; unchanged here, same as claude/codex.
