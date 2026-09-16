---
description: Run a worker model under a supervisor model until the result is accepted; for larger implementation tasks you don't want to babysit.
argument-hint: <task> [--worker alias] [--supervisor alias] [--caps read,write,git,github] [--rounds N]
allowed-tools: mcp__break-free-gateway__supervise, mcp__break-free-gateway__session_get, Bash(git diff *), Bash(git status *)
---
Parse `$ARGUMENTS`: task text plus optional flags `--worker`, `--supervisor` (default `fast` / `strong`; ensure different vendors), `--caps` (default `read,write`), `--rounds` (default 3).

Before calling `supervise`, write explicit `acceptance_criteria` (tests pass, files in scope, no unrelated changes, style) and give `context` the worker needs. Afterwards:
1. Report ACCEPTED / NOT ACCEPTED, rounds, supervisor findings.
2. If the worker had write access: `git diff --stat` and read the diff yourself before telling the user it is done.
3. Never commit on the worker's behalf without the user's go-ahead.
