---
title: "context cost breakdown API (T-034, issue #47 measurement half)"
tags: [howto, finding, context]
created: "2026-09-23T11:05:52.641Z"
updated: "2026-09-23T11:05:52.641Z"
source: worker
trust: worker
pending: true
---
# context cost breakdown API (T-034, issue #47 measurement half)

model-gateway/src/context.ts now exports the measurement half of #47, for the lead to wire into index.ts:

- `costBreakdown(lines: ContextLine[]): CostBreakdown` — input is the SAME `ContextLine[]` that `report()` already takes (index.ts's `contextLines()`), so no second notion of "always-on" exists. Internally it uses the module-private `alwaysOn(lines)` filter that `report()` also uses (that filter is the function that was extracted out of report(); report's behavior is unchanged).
- Returns `{ totalTokens, surfaces: [{ surface, tokens, share }] }`, ordered most-expensive-first. `share` is a FRACTION 0..1 (not a percent), `totalTokens === report(lines, n).alwaysOnTokens`, and `surfaces[0]` is the same surface `report().largest` names — so nothing about "the biggest unavoidable contributor" is re-stated.
- Tokens are the ones `line()`/`estimateTokens` already put on the lines; the breakdown has no estimator of its own.
- Empty / zero-token input: `totalTokens: 0`, shares 0 (guarded, never NaN).

Wiring note for index.ts (not done here on purpose): `contextLines()` already builds exactly the four always-on surfaces #47 cares about — "mcp tool schemas" (hand-built line, tokens from `estimateTokens(text)` at :430), "server instructions", "ledger resume brief"; "standing rules" would just be another `ctxLine(...)` with `always: true`. So `ctxReport(...)` + `costBreakdown(contextLines())` in `context_report` needs no new cost sources.
