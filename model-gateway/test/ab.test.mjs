/**
 * The A/B harness maths: routed versus all-strong, on real verify outcomes.
 *
 * Fully deterministic and offline. Every row here is a hand-written fixture, so no model,
 * provider, plan or server starts. The point of the harness is that it cannot be talked into
 * a pass, so the cases that matter most are the ones where it must report a MISS or refuse to
 * report at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { summariseAb, calibrationHolds, AB_TOLERANCE_PTS } from "../dist/ab.js";

/** One scorecard row joined to its ledger task, as toAbRows would hand it over. */
const row = (task, { plan_task = task, ok = true, confidence = null, attempts = 1, cost = 0.01, lane = "fast", model = "deepseek/deepseek-flash" } = {}) => ({
  task,
  plan_task,
  lane,
  verify_ok: ok,
  attempts,
  cost_usd: cost,
  confidence,
  model,
});

const arm = (name, rows, retry_rows) => ({ name, label: name === "routed" ? "routed" : "all-strong", rows, ...(retry_rows ? { retry_rows } : {}) });
const planOf = (...tasks) => ({ tasks });

test("first-pass rates are computed from verify_ok, and a shortfall is a MISS", () => {
  const plan = planOf({ id: "t1", verify: "npm test" }, { id: "t2", verify: "npm test" }, { id: "t3", verify: "npm test" }, { id: "t4", verify: "npm test" });

  // routed 3/4 = 75%, strong 4/4 = 100%: a 25 point drop, far outside the tolerance.
  const miss = summariseAb(plan, [
    arm("routed", [row("t1"), row("t2"), row("t3"), row("t4", { ok: false })]),
    arm("strong", [row("t1"), row("t2"), row("t3"), row("t4")]),
  ]);

  assert.equal(miss.arms.routed.first_pass_pct, 75);
  assert.equal(miss.arms.strong.first_pass_pct, 100);
  assert.equal(miss.criteria.first_pass.gap_pts, -25);
  assert.equal(miss.criteria.first_pass.verdict, "MISS", "a 25 point drop must not be smoothed over");
  assert.ok(miss.missed.length > 0, "a missed criterion has to appear in the missed list");

  // Same rows both sides: nothing was given up, so the criterion passes.
  const pass = summariseAb(plan, [
    arm("routed", [row("t1"), row("t2"), row("t3"), row("t4")]),
    arm("strong", [row("t1"), row("t2"), row("t3"), row("t4")]),
  ]);
  assert.equal(pass.criteria.first_pass.gap_pts, 0);
  assert.equal(pass.criteria.first_pass.verdict, "PASS");
  assert.deepEqual(pass.missed, []);
  assert.ok(AB_TOLERANCE_PTS >= 0 && AB_TOLERANCE_PTS < 100, "the tolerance has to be a sane percentage-point figure");
});

test("a task with no verify command is excluded and counted, never counted as a pass", () => {
  // t2 declares no verify, so its row proves nothing about whether routing preserved quality.
  const plan = planOf({ id: "t1", verify: "npm test" }, { id: "t2" });
  const r = summariseAb(plan, [
    arm("routed", [row("t1"), row("t2")]),
    arm("strong", [row("t1"), row("t2")]),
  ]);

  assert.equal(r.plan_tasks, 2);
  assert.equal(r.scored_tasks, 1, "only the task carrying a verify command can be scored");
  assert.deepEqual(r.excluded_no_verify, ["t2"], "the excluded task has to be named, not dropped silently");
  assert.equal(r.arms.routed.runs, 1, "the unverifiable row must stay out of the denominator");
  assert.equal(r.arms.routed.excluded_no_verify, 1, "and must still be counted as excluded");
  assert.equal(r.arms.routed.first_pass_pct, 100, "one scored row, and it passed");

  // A row whose scorecard recorded no verify result at all is excluded on the same principle.
  const noResult = summariseAb(planOf({ id: "t1", verify: "npm test" }, { id: "t2", verify: "npm test" }), [
    arm("routed", [row("t1"), row("t2", { ok: null })]),
    arm("strong", [row("t1"), row("t2")]),
  ]);
  assert.equal(noResult.arms.routed.excluded_unverified, 1);
  assert.equal(noResult.arms.routed.runs, 1);
  assert.equal(noResult.arms.routed.first_pass_pct, 100, "an absent result is not a failure and not a pass");
});

test("confidence lands in the right band, and calibration only holds when the confident tasks fail less", () => {
  const plan = planOf(...["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => ({ id, verify: "npm test" })));

  // High band: 4 runs, 1 failure = 25%. Low band: 2 runs, 1 failure = 50%. 25 <= 50/2, so it holds.
  const holds = summariseAb(plan, [
    arm("routed", [
      row("t1", { confidence: 0.9 }), row("t2", { confidence: 0.85 }), row("t3", { confidence: 0.95 }), row("t4", { confidence: 0.8, ok: false }),
      row("t5", { confidence: 0.4 }), row("t6", { confidence: 0.2, ok: false }),
    ]),
    arm("strong", ["t1", "t2", "t3", "t4", "t5", "t6"].map((t) => row(t))),
  ]);
  const { high, low, mid } = holds.criteria.calibration;
  assert.equal(high.bucket, ">=0.8");
  assert.equal(high.runs, 4, "0.8 belongs to the high band, not the middle one");
  assert.equal(high.failed, 1);
  assert.equal(high.fail_pct, 25);
  assert.equal(low.bucket, "<0.5");
  assert.equal(low.runs, 2);
  assert.equal(low.fail_pct, 50);
  assert.equal(mid.runs, 0, "nothing was placed in 0.5-0.8 here");
  assert.equal(mid.fail_pct, null, "an empty band measures nothing and must not read as 0% failure");
  assert.equal(holds.criteria.calibration.holds, true);
  assert.equal(calibrationHolds(high, low), true);

  // Same failure rate in both bands: confidence predicted nothing.
  const flat = summariseAb(plan, [
    arm("routed", [
      row("t1", { confidence: 0.9 }), row("t2", { confidence: 0.85 }), row("t3", { confidence: 0.95, ok: false }), row("t4", { confidence: 0.9, ok: false }),
      row("t5", { confidence: 0.4 }), row("t6", { confidence: 0.2, ok: false }),
    ]),
    arm("strong", ["t1", "t2", "t3", "t4", "t5", "t6"].map((t) => row(t))),
  ]);
  assert.equal(flat.criteria.calibration.high.fail_pct, 50);
  assert.equal(flat.criteria.calibration.low.fail_pct, 50);
  assert.equal(flat.criteria.calibration.holds, false, "equal failure rates mean the confidence signal is worthless");
  assert.equal(calibrationHolds(flat.criteria.calibration.high, flat.criteria.calibration.low), false);
});

test("an arm with nothing in it reports NOT MEASURED rather than a number", () => {
  const plan = planOf({ id: "t1", verify: "npm test" }, { id: "t2", verify: "npm test" });

  // Nothing ran at all.
  const empty = summariseAb(plan, [arm("routed", []), arm("strong", [])]);
  assert.equal(empty.arms.routed.first_pass_pct, null, "no runs is not a 0% pass rate");
  assert.equal(empty.criteria.first_pass.gap_pts, null);
  assert.equal(empty.criteria.first_pass.verdict, "NOT MEASURED");
  assert.equal(empty.criteria.calibration.verdict, "NOT MEASURED");
  assert.ok(empty.unmeasured.length > 0, "what could not be measured has to be said out loud");
  assert.deepEqual(empty.missed, [], "unmeasured is not the same as missed");

  // One arm produced rows, the other produced none: still not comparable.
  const half = summariseAb(plan, [
    arm("routed", [row("t1"), row("t2")]),
    arm("strong", []),
  ]);
  assert.equal(half.arms.routed.first_pass_pct, 100);
  assert.equal(half.arms.strong.first_pass_pct, null);
  assert.equal(half.criteria.first_pass.gap_pts, null, "there is nothing to compare against");
  assert.equal(half.criteria.first_pass.verdict, "NOT MEASURED");
  assert.ok(half.arms.strong.missing.includes("t1"), "a plan task with no row for this arm has to be named");
});
