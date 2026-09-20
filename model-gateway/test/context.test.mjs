/**
 * The context budget: what break-free charges a session before any work happens.
 *
 * Offline and deterministic. The estimator is deliberately crude, so these pin the properties
 * that matter — stable, never flattering, and honest about which surfaces are unavoidable —
 * rather than asserting exact token counts a tokenizer would disagree with anyway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, line, report, renderReport } from "../dist/context.js";

test("the estimator is conservative and counts bytes, not characters", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcd"), 2, "it rounds up: a budget must never flatter itself");

  // A multi-byte character costs what it costs on the wire. Counting characters would
  // under-report every non-ASCII prompt, which is the direction that hurts.
  assert.ok(estimateTokens("é") >= estimateTokens("e"), "a two-byte character is not cheaper than a one-byte one");
  assert.equal(estimateTokens("日本語"), 3, "nine UTF-8 bytes");

  // Stable: the same text always costs the same, whatever provider is in play.
  assert.equal(estimateTokens("hello world"), estimateTokens("hello world"));
});

test("only the always-on surfaces are held to the budget", () => {
  const lines = [
    line("tools", "x".repeat(300), true),      // 100 tok
    line("instructions", "x".repeat(150), true), // 50 tok
    line("a skill", "x".repeat(3000), false),  // 1000 tok, pulled in deliberately
  ];
  const r = report(lines, 200);

  assert.equal(r.alwaysOnTokens, 150);
  assert.equal(r.totalTokens, 1150, "the total still shows everything, so nothing is hidden");
  assert.equal(r.overBudget, false, "an on-demand cost is a choice the caller made, not a standing charge");

  // Tighten the budget below the standing cost and it must say so.
  assert.equal(report(lines, 100).overBudget, true);
});

test("the largest always-on contributor is named, because that is where an argument starts", () => {
  const r = report([
    line("small", "x".repeat(30), true),
    line("tools", "x".repeat(3000), true),
    line("huge but on demand", "x".repeat(90000), false),
  ], 10);

  assert.equal(r.largest.surface, "tools", "the biggest thing you cannot avoid, not the biggest thing overall");
  assert.equal(r.lines[0].surface, "huge but on demand", "the listing is still ordered by real size");
});

test("the rendered report states the verdict either way", () => {
  const over = renderReport(report([line("tools", "x".repeat(3000), true)], 100));
  assert.match(over, /OVER by 900 tok/);
  assert.match(over, /largest: tools/);

  const under = renderReport(report([line("tools", "x".repeat(300), true)], 500));
  assert.match(under, /within budget \(400 tok to spare\)/);
});

test("an empty report is within budget rather than undefined", () => {
  const r = report([], 7500);
  assert.equal(r.alwaysOnTokens, 0);
  assert.equal(r.overBudget, false);
  assert.equal(r.largest, undefined);
  assert.match(renderReport(r), /within budget/);
});
