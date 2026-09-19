// `bf bench tripwire`: the offline replay, and the numbers the docs quote.
//
// The offline arm is the one the brief actually depends on — it is how the bench runs with no key and
// how CI can assert the published figures. It replays a recording through the REAL client, so the
// double only stands in for the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "..", "dist", "cli.js");
const bench = path.join(here, "..", "bench");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-tw-"));
const configPath = path.join(tmp, "config.json");
// No `tripwire` block on purpose: the thresholds under test are the shipped defaults.
fs.writeFileSync(configPath, JSON.stringify({ defaults: { model: "fast" } }));

function bf(args, { expectFail = false, config = configPath } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      cwd: tmp,
      env: { ...process.env, MODEL_GATEWAY_CONFIG: config, TYPESAFE_API_KEY: "" },
    });
    if (expectFail) throw new Error(`expected a non-zero exit for: bf ${args.join(" ")}`);
    return stdout;
  } catch (e) {
    if (!expectFail) throw new Error(`bf ${args.join(" ")} failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

const HUNK_DELETES_ASSERTION = `@@ -18,6 +18,6 @@ describe('retry policy', () => {
   it('retries a failed job up to three times', async () => {
     const job = await runJob(failTwice());
-    expect(job.attempts).toEqual(3);
-    expect(job.status).toEqual('dead');
+    expect(job.status).toEqual('dead');
   });
 });`;

const HUNK_ADDS_TEST = `@@ -44,5 +44,12 @@ describe('job metrics', () => {
     expect(metrics.completed).toEqual(0);
   });
 
+  it('does not count a cancelled job as completed', async () => {
+    const job = await runJob(cancelImmediately());
+    expect(metrics.completed).toEqual(0);
+  });
 });`;

const row = (id, label, hunk) => ({ id, label, task: `task ${id}`, hunk, kinds: label === "bad" ? ["test_weakened"] : [] });

/** A recording is what makes the offline arm real: per-row answers, keyed exactly as the bench sends them. */
function recordingFor(decisions) {
  const file = path.join(tmp, "rec.json");
  fs.writeFileSync(file, JSON.stringify({ note: "test", answered_by: "jev", diffs: Object.keys(decisions).length, decisions }));
  return file;
}

test("the offline arm replays the recording instead of answering nothing", () => {
  // Regression: the bench used to seed the double from the record it was ABOUT to write — empty on an
  // offline run — so every answer was blank, every verdict `allow` and recall 0%. A replay that reads
  // nothing looks identical to a model that finds nothing, which is why this needs its own test.
  const setFile = path.join(tmp, "set.jsonl");
  fs.writeFileSync(
    setFile,
    [
      row("t1", "bad", HUNK_DELETES_ASSERTION),
      row("t2", "bad", HUNK_DELETES_ASSERTION),
      row("t3", "clean", HUNK_ADDS_TEST),
      row("t4", "clean", HUNK_ADDS_TEST),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  const recFile = recordingFor({
    t1: { lane: "fast", confidence: 0.9, difficulty: 2, sensitive: 0, context: 0, test_weakened: 0.995, risk: 4, risk_confidence: 0.93 },
    t2: { lane: "fast", confidence: 0.9, difficulty: 2, sensitive: 0, context: 0, test_weakened: 0.995, risk: 4, risk_confidence: 0.93 },
    t3: { lane: "fast", confidence: 0.9, difficulty: 2, sensitive: 0, context: 0, test_weakened: 0.02, risk: 1, risk_confidence: 0.9 },
    t4: { lane: "fast", confidence: 0.9, difficulty: 2, sensitive: 0, context: 0, test_weakened: 0.02, risk: 1, risk_confidence: 0.9 },
  });

  const out = JSON.parse(bf(["bench", "tripwire", "--set", setFile, "--record", recFile, "--json"]));
  assert.equal(out.metrics.ran, 4);
  assert.equal(out.metrics.recall_pct, 100, "the recorded answers must reach the verdicts");
  assert.equal(out.metrics.false_flag_pct, 0);
  assert.deepEqual(
    out.outcomes.map((o) => `${o.id}:${o.verdict}`),
    ["t1:block", "t2:block", "t3:allow", "t4:allow"],
  );
});

test("a recording is required, and its absence is said out loud rather than scored as zero", () => {
  const out = bf(["bench", "tripwire", "--record", path.join(tmp, "missing.json")], { expectFail: true });
  assert.match(out, /no recorded decisions at/);
  assert.match(out, /--live/);
});

test("the shipped set reproduces the numbers the docs quote", () => {
  // Deterministic by construction: the recording replays through the real client. If a threshold
  // changes these, the docs are now wrong and this fails — which is the point.
  const { metrics } = JSON.parse(bf(["bench", "tripwire", "--json"]));

  assert.equal(metrics.diffs, 130);
  assert.equal(metrics.ran, 130);
  assert.equal(metrics.bad, 30);
  assert.equal(metrics.clean, 100);

  assert.equal(metrics.recall_pct, 90, "recall on planted diffs");
  assert.equal(metrics.false_flag_pct, 14, "false flags on clean diffs");
  assert.equal(metrics.blocked_bad, 8);
  assert.equal(metrics.blocked_clean, 0, "nothing clean is hard-blocked");
  assert.equal(metrics.review_saved_pct, 86);

  assert.deepEqual(
    Object.fromEntries(Object.entries(metrics.per_kind).map(([k, v]) => [k, v.recall_pct])),
    { test_weakened: 86, security_touch: 100, destructive_data: 100, scope_creep: 83 },
  );
});

test("the report shows the targets and names the one it misses", () => {
  const out = bf(["bench", "tripwire"]);
  assert.match(out, /recall on bad\s+90% {2}\(27\/30\)\s+target >= 90%\s+PASS/);
  assert.match(out, /false flags on clean\s+14% {2}\(14\/100\)\s+target <= 10%\s+MISS/);
  assert.match(out, /reviews saved\s+86% of clean diffs need no full review\s+target >= 40%\s+PASS/);
  // The offline arm has no network, so latency is not a measurement — it must not read like one.
  assert.doesNotMatch(out, /latency\s+p50 3\d\d ms/);
});

test("a recording recorded against a different set is refused, not scored as zero", () => {
  // Unanswered rows come back `allow`, so scoring a mismatched recording reports a flawless 0% false
  // flag rate computed from nothing — the most misleading output this bench can produce.
  const out = bf(["bench", "tripwire", "--set", path.join(bench, "tripwire-natural.jsonl")], { expectFail: true });
  assert.match(out, /has no decision for 175 of 175 diffs/);
  assert.match(out, /Point --record at the matching recording/);
});

test("on 175 real merged diffs the false-flag target is met, and the set reports no recall", () => {
  // Real history, mined by bench/make-natural-set.mjs: 94 commits, 3 repos. It plants nothing, so
  // recall is n/a — reporting "0% recall, MISS" for a set with no bad rows would be a number that
  // means nothing.
  const { metrics, meta } = JSON.parse(
    bf(["bench", "tripwire", "--set", path.join(bench, "tripwire-natural.jsonl"), "--record", path.join(bench, "tripwire-natural-recording.json"), "--json"]),
  );
  assert.equal(metrics.diffs, 175);
  assert.equal(metrics.bad, 0);
  assert.equal(meta.live, false);
  assert.equal(metrics.false_flag_pct, 4, "false flags on real merged diffs");

  const text = bf(["bench", "tripwire", "--set", path.join(bench, "tripwire-natural.jsonl"), "--record", path.join(bench, "tripwire-natural-recording.json")]);
  assert.match(text, /recall on bad {2,}n\/a \(nothing planted in this set\)/);
  assert.match(text, /false flags on clean\s+4%/);
});

test("a live run with no engine refuses to overwrite the recording", () => {
  // This one is not hypothetical: a `--live` run on a machine without TYPESAFE_API_KEY wrote 130
  // rows of zeros over a good recording. The file stays structurally valid, so on replay it reads as
  // a flawless 0% false-flag rate — evidence destroyed, and the result looks better than before.
  const barren = path.join(tmp, "no-providers.json");
  fs.writeFileSync(barren, JSON.stringify({ defaults: { model: "fast" } }));
  const target = path.join(tmp, "must-not-be-written.json");

  const out = bf(["bench", "tripwire", "--live", "--record", target], { expectFail: true, config: barren });
  assert.match(out, /ran on only 0 of 130 diffs/);
  assert.match(out, /TYPESAFE_API_KEY/);
  assert.equal(fs.existsSync(target), false, "no recording may be written");
});
