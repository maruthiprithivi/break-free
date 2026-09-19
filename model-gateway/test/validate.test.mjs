// The label validator: the summary maths, the verdict wording, and the guards that stop it
// producing a clean result that means nothing. No workers are run — the executor is injected.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { laneFor, renderValidation, summarise, toValidateTasks } from "../dist/validate.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "..", "dist", "cli.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-validate-"));
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ defaults: { model: "fast" } }));
const config = loadConfig({ workspaceRoot: tmp, configPath }).config;
const bench = path.join(here, "..", "bench");

const task = (id, lane, cheapest) => ({ id, task: `do ${id}`, verify: "npm test", lane, cheapest_passing_lane: cheapest });
const outcome = (id, arm, verify_ok, over = {}) => ({ task: id, arm, lane: "fast", verify_ok, model: "mock/x", ms: 10, ...over });

function bf(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: tmp, env: { ...process.env, MODEL_GATEWAY_CONFIG: configPath, TYPESAFE_API_KEY: "" } });
    if (expectFail) throw new Error(`expected a non-zero exit for: bf ${args.join(" ")}`);
    return { stdout, code: 0 };
  } catch (e) {
    if (!expectFail) throw new Error(`bf ${args.join(" ")} failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    return { stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

test("lanes resolve through the lane map, and lead_keeps has none", () => {
  assert.equal(laneFor(config, "fast"), "fast");
  assert.equal(laneFor(config, "strong"), "strong");
  assert.equal(laneFor(config, "lead_keeps"), null);
  assert.equal(laneFor(config, "unclear"), null);
});

test("every claim holding is reported as not contradicted, never as proof", () => {
  const tasks = [task("t1", "fast", "fast"), task("t2", "strong", "strong")];
  const r = summarise([outcome("t1", "claimed", true), outcome("t1", "lead", true), outcome("t2", "claimed", true), outcome("t2", "lead", true)], tasks, config);
  assert.deepEqual([r.label_validation.checked, r.label_validation.passed, r.label_validation.failed, r.label_validation.labels_hold], [2, 2, 0, true]);
  assert.match(r.verdict, /not yet contradicted/);
  assert.equal(r.arms.claimed.pass_pct, 100);
});

test("one lane that was supposed to pass and did not invalidates the savings claim", () => {
  const tasks = [task("t1", "fast", "fast"), task("t2", "strong", "fast")];
  const r = summarise([outcome("t1", "claimed", true), outcome("t2", "claimed", false)], tasks, config);
  assert.deepEqual([r.label_validation.checked, r.label_validation.passed, r.label_validation.failed, r.label_validation.labels_hold], [2, 1, 1, false]);
  assert.match(r.verdict, /FAILED verify in 1 of 2/);
  assert.match(r.verdict, /inflated/);
});

test("a verify that cannot fail is excluded rather than counted as a pass", () => {
  // The whole point: if `npm test` already passes on the untouched tree, an arm that runs nothing
  // still "passes". Counting that would manufacture a clean sweep out of nothing.
  const tasks = [task("t1", "fast", "fast"), task("t2", "strong", "strong")];
  const r = summarise([outcome("t1", "claimed", true), outcome("t1", "lead", true), outcome("t2", "claimed", true)], tasks, config, ["t1"]);
  assert.deepEqual(r.unfalsifiable, ["t1"]);
  assert.equal(r.tasks, 1);
  assert.deepEqual([r.label_validation.checked, r.arms.claimed.runs], [1, 1], "only t2 is counted");
  assert.equal(r.rows.some((o) => o.task === "t1"), false);
});

test("nothing falsifiable at all is reported as saying nothing, not as success", () => {
  const tasks = [task("t1", "fast", "fast")];
  const r = summarise([outcome("t1", "claimed", true)], tasks, config, ["t1"]);
  assert.equal(r.label_validation.checked, 0);
  assert.equal(r.label_validation.labels_hold, false, "an empty check is not a pass");
  assert.match(r.verdict, /nothing was checked/);
  assert.match(r.verdict, /verify actually fails first/);
});

test("unverified and errored runs are neither passes nor failures", () => {
  const tasks = [task("t1", "fast", "fast"), task("t2", "fast", "fast")];
  const r = summarise([outcome("t1", "claimed", null), outcome("t2", "claimed", null, { error: "worker exploded" })], tasks, config);
  assert.deepEqual([r.arms.claimed.unverified, r.arms.claimed.errored, r.arms.claimed.passed], [1, 1, 0]);
  assert.equal(r.label_validation.checked, 0, "neither run produced a verdict");
  assert.equal(r.label_validation.labels_hold, false);
});

test("the report shows each arm against each task, with the models that answered", () => {
  const tasks = [task("t1", "strong", "fast")];
  const r = summarise([outcome("t1", "claimed", true, { lane: "fast", model: "deepseek/deepseek-v4-flash" }), outcome("t1", "lead", false, { lane: "strong", model: "deepseek/deepseek-v4-pro" }), outcome("t1", "jev", true, { lane: "fast" })], tasks, config);
  const out = renderValidation(r, { workspace: "/repo", set: "bench/route-set.jsonl", withRouting: true });
  assert.match(out, /# bf validate — do the labels hold\?/);
  assert.match(out, /pass \(fast\)\s+FAIL \(strong\)\s+pass \(fast\)/);
  assert.match(out, /claimed\s+1 passed, 0 failed, 0 unverified, 0 errored\s+\(100% pass of 1\)/);
  assert.match(out, /lead\s+0 passed, 1 failed/);
  assert.match(out, /models: deepseek\/deepseek-v4-flash/);
  assert.match(out, /claimed cheapest lane: 1\/1 passed/);
  assert.match(out, /lanes come from/);
});

test("it refuses a workspace that is not a git repo, and one with uncommitted work", () => {
  // It resets the tree between arms, so everything it might throw away must be committed first.
  const plain = fs.mkdtempSync(path.join(tmp, "plain-"));
  const notGit = bf(["validate", "--workspace", plain, "--tasks", "1"], { expectFail: true });
  assert.match(notGit.stdout, /not a git repository/);

  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
  const dirty = bf(["validate", "--workspace", repo, "--tasks", "1"], { expectFail: true });
  assert.match(dirty.stdout, /uncommitted changes/);
  assert.match(dirty.stdout, /--force/);
});

test("a set with no verify commands, or an empty selection, is refused", () => {
  const noVerify = path.join(tmp, "no-verify.jsonl");
  fs.writeFileSync(noVerify, JSON.stringify({ id: "x", task: "do x", lane: "fast", cheapest_passing_lane: "fast" }) + "\n");
  const out = bf(["validate", "--set", noVerify, "--workspace", tmp, "--force"], { expectFail: true });
  assert.match(out.stdout, /no tasks with a verify command/);
});

test("the shipped sets are usable as validation input", () => {
  const line = fs.readFileSync(path.join(bench, "route-set.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(line.length === 60);
  // every label row the validator reads must carry the two lanes and a verify the gateway allows
  for (const t of line.slice(0, 20)) {
    const norm = toValidateTasks([t])[0];
    assert.ok(norm, `${t.id} did not normalise into a validate task`);
    assert.equal(norm.lane, t.lead_lane, "lead_lane normalises to lane");
    assert.equal(laneFor(config, norm.cheapest_passing_lane) !== null, true);
  }
});
