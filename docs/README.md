# docs

Reference material for [Break Free](../README.md). The README is the landing page; this is the detail.

| | |
|---|---|
| [install.md](install.md) | every installer flag, each prompt explained, install scopes, the manual path, troubleshooting |
| [usage.md](usage.md) | `run_plan`, the ledger, worktrees, guardrails, lending MCP servers, model specs, fallback, other harnesses |
| [architecture.md](architecture.md) | the operating model, the tool surface, repository layout |
| [harness.md](harness.md) | running Claude Code or Codex *on* another model; tmux harness sub-agents |
| [operations.md](operations.md) | the runtime log and diagnosing problems, operational notes, `break-free-github-flow` |
| [testing.md](testing.md) | the test suite, the mock provider, end-to-end checks |
| [tripwire.md](tripwire.md) | the Jev check on a crew diff: what a hunk did, the calibrated thresholds, and the false-flag rate it misses |
| [roadmap.md](roadmap.md) | what is planned next, and why |
| [blueprint.html](blueprint.html) | the architecture picture: harnesses to gateway to crew, install matrix, one task end to end |

## The published site

`index.html` is the project page, served by GitHub Pages from this directory at
<https://maruthiprithivi.github.io/break-free/>. It exists because github.com strips `<video>`
from rendered Markdown, so the narrated videos cannot play in the README itself.

`.nojekyll` disables Jekyll processing, so the files here are served exactly as committed.

`assets/` holds the banner, the five videos, their poster frames, their WebVTT subtitle tracks and
the silent animated previews used in the README. It is generated from [`videos/`](../videos/) — do
not edit it by hand.
