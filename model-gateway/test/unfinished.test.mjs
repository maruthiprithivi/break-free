/**
 * A worker a limit stopped did not finish, and the report says so first.
 *
 * `truncated` was one meta flag after the answer, which a lead rarely reads, and in run_plan the
 * task was marked DONE and the flag was stripped before the report reached the lead at all. On
 * one machine 17 of 23 empty delegate reports were a model that spent its whole output budget
 * reasoning. And the one flag meant two different failures: about 110 of 150 truncated results
 * ran out of tool iterations, about 40 hit max_tokens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { unfinishedNote, unfinishedTag } from "../dist/orchestrate.js";

test("an answer cut at the output limit is flagged before anything else, and says what to raise", () => {
  const n = unfinishedNote({ truncatedBy: "max_tokens", maxTokens: 8192, text: "partial answ" });
  assert.match(n, /^> \*\*Unfinished: the answer hit the output limit \(max_tokens 8192\)/);
  assert.match(n, /cut off/);
  assert.match(n, /Raise max_tokens/);
});

test("an empty answer from a model that spent everything reasoning is named as such", () => {
  assert.match(unfinishedNote({ truncatedBy: "max_tokens", maxTokens: 8192, text: "   " }), /spent the whole budget reasoning and returned nothing/);
});

test("running out of tool iterations is a different failure, with a different fix", () => {
  const n = unfinishedNote({ truncatedBy: "tool_budget", maxIterations: 25, text: "x" });
  assert.match(n, /used all 25 tool iterations/);
  assert.match(n, /raise max_iterations or split the task/);
  assert.doesNotMatch(n, /max_tokens/);
});

test("a worker that finished gets no note at all", () => {
  assert.equal(unfinishedNote({ text: "done properly" }), "");
  assert.equal(unfinishedTag({}), "");
});

test("the plan summary tag distinguishes the two", () => {
  assert.equal(unfinishedTag({ truncatedBy: "max_tokens" }), "UNFINISHED: hit max_tokens");
  assert.equal(unfinishedTag({ truncatedBy: "tool_budget" }), "UNFINISHED: ran out of tool iterations");
});
