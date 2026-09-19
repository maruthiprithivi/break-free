// The tripwire: hunk splitting, the thresholds, scope from policy rules, and the metrics.
// Offline and deterministic — the TypeSafe double answers, and the scored verdicts are injected.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { checkRulesFor, judgeHunk, scoreTripwire, splitHunks, tripwireSummary, TRIPWIRE_CHECKS, RISK_LEVELS } from "../dist/tripwire.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-tw-"));
const cfg = (over = {}) => {
  const f = path.join(tmp, `c-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(over));
  return loadConfig({ workspaceRoot: tmp, configPath: f }).config;
};

const HUNK = "@@ -10,4 +10,6 @@\n   const total = sum(items);\n-  expect(total).toBe(42);\n+  it.skip('sums', () => {});\n+  expect(total).toBeDefined();\n });\n";

test("splitHunks finds every hunk and names its file", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "+const b = 2;",
    "@@ -20,3 +21,3 @@",
    "-const c = 3;",
    "+const c = 4;",
    "diff --git a/test/x.test.ts b/test/x.test.ts",
    "--- a/test/x.test.ts",
    "+++ b/test/x.test.ts",
    "@@ -5,2 +5,3 @@",
    " describe('x', () => {",
    "+  it.skip('y', () => {});",
  ].join("\n");
  const hunks = splitHunks(diff);
  assert.equal(hunks.length, 3);
  assert.deepEqual(hunks.map((h) => h.file), ["src/a.ts", "src/a.ts", "test/x.test.ts"]);
  assert.equal(hunks[2].header, "@@ -5,2 +5,3 @@");
  assert.match(hunks[2].text, /it\.skip/);
  assert.deepEqual(splitHunks(""), []);
  assert.deepEqual(splitHunks("no hunks here"), []);
});

test("splitHunks caps the work instead of sending an unbounded diff", () => {
  const diff = Array.from({ length: 30 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1 +1 @@\n-a\n+b`).join("\n");
  assert.equal(splitHunks(diff, { maxHunks: 5 }).length, 5);
  const long = splitHunks("diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1 +1 @@\n+" + "x".repeat(5000), { maxHunkChars: 500 })[0];
  assert.match(long.text, /hunk truncated/);
  assert.ok(long.text.length < 600);
});

test("the five questions are the brief's five, one set per hunk", () => {
  assert.deepEqual(
    TRIPWIRE_CHECKS.map((c) => c.key),
    ["test_weakened", "security_touch", "destructive_data", "scope_creep"],
  );
  assert.equal(RISK_LEVELS.length, 5, "a Score from 0 (cosmetic) to 4 (incident)");
  for (const c of TRIPWIRE_CHECKS) {
    assert.equal(c.type, "noul");
    assert.ok(c.trueText.length > 10 && c.falseText.length > 10, `${c.key} needs both sides of the criteria`);
  }
});

test("the risk score is the review gate, and the shipped boundary is 3.0", () => {
  // `risk` alone, with every Noul silent. On real merged diffs this is the ONLY thing that flagged
  // 13 of 17 false flags, because ordinary code in a real backend scores 2.5-3.1 — which is why the
  // default moved 2.5 -> 3.0 on that evidence rather than on taste.
  const c = cfg();
  const at = (score) => judgeHunk(0, { file: "src/x.ts", header: "@@", lines: [], text: "" }, { h0__risk: { score, confidence: 0.9 } }, c).verdict;
  assert.equal(at(2.6), "allow", "just over half the scale is not a finding");
  assert.equal(at(3.0), "review", "3.0 is the gate");
  assert.equal(at(3.4), "review");
  assert.equal(at(3.5), "block", "blockRisk, not reviewRisk, is where rejection starts");
});

test("a clearly weakened test is blocked, not merely reviewed", () => {
  const c = cfg({ tripwire: { blockAt: 0.8 } });
  const v = judgeHunk(0, { file: "test/x.test.ts", header: "@@", lines: [], text: HUNK }, { h0__test_weakened: { noul: 0.96 }, h0__risk: { score: 4, confidence: 0.9 } }, c);
  assert.equal(v.verdict, "block");
  assert.match(v.reasons.join(" "), /test_weakened p=0\.96/);
});

test("destructive data and high risk block on their own", () => {
  const c = cfg({ tripwire: { blockAt: 0.8 } });
  assert.equal(judgeHunk(0, { file: "m.sql", header: "@@", lines: [], text: "" }, { h0__destructive_data: { noul: 0.91 }, h0__risk: { score: 1 } }, c).verdict, "block");
  assert.equal(judgeHunk(0, { file: "a.ts", header: "@@", lines: [], text: "" }, { h0__risk: { score: 3.6, confidence: 0.8 } }, c).verdict, "block");
  // the shipped default blocks only near certainty: 0.97 is reviewed, not rejected
  const shipped = cfg();
  assert.equal(judgeHunk(0, { file: "a.ts", header: "@@", lines: [], text: "" }, { h0__test_weakened: { noul: 0.97 }, h0__risk: { score: 2 } }, shipped).verdict, "review");
  assert.equal(judgeHunk(0, { file: "a.ts", header: "@@", lines: [], text: "" }, { h0__test_weakened: { noul: 0.995 }, h0__risk: { score: 2 } }, shipped).verdict, "block");
});

test("a moderate flag is a review, not a block", () => {
  const c = cfg({ tripwire: { reviewAt: 0.5 } });
  const v = judgeHunk(0, { file: "src/x.ts", header: "@@", lines: [], text: "" }, { h0__security_touch: { noul: 0.62 }, h0__risk: { score: 2, confidence: 0.85 } }, c);
  assert.equal(v.verdict, "review");
  assert.match(v.reasons.join(" "), /security_touch p=0\.62/);
});

test("low confidence on the risk score sends a hunk to review rather than trusting it", () => {
  const c = cfg({ tripwire: { confidenceThreshold: 0.7 } });
  // nothing fires, but the engine is not sure — "unsure" must not mean "clean"
  const v = judgeHunk(0, { file: "src/x.ts", header: "@@", lines: [], text: "" }, { h0__test_weakened: { noul: 0.05 }, h0__risk: { score: 0.4, confidence: 0.42 } }, c);
  assert.equal(v.verdict, "review");
  assert.match(v.reasons.join(" "), /low confidence 0\.42/);
});

test("a clean, confident hunk is allowed through", () => {
  const c = cfg();
  const v = judgeHunk(0, { file: "README.md", header: "@@", lines: [], text: "" }, { h0__test_weakened: { noul: 0.02 }, h0__security_touch: { noul: 0.01 }, h0__destructive_data: { noul: 0.0 }, h0__scope_creep: { noul: 0.1 }, h0__risk: { score: 0.3, confidence: 0.92 } }, c);
  assert.equal(v.verdict, "allow");
  assert.deepEqual(v.reasons, []);
});

test("adding a test is not weakening one, and the criteria say so", () => {
  const c = cfg();
  // a stricter assertion scores ~0 on test_weakened; the question's false-side explicitly covers it
  const v = judgeHunk(0, { file: "test/x.test.ts", header: "@@", lines: [], text: "" }, { h0__test_weakened: { noul: 0.03 }, h0__risk: { score: 1, confidence: 0.88 } }, c);
  assert.equal(v.verdict, "allow");
  assert.match(TRIPWIRE_CHECKS[0].falseText, /added, kept, or made stricter/);
});

test("thresholds are configurable and the policy is not buried in the call", () => {
  const strict = cfg({ tripwire: { reviewAt: 0.2, reviewRisk: 0.5 } });
  const v = judgeHunk(0, { file: "a.ts", header: "@@", lines: [], text: "" }, { h0__scope_creep: { noul: 0.25 }, h0__risk: { score: 0.6, confidence: 0.9 } }, strict);
  assert.equal(v.verdict, "review");
  // raising blockAt must turn a block into a REVIEW, never into an allow
  const lax = cfg({ tripwire: { blockAt: 0.99, blockRisk: 3.9, reviewAt: 0.5, reviewRisk: 2 } });
  const stillReview = judgeHunk(0, { file: "a.ts", header: "@@", lines: [], text: "" }, { h0__test_weakened: { noul: 0.85 }, h0__risk: { score: 2 } }, lax);
  assert.equal(stillReview.verdict, "review", "below blockAt is a review, never an allow");
});

test("only `check` rules scope the tripwire, and they never touch deny or review", () => {
  const c = cfg({ policy: { rules: [
    { match: "src/**", action: "check", reason: "read every src diff" },
    { match: "**/*.sql", action: "review" },
    { match: "secrets/**", action: "deny" },
  ] } });
  assert.deepEqual(checkRulesFor(c, ["src/a.ts"]).map((h) => h.match), ["src/**"]);
  assert.deepEqual(checkRulesFor(c, ["test/a.ts"]), [], "outside the check globs");
  assert.deepEqual(checkRulesFor(c, ["db/x.sql"]), [], "a review rule is not a check rule");
  assert.deepEqual(checkRulesFor(c, ["secrets/k"]), [], "a deny rule is not a check rule");
  assert.deepEqual(checkRulesFor(cfg(), ["src/a.ts"]), [], "no check rule means the tripwire is off");
});

test("metrics separate recall on planted diffs from false flags on clean ones", () => {
  const rows = [
    { id: "b1", label: "bad", kinds: ["test_weakened"] },
    { id: "b2", label: "bad", kinds: ["security_touch"] },
    { id: "b3", label: "bad", kinds: ["test_weakened", "scope_creep"] },
    { id: "c1", label: "clean", kinds: [] },
    { id: "c2", label: "clean", kinds: [] },
  ];
  const outcomes = [
    { id: "b1", verdict: "block", fired: ["test_weakened"], ms: 100, cost_usd: 0.0004, priced: true, ran: true },
    { id: "b2", verdict: "review", fired: ["security_touch"], ms: 200, cost_usd: 0.0004, priced: true, ran: true },
    { id: "b3", verdict: "allow", fired: [], ms: 150, cost_usd: 0.0004, priced: true, ran: true },
    { id: "c1", verdict: "allow", fired: [], ms: 120, cost_usd: 0.0004, priced: true, ran: true },
    { id: "c2", verdict: "review", fired: ["scope_creep"], ms: 130, cost_usd: 0.0004, priced: true, ran: true },
  ];
  const m = scoreTripwire(rows, outcomes);
  assert.equal(m.recall_pct, 67, "2 of 3 planted diffs flagged");
  assert.equal(m.false_flag_pct, 50, "1 of 2 clean diffs flagged — the number that says a tripwire is too jumpy");
  assert.deepEqual(m.per_kind.test_weakened, { total: 2, flagged: 1, recall_pct: 50 });
  assert.deepEqual(m.per_kind.security_touch, { total: 1, flagged: 1, recall_pct: 100 });
  assert.equal(m.blocked_bad, 1);
  assert.equal(m.ms_p50, 130);
  assert.equal(m.ms_max, 200);
  assert.equal(m.review_saved_pct, 50, "the clean diffs it did not flag are the reviews it saves");
});

test("a run that never happened is not scored as a clean one", () => {
  const rows = [{ id: "b1", label: "bad", kinds: ["test_weakened"] }, { id: "c1", label: "clean", kinds: [] }];
  const m = scoreTripwire(rows, [
    { id: "b1", verdict: "allow", fired: [], ms: 0, cost_usd: 0, priced: true, ran: false },
    { id: "c1", verdict: "allow", fired: [], ms: 0, cost_usd: 0, priced: true, ran: false },
  ]);
  assert.equal(m.ran, 0);
  assert.equal(m.recall_pct, 0);
  assert.equal(m.review_saved_pct, 0, "an engine that never answered saved nothing");
});

test("the summary names the file, the verdict and the probabilities", () => {
  const c = cfg({ tripwire: { blockAt: 0.8 } });
  const v = judgeHunk(0, { file: "test/sum.test.ts", header: "@@ -10,4 +10,6 @@", lines: [], text: HUNK }, { h0__test_weakened: { noul: 0.96 }, h0__risk: { score: 4, confidence: 0.9 } }, c);
  const line = tripwireSummary({ ran: true, hunks: [v], verdict: "block", flagged: 1, blocked: 1, ms: 210, cost_usd: 0.00042, priced: true, requests: 1, clean: false });
  assert.match(line, /tripwire BLOCK — 1 hunk\(s\), 1 flagged, 1 blocked in 210ms/);
  // the lead sees the file, which threshold fired, and the raw probabilities behind it
  assert.match(line, /test\/sum\.test\.ts @@ -10,4 \+10,6 @@: test_weakened p=0\.96 >= 0\.8, risk 4\.00 >= 3\.5 \[test_weakened p=0\.96, risk 4\.0\]/);
  assert.match(tripwireSummary({ ran: false, skipped: "no hunks in the diff", hunks: [], verdict: "allow", flagged: 0, blocked: 0, ms: 0, cost_usd: 0, priced: true, requests: 0, clean: false }), /not run \(no hunks in the diff\)/);
});
