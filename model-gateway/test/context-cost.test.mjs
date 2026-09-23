/**
 * Which surface the standing context cost is actually spent on.
 *
 * Offline and deterministic, like the budget tests next door. These pin the properties a regression
 * would break — the shares add up, only the unavoidable surfaces are in the denominator, the order
 * is by cost, and nothing divides by zero — rather than exact counts, which the crude estimator
 * would not defend anyway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { costBreakdown, estimateTokens, line, report } from "../dist/context.js";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (${a} vs ${b})`);

test("each surface's share is of the standing total, and the shares sum to it", () => {
  const b = costBreakdown([
    line("mcp tool schemas", "x".repeat(900), true),    // 300 tok
    line("server instructions", "x".repeat(300), true), // 100 tok
    line("standing rules", "x".repeat(600), true),      // 200 tok
  ]);

  assert.equal(b.totalTokens, 600);
  assert.equal(b.surfaces.length, 3);
  near(b.surfaces.reduce((n, s) => n + s.share, 0), 1, "the shares account for all of the total");
  near(b.surfaces.find((s) => s.surface === "mcp tool schemas").share, 0.5, "the biggest surface owns half of it");
  near(b.surfaces.find((s) => s.surface === "server instructions").share, 1 / 6, "shares are fractions, not percentages");
  assert.ok(b.surfaces.every((s) => s.share > 0 && s.share <= 1), "a share is never more than the whole");
});

test("a surface that is not always-on is excluded, however large", () => {
  const b = costBreakdown([
    line("mcp tool schemas", "x".repeat(300), true),        // 100 tok, standing
    line("a skill pulled in on demand", "x".repeat(90000), false), // 30k tok, a caller's choice
  ]);

  assert.equal(b.totalTokens, 100, "the denominator is the standing cost, not everything a session might pull in");
  assert.deepEqual(b.surfaces.map((s) => s.surface), ["mcp tool schemas"]);
  near(b.surfaces[0].share, 1, "the only standing surface is the whole of the standing cost");
});

test("an empty input has nothing to divide by, and says 0 rather than NaN", () => {
  const none = costBreakdown([]);
  assert.equal(none.totalTokens, 0);
  assert.deepEqual(none.surfaces, []);

  const allOnDemand = costBreakdown([line("a skill", "x".repeat(3000), false)]);
  assert.equal(allOnDemand.totalTokens, 0);
  assert.deepEqual(allOnDemand.surfaces, []);

  // The case the guard actually exists for: a standing surface that currently costs nothing,
  // such as a ledger brief with no tasks in it. 0/0 is NaN, and NaN would poison any caller
  // that sums the shares to check the report against itself.
  const free = costBreakdown([line("ledger resume brief", "", true)]);
  assert.equal(free.totalTokens, 0);
  assert.equal(free.surfaces.length, 1, "a free surface still exists, it just costs nothing");
  assert.equal(free.surfaces[0].share, 0);
});

test("the breakdown is ordered most expensive first", () => {
  const lines = [
    line("server instructions", "x".repeat(150), true),  // 50 tok
    line("standing rules", "x".repeat(300), true),       // 100 tok
    line("mcp tool schemas", "x".repeat(3000), true),    // 1000 tok
  ];
  const b = costBreakdown(lines);

  assert.deepEqual(b.surfaces.map((s) => s.surface), ["mcp tool schemas", "standing rules", "server instructions"]);
  assert.deepEqual(b.surfaces.map((s) => s.tokens), [1000, 100, 50]);
  assert.deepEqual(lines.map((l) => l.surface), ["server instructions", "standing rules", "mcp tool schemas"], "the caller's list is sorted, not reordered under it");
});

test("the tokens are the estimator's, and the head of the list is what report() calls largest", () => {
  const instructions = "the server instructions, verbatim";
  const lines = [
    line("server instructions", instructions, true),
    line("mcp tool schemas", "x".repeat(300), true),
  ];
  const b = costBreakdown(lines);

  assert.equal(b.surfaces.find((s) => s.surface === "server instructions").tokens, estimateTokens(instructions));
  assert.equal(b.totalTokens, report(lines, 0).alwaysOnTokens, "one definition of always-on, so the two cannot disagree");
  assert.equal(b.surfaces[0].surface, report(lines, 0).largest.surface, "the ordering is how the biggest contributor is named");
});

test("two standing lines sharing a surface name are one row, not two partial ones", () => {
  // Standing rules read from two files are still "standing rules" to whoever reads the report.
  // Listing the name twice with a partial share each understates whichever row is looked at.
  const lines = [
    line("standing rules", "a".repeat(300), true),
    line("standing rules", "b".repeat(600), true),
    line("server instructions", "c".repeat(300), true),
  ];
  const b = costBreakdown(lines);
  const names = b.surfaces.map((s) => s.surface);
  assert.equal(new Set(names).size, names.length, `a surface appears once: ${names.join(", ")}`);

  const rules = b.surfaces.find((s) => s.surface === "standing rules");
  assert.equal(rules.tokens, 300, "its cost is the sum of every line that carries the name");
  assert.equal(rules.share, 0.75);
  assert.equal(b.surfaces[0].surface, "standing rules", "and aggregation decides the ordering");
  assert.ok(Math.abs(b.surfaces.reduce((n, s) => n + s.share, 0) - 1) < 1e-9, "shares still sum to one");
});
