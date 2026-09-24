- **A Homebrew node upgrade no longer breaks every session.** The MCP server, the Stop hook and
  the Codex config were written with the versioned `Cellar/node/<version>` path; they now use a
  stable name for the same binary, and `--doctor` checks the hook's binary exists.
- **Slow answers are not killed as dead hosts, and a frozen process no longer blames the
  provider.** The header deadline is off for ollama, which sends no headers until its answer is
  ready; other providers keep it. A deadline that fired while this process was blocked is
  started again rather than trusted.
- **Turn ends and startup no longer stall on a network fetch.** The update check was a
  synchronous `git fetch` despite its "fire and forget" comment, and ran in the Stop hook too.
- **Wake events have owners.** CI events belong to the project that pushed, so another project's
  push no longer blocks your session. Events that belong to no one expire after an hour instead
  of blocking every new worktree forever and muting later alerts with the same id.
- **Shared state survives many gateways.** Circuit breakers, fleet cursors, the resolved set,
  the worktree registry, ledger task ids and `config.json` are written atomically and under a
  lock where they are read-modified-written; a torn read can no longer erase every workspace's
  data, and a corrupt worktree registry is set aside rather than overwritten.
- **Installs stay clean, so updates keep landing.** The committed lockfile matches
  `package.json`, the installer uses `npm ci`, and a test fails the build if they drift.
- **firstmate's pin follows its own approved update**, so `bf firstmate` stops refusing to launch
  after an auto-update. Drift anyone else caused still reads as drift.
- **The update notice tells the truth.** break-free is reported with the command that rebuilds
  it instead of being announced as "updated" after a source-only merge that changed nothing
  that runs; a fast-forward that could not land says so.
- **A harness waiting at a prompt is reported once**, not after every drain.
- **Unfinished work is not reported as done.** A worker stopped by `max_tokens` or by its tool
  budget is flagged first in its report and listed under "Needs your decision".
- **About 660 fewer tokens every turn.** Six field descriptions were sent three times; each is
  now described once, and a test holds the tool surface to a byte budget.
- **Every shipped instruction can reach the tools it names**, via `bf_invoke` when the compact
  profile hides them; a test fails the build otherwise.
- **The turn-end hook reads a bounded number of small job records**, instead of every result
  ever produced; finished records are removed after 30 days.
