// `bf validate --with-routing` on the crew set: the routing engine has to actually reach the
// spawned server, an arm that never ran has to be called dead, and a failed verify has to be
// retried once with the failure handed back to the worker.
//
// Two layers, because the defects live in two places:
//   - the summary maths and the report, driven with hand-built rows (free, exact);
//   - the command itself, against a mock crew provider and the deterministic TypeSafe double,
//     so the routing path, the exit code and the retry are exercised end to end offline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { exitCodeFor, laneFor, renderValidation, summarise } from "../dist/validate.js";
import { startMockProvider } from "./mock-provider.mjs";
import { startTypeSafeDouble } from "../dist/jev-double.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "..", "dist", "cli.js");

let mock;
let double;

before(async () => {
  mock = await startMockProvider();
  double = await startTypeSafeDouble({});
});

after(async () => {
  await mock?.close();
  await double?.close();
});

// ---------------------------------------------------------------- summary maths

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bf-crew-")));
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ defaults: { model: "fast" } }));
const config = loadConfig({ workspaceRoot: tmp, configPath }).config;

const task = (id) => ({ id, task: `do ${id}`, verify: "npm test", lane: "strong", cheapest_passing_lane: "fast" });
const outcome = (id, arm, verify_ok, over = {}) => ({ task: id, arm, lane: "fast", confidence: null, first_attempt_ok: verify_ok, verify_ok, attempts: 1, model: "mock/x", ms: 10, ...over });
/** A row for work that never started: the reason is the whole point of the row. */
const notRun = (id, arm, reason) => ({ task: id, arm, lane: "(none)", confidence: null, verify_ok: null, model: "", ms: 0, not_run: reason });
const render = (r) => renderValidation(r, { workspace: "/repo", set: "bench/validate-crew.jsonl", withRouting: true });

test("an arm that produced no verify result is called dead, and the command must not exit 0", () => {
  const tasks = [task("t1"), task("t2")];
  const unmapped = (id) => notRun(id, "jev", `the routing engine answered "off" (source: "config") and returned no decision for this task, so no lane was ever chosen`);
  const rows = [outcome("t1", "claimed", true), outcome("t1", "lead", true), outcome("t2", "claimed", true), outcome("t2", "lead", true), unmapped("t1"), unmapped("t2")];
  const r = summarise(rows, tasks, config);

  assert.deepEqual(r.dead_arms, ["jev"]);
  assert.equal(exitCodeFor(r), 1, "a dead arm is not a clean run");
  assert.equal(r.label_validation.failed, 0, "the labels are fine — it is the arm that is missing");
  assert.deepEqual([r.runs, r.errored, r.not_run], [4, 0, 2], "the never-run rows are not runs");
  assert.match(r.verdict, /partial result/);

  const out = render(r);
  assert.match(out, /!! DEAD ARM jev/);
  assert.match(out, /4 real runs with the gateway's own verify, 2 not run/);
  assert.match(out, /returned no decision for this task/, "the real cause, not 'no lane mapped'");
  assert.doesNotMatch(out, /no lane mapped/, "the old wording sent the reader hunting for a lane-mapping bug");
  assert.match(out, /^ {2}t1\s+pass \(fast\)\s+pass \(fast\)\s+not run$/m, "a never-run row says so in the table");
});

test("the header counts runs that produced a verify result, never rows", () => {
  const tasks = [task("t1"), task("t2")];
  // The shape of the bug: four rows, but only two of them ever produced a verify result.
  const rows = [
    outcome("t1", "claimed", true),
    outcome("t1", "lead", false),
    outcome("t2", "claimed", null, { error: "provider 500 after 3 attempts", model: "" }),
    notRun("t2", "jev", "the engine handed this task back to the lead: confidence 0.41 is below the 0.7 threshold"),
  ];
  const r = summarise(rows, tasks, config);
  assert.deepEqual([r.runs, r.errored, r.not_run], [2, 1, 1]);
  const out = render(r);
  assert.match(out, /2 real runs with the gateway's own verify, 1 errored, 1 not run/);
  assert.doesNotMatch(out, /4 real runs/);
  assert.match(out, /ERR \(fast\)/, "an errored run is marked as one, not shown as a lane result");
});

test("criterion 2 and criterion 3 are separate rates from the same rows", () => {
  const tasks = [task("t1"), task("t2")];
  const rows = [
    outcome("t1", "jev", true, { confidence: 0.92 }),
    outcome("t2", "jev", true, { confidence: 0.85, first_attempt_ok: false, attempts: 2 }),
    outcome("t1", "lead", true, { lane: "strong", model: "strong" }),
    outcome("t2", "lead", true, { lane: "strong", model: "strong" }),
  ];
  const r = summarise(rows, tasks, config);

  assert.deepEqual([r.arms.jev.first_pass_passed, r.arms.jev.retried, r.arms.jev.passed, r.arms.jev.runs], [1, 1, 2, 2]);
  assert.deepEqual(r.criteria.first_pass, { jev_pct: 50, comparator_pct: 100, gap_pts: -50 });
  assert.deepEqual(r.criteria.after_retry, { jev_pct: 100, comparator_pct: 100, gap_pts: 0 });
  assert.equal(r.criteria.comparator_is_all_strong, true, "every lead run used the strong lane's model");
  assert.equal(exitCodeFor(r), 0);

  const out = render(r);
  assert.match(out, /criterion 2 {2}first-pass verify: jev 50% vs lead \(all-strong\) 100% — gap -50 pts/);
  assert.match(out, /criterion 3 {2}after one retry: {2}jev 100% vs lead \(all-strong\) 100% — gap 0 pts/);
  assert.match(out, /1\/2 first pass, 1 retried/);
});

test("an empty confidence band has no rate, and says why, instead of reporting 0% failures", () => {
  // The band a criterion-8 comparison needs is the one routing never fills: a task below
  // routing.threshold is escalated to the lead, so it never runs and never fails.
  const tasks = [task("t1")];
  const r = summarise([outcome("t1", "jev", true, { confidence: 0.9 })], tasks, config);
  assert.deepEqual(
    r.confidence_buckets.map((b) => [b.bucket, b.runs, b.fail_pct]),
    [
      ["<0.5", 0, null],
      ["0.5-0.8", 0, null],
      [">=0.8", 1, 0],
    ],
  );
  assert.equal(r.criteria.calibration.holds, null, "an empty band cannot hold or miss a criterion");
  assert.match(r.criteria.calibration.note, /sends a task below routing\.threshold back to the lead/);
  assert.match(render(r), /<0.5: no runs/);
  assert.match(render(r), /NOT MEASURABLE/);
});

test("criterion 8 is computed when both bands have runs, and can be missed", () => {
  const tasks = [task("t1"), task("t2")];
  const band = (lowFails, highFails) => [
    outcome("t1", "jev", !lowFails, { confidence: 0.4 }),
    outcome("t2", "jev", true, { confidence: 0.49 }),
    outcome("t1", "jev", !highFails, { confidence: 0.8, attempts: 2, first_attempt_ok: false }),
    outcome("t2", "jev", true, { confidence: 0.99 }),
  ];
  const misses = summarise(band(true, true), tasks, config);
  assert.equal(misses.confidence_buckets[0].fail_pct, 50);
  assert.equal(misses.confidence_buckets[2].fail_pct, 50, "0.8 is the top band's floor");
  assert.equal(misses.criteria.calibration.holds, false, "50% is not at most half of 50%");
  assert.match(render(misses), /MORE than half: the criterion is MISSED/);

  const holds = summarise(band(true, false), tasks, config);
  assert.equal(holds.confidence_buckets[2].fail_pct, 0);
  assert.equal(holds.criteria.calibration.holds, true);
  assert.match(render(holds), /at most half, as the criterion requires/);
});

// ---------------------------------------------------------------- the command itself

/**
 * A scratch repo whose verify command counts its own invocations: it fails while the pre-flight
 * probes run and on the first attempt of every arm, and passes on every retry. That makes the two
 * things this file is about — a first pass and a retry — separately observable through one
 * deterministic command. The count lives outside the workspace, where `git clean` cannot reset it.
 */
function scratchRepo({ counter }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "proj-")));
  fs.writeFileSync(
    path.join(dir, "flip.mjs"),
    `import fs from "node:fs";
const counter = process.env.BF_FLIP_COUNTER;
if (!counter) {
  console.error("BF_FLIP_COUNTER is not set, so this verify cannot count its calls");
  process.exit(3);
}
const probes = Number(process.argv[2] ?? 0);
const mode = process.argv[3] === "probes-only" ? "probes-only" : "first-attempts";
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(n));
// probes-only: every arm passes first time.
// first-attempts: each post-probe odd call is a first attempt (fails) and its retry (even) passes.
const failed = n <= probes || (mode === "first-attempts" && (n - probes) % 2 === 1);
console.error(\`flip verify: call \${n} (probes \${probes}, \${mode}) -> \${failed ? "FAIL" : "pass"}\`);
process.exit(failed ? 1 : 0);
`,
  );
  fs.writeFileSync(path.join(dir, "README.md"), "scratch fixture for bf validate\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: dir });
  fs.rmSync(counter, { force: true });
  return dir;
}

/** A crew set: the lane a lead would pick is strong, the labelled cheapest lane is fast. */
function crewSet(dir, ids, probes, mode = "first-attempts") {
  const file = path.join(path.dirname(dir), `${path.basename(dir)}-set.jsonl`);
  const rows = ids.map((id) =>
    JSON.stringify({
      id,
      task: `Implement ${id}() in src/${id}.mjs so its test passes.`,
      acceptance: `\`node flip.mjs ${probes} ${mode}\` exits 0`,
      verify: `node flip.mjs ${probes} ${mode}`,
      files: [`src/${id}.mjs`],
      tags: ["fixture"],
      lead_lane: "strong",
      cheapest_passing_lane: "fast",
    }),
  );
  fs.writeFileSync(file, rows.join("\n") + "\n");
  return file;
}

function gatewayConfig({ dir, laneMap, doubleUrl }) {
  // Outside the workspace: `bf validate` refuses a dirty tree, and this file is not part of the work.
  const file = path.join(tmp, `${path.basename(dir)}-gateway.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      logFile: false,
      sessionDir: path.join(dir, "sessions"),
      defaults: { model: "mock/good", reviewer: "mock/good", supervisor: "mock/good", timeoutMs: 20_000, maxToolIterations: 2 },
      // No chain: a lane that is meant to fail must not be rescued by a fallback candidate.
      fallback: { chain: [], retriesPerCandidate: 0, retryDelayMs: 0 },
      providers: { mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" }, typesafe: { baseUrl: doubleUrl, apiKey: "test-key" } },
      // Deliberately the stock shape of the bug: the server's own config says `off`. `--with-routing`
      // has to carry the engine on the call, because this is the file the spawned server reads.
      routing: { engine: "off", laneMap, threshold: 0.7, retries: 1, retryDelayMs: 0 },
      workers: { allowedCommands: ["node"], maxConcurrency: 2, projectInstructions: false },
    }),
  );
  return file;
}

/**
 * Run the command and wait for it. Asynchronous on purpose: the mock crew provider and the Jev
 * double live in THIS process, and a synchronous spawn would block its event loop, so every model
 * call they are supposed to answer would time out.
 */
function runValidate(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "validate", ...args], {
      env: { ...process.env, MODEL_GATEWAY_CONFIG: env.config, TYPESAFE_API_KEY: "", BREAK_FREE_ROUTING: "", BF_FLIP_COUNTER: env.counter },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      assert.equal(signal, null, `bf validate did not finish on its own: ${stderr}`);
      resolve({ code, report: () => JSON.parse(stdout).report, stdout, stderr });
    });
  });
}

test("--with-routing routes: the engine reaches the spawned server and the routed arm runs", async () => {
  const counter = path.join(tmp, "counter-routes");
  const dir = scratchRepo({ counter });
  const set = crewSet(dir, ["alpha", "beta"], 2);
  const config = gatewayConfig({ dir, doubleUrl: double.url, laneMap: { fast: "mock/good", strong: "mock/strong" } });
  // alpha is a confident `fast`; beta is below the threshold, so the engine hands it to the lead.
  double.setDecisions({ alpha: { lane: "fast", confidence: 0.95, difficulty: 1, sensitive: 0.02, context: 0.1 }, beta: { lane: "strong", confidence: 0.41, difficulty: 3, sensitive: 0.05, context: 0.3 } });

  const before = double.calls.length;
  const run = await runValidate(["--set", set, "--workspace", dir, "--tasks", "2", "--with-routing", "--json"], { config, counter });
  const r = run.report();

  // `bf validate` routes one task at a time (the double also answers capability probes, which carry
  // no questions); what matters is that the engine was asked about both tasks at all.
  const asked = double.calls.slice(before).flatMap((c) => c.questions);
  assert.ok(asked.includes("alpha__lane") && asked.includes("beta__lane"), `the engine was never asked to route the set: ${JSON.stringify(asked)}`);
  assert.equal(run.code, 0, run.stderr);
  const jev = r.rows.filter((o) => o.arm === "jev");
  assert.deepEqual(
    jev.map((o) => [o.task, o.lane, o.confidence, o.verify_ok, o.attempts]),
    [
      ["alpha", "fast", 0.95, true, 2],
      ["beta", "(none)", null, null, undefined],
    ],
  );
  assert.match(jev[0].model, /^mock\//, "the routed lane ran on the model the lane map names");
  assert.match(jev[1].not_run, /handed this task back to the lead: confidence 0\.41 is below the 0\.7 threshold/);
  assert.doesNotMatch(run.stdout, /no lane mapped/);
  assert.equal(r.arms.jev.not_run_reasons.length, 1);
  assert.deepEqual([r.arms.jev.runs, r.arms.jev.retried], [1, 1]);
  assert.deepEqual([r.arms.claimed.runs, r.arms.lead.runs], [2, 2], "the label arms ran too");
  assert.deepEqual(r.dead_arms, [], "an escalated task is not a dead arm");
  assert.equal(r.criteria.comparator_is_all_strong, true);
  // Criterion 8's reality: the only routed run sits at 0.95, so there is nothing below 0.5 to
  // compare it with — the task that would have been there was escalated and never ran.
  assert.deepEqual(r.confidence_buckets.map((b) => [b.bucket, b.runs, b.fail_pct]), [["<0.5", 0, null], ["0.5-0.8", 0, null], [">=0.8", 1, 0]]);
  assert.equal(r.criteria.calibration.holds, null);
});

test("an arm whose every run errored is reported as dead and the command exits non-zero", async () => {
  const counter = path.join(tmp, "counter-dead");
  const dir = scratchRepo({ counter });
  const set = crewSet(dir, ["alpha", "beta"], 2, "probes-only");
  // The engine is confident, and the lane it picks is mapped to a model that answers 500.
  const config = gatewayConfig({ dir, doubleUrl: double.url, laneMap: { fast: "mock/good", strong: "mock/strong", thinker: "mock/boom500" } });
  double.setDecisions({ alpha: { lane: "thinker", confidence: 0.93, difficulty: 3 }, beta: { lane: "thinker", confidence: 0.93, difficulty: 3 } });

  const run = await runValidate(["--set", set, "--workspace", dir, "--tasks", "2", "--with-routing", "--json"], { config, counter });
  const r = run.report();

  assert.equal(r.label_validation.labels_hold, true, "the labels held — so the dead arm is the whole story");
  assert.deepEqual(r.dead_arms, ["jev"]);
  assert.deepEqual([r.runs, r.errored, r.not_run], [4, 2, 0], "errored attempts are not runs in the header");
  assert.deepEqual([r.arms.jev.runs, r.arms.jev.passed, r.arms.jev.errored, r.arms.jev.models], [0, 0, 2, []]);
  const jevRows = r.rows.filter((o) => o.arm === "jev");
  assert.equal(jevRows.length, 2);
  assert.ok(
    jevRows.every((o) => typeof o.error === "string" && o.error.length > 0 && o.verify_ok === null),
    `a lane that cannot answer must say so on every row: ${JSON.stringify(jevRows)}`,
  );
  assert.equal(run.code, 1, `an entirely errored arm must not exit 0\n${run.stdout}`);
});

test("a failed verify is retried once, and the retry is told what failed", async () => {
  const counter = path.join(tmp, "counter-retry");
  const dir = scratchRepo({ counter });
  const set = crewSet(dir, ["alpha"], 1);
  const config = gatewayConfig({ dir, doubleUrl: double.url, laneMap: { fast: "mock/good", strong: "mock/strong" } });
  double.setDecisions({ alpha: { lane: "fast", confidence: 0.9, difficulty: 1 } });

  const before = mock.calls.length;
  const run = await runValidate(["--set", set, "--workspace", dir, "--tasks", "1", "--with-routing", "--json"], { config, counter });
  const r = run.report();
  // Worker prompts only: the provider also answers capability probes that carry no task text.
  const asked = mock.calls.slice(before).map((c) => c.messages.at(-1).content).filter((t) => t.includes("Implement alpha()"));

  assert.equal(run.code, 0, run.stderr);
  // One task, three arms, every first attempt failing verify: six worker calls, three of them retries.
  assert.equal(asked.length, 6, "each arm ran twice");
  const retries = asked.filter((t) => t.includes("A previous attempt at this task ran"));
  assert.equal(retries.length, 3, "every arm's failed first attempt was retried");
  for (const t of retries) {
    assert.match(t, /verify command failed/);
    assert.match(t, /command: node flip\.mjs 1 first-attempts/);
    assert.match(t, /exit: 1/, "the retry is told the exit code, not just 'try again'");
  }
  // `attempts` above 1 is what makes "after one retry" separable from "first pass".
  for (const arm of ["claimed", "lead", "jev"]) {
    const o = r.rows.find((x) => x.arm === arm);
    assert.deepEqual([o.attempts, o.first_attempt_ok, o.verify_ok], [2, false, true], `${arm} needed its retry`);
  }
  assert.deepEqual([r.arms.jev.first_pass_passed, r.arms.jev.retried, r.arms.jev.passed], [0, 1, 1]);
  assert.deepEqual(r.criteria.first_pass, { jev_pct: 0, comparator_pct: 0, gap_pts: 0 });
  assert.deepEqual(r.criteria.after_retry, { jev_pct: 100, comparator_pct: 100, gap_pts: 0 });
  assert.equal(exitCodeFor(r), 0);
});

test("a lane with no model is still reported as unmapped", async () => {
  // `lead_keeps` maps to no model by design, so a set whose lead lane is `lead_keeps` has nothing
  // to run there. That is the one case where "no lane mapped" IS the real cause, and it must not be
  // lost while the routing-engine reasons are being fixed.
  const counter = path.join(tmp, "counter-lead-keeps");
  const dir = scratchRepo({ counter });
  const set = path.join(tmp, "lead-keeps-set.jsonl");
  fs.writeFileSync(
    set,
    JSON.stringify({ id: "alpha", task: "Implement alpha() in src/alpha.mjs.", verify: "node flip.mjs 1 probes-only", files: ["src/alpha.mjs"], tags: ["fixture"], lead_lane: "lead_keeps", cheapest_passing_lane: "fast" }) + "\n",
  );
  const config = gatewayConfig({ dir, doubleUrl: double.url, laneMap: { fast: "mock/good" } });
  assert.equal(laneFor(loadConfig({ workspaceRoot: dir, configPath: config }).config, "lead_keeps"), null, "the fixture relies on this lane having no model");

  const run = await runValidate(["--set", set, "--workspace", dir, "--tasks", "1", "--json"], { config, counter });
  const r = run.report();
  assert.match(r.rows.find((o) => o.arm === "lead").not_run, /lane lead_keeps maps to no model/);
  assert.deepEqual(r.dead_arms, ["lead"]);
  assert.equal(run.code, 1);
});
