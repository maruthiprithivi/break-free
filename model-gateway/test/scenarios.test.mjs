// The scenario comparison: the data set's integrity, the cost model's reproducibility, and the
// guardrails the comparison exists to show. Offline, deterministic, no API key.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { laneCost, laneModel, loadScenarios, scoreArm, staticArms, totals } from "../dist/scenarios.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "..", "dist", "cli.js");
const bench = path.join(here, "..", "bench");
const scenarios = loadScenarios(path.join(bench, "scenarios.json"));
const allTasks = scenarios.flatMap((s) => s.tasks);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-scen-"));
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ defaults: { model: "fast" } }));

function bf(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: tmp, env: { ...process.env, MODEL_GATEWAY_CONFIG: configPath, TYPESAFE_API_KEY: "", BREAK_FREE_ROUTING: "" } });
    if (expectFail) throw new Error(`expected a non-zero exit for: bf ${args.join(" ")}`);
    return stdout;
  } catch (e) {
    if (!expectFail) throw new Error(`bf ${args.join(" ")} failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

const cfg = (extra = {}) => {
  const f = path.join(tmp, `c-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ defaults: { model: "fast" }, ...extra }));
  return loadConfig({ workspaceRoot: tmp, configPath: f }).config;
};

test("the scenario set is well formed and the labels are internally consistent", () => {
  assert.equal(scenarios.length, 10, "ten workflows");
  assert.deepEqual(scenarios.map((s) => s.id), Array.from({ length: 10 }, (_, i) => `sc-${String(i + 1).padStart(2, "0")}`));
  assert.ok(allTasks.length >= 70 && allTasks.length <= 85, `tasks: ${allTasks.length}`);
  const lanes = ["local", "fast", "strong", "thinker"];
  const allowedVerify = /^(npm test|npm run [\w:-]+|npx tsc --noEmit|npx eslint \.)$/;
  const tier = { local: 0, fast: 1, strong: 2, thinker: 3 };
  for (const sc of scenarios) {
    assert.ok(sc.story.length > 40, `${sc.id} needs a story`);
    assert.ok(sc.tasks.length >= 6, `${sc.id} has ${sc.tasks.length} tasks`);
    // every scenario must contain work a naive "everything on fast" policy would get wrong,
    // or the comparison is decided before it starts
    assert.ok(sc.tasks.some((t) => t.lane === "strong" || t.lane === "thinker"), `${sc.id} has no hard task`);
    for (const t of sc.tasks) {
      assert.match(t.id, new RegExp(`^${sc.id}-\\d+$`));
      assert.ok(lanes.includes(t.lane), `${t.id} lane ${t.lane}`);
      assert.ok(lanes.includes(t.cheapest_passing_lane), `${t.id} cheapest ${t.cheapest_passing_lane}`);
      assert.ok(tier[t.cheapest_passing_lane] <= tier[t.lane], `${t.id}: cheapest cannot exceed the lane`);
      assert.ok(t.difficulty >= 0 && t.difficulty <= 4, `${t.id} difficulty`);
      assert.ok(t.files && t.files.length > 0, `${t.id} needs files for the policy check`);
      assert.ok(t.tags && t.tags.length >= 3, `${t.id} needs tags`);
      assert.match(t.verify, allowedVerify, `${t.id} verify must be allow-listed`);
      if (t.sensitive) assert.ok(["local", "strong"].includes(t.lane), `${t.id}: sensitive work must be local or strong`);
    }
  }
  const ids = new Set(allTasks.map((t) => t.id));
  assert.equal(ids.size, allTasks.length, "task ids must be unique across scenarios");
});

test("crew cost is priced from the shipped table, so it does not move with a local alias override", () => {
  // The whole comparison is meant to be reproducible. If cost were priced through the user's
  // aliases, an override pointing at an unpriced model would silently make a lane free, and the
  // same run would print different money on different machines.
  const plain = cfg();
  const wild = cfg({ aliases: { fast: ["mock/unpriced-model"], strong: ["mock/unpriced-model"], local: ["mock/unpriced-model"], thinker: ["mock/unpriced-model"] }, pricing: { "deepseek/deepseek-v4-flash": { input: 999, output: 999 } } });
  for (const lane of ["local", "fast", "strong", "thinker", "lead_keeps"]) {
    assert.equal(laneCost(wild, lane), laneCost(plain, lane), `${lane} must be priced identically`);
  }
  assert.ok(laneCost(plain, "strong") > laneCost(plain, "fast"), "strong costs more than fast");
  assert.equal(laneCost(plain, "local"), 0, "the local lane is free");
  assert.equal(laneCost(plain, "lead_keeps"), 0, "a task handed back costs no crew money");
});

test("scoring counts the right lane, and routing below the passing lane separately", () => {
  const tasks = [
    { id: "a", task: "x", lane: "strong", cheapest_passing_lane: "strong", difficulty: 3, sensitive: false, needs_lead: false, long_refactor: false },
    { id: "b", task: "y", lane: "fast", cheapest_passing_lane: "fast", difficulty: 1, sensitive: false, needs_lead: false, long_refactor: false },
    { id: "c", task: "z", lane: "thinker", cheapest_passing_lane: "strong", difficulty: 4, sensitive: false, needs_lead: false, long_refactor: false },
  ];
  const c = cfg();
  const exact = scoreArm(c, tasks, new Map([["a", "strong"], ["b", "fast"], ["c", "thinker"]]));
  assert.deepEqual([exact.exact_pct, exact.under_pct, exact.escalated], [100, 0, 0]);
  // 'b' on local is weaker than the lane that passes: under-routing, even though 'local' is cheap
  const under = scoreArm(c, tasks, new Map([["a", "strong"], ["b", "local"], ["c", "strong"]]));
  assert.deepEqual([under.exact_pct, under.under_pct], [33, 33], "only 'a' matches its label; only 'b' is below the passing lane");
  // handing work back is an escalation, not an under-route
  const esc = scoreArm(c, tasks, new Map([["a", "lead_keeps"], ["b", "unclear"], ["c", "thinker"]]));
  assert.deepEqual([esc.exact_pct, esc.under_pct, esc.escalated], [33, 0, 2]);
});

test("the no-routing arm is every task on defaults.model, and the lead arm is the label", () => {
  const c = cfg({ defaults: { model: "deepseek/deepseek-v4-pro" } });
  const { lead, off } = staticArms(c, allTasks);
  assert.deepEqual([...new Set(off.lanes.values())], ["fast"]);
  assert.match(off.note, /defaults\.model/);
  assert.equal(lead.lanes.get("sc-01-1"), scenarios[0].tasks[0].lane);
  assert.equal(laneModel(c, "thinker"), "thinker");
  assert.equal(laneModel(c, "lead_keeps"), null, "a lane mapped to null means the lead keeps it");
});

test("bf scenarios runs offline and is reproducible", () => {
  // Everything except the measured wall-clock must be identical run to run.
  const strip = (body) => JSON.stringify({ meta: body.meta, totals: { ...body.totals, jev_ms: 0, rules_ms: 0, jev_ms_per_plan: 0 }, scores: body.scores.map((s) => ({ ...s, jev_ms: 0, rules_ms: 0 })) });
  const a = JSON.parse(bf(["scenarios", "--json"]));
  const b = JSON.parse(bf(["scenarios", "--json"]));
  assert.equal(strip(a), strip(b));
  const body = a;
  assert.equal(body.meta.scenarios, 10);
  assert.equal(body.meta.live, false);
  assert.equal(body.totals.tasks, 80);
});

test("the comparison shows the guardrail: doing nothing under-routes most, rules second, Jev least", () => {
  const body = JSON.parse(bf(["scenarios", "--json"]));
  const t = body.totals.arms;
  // right task, right lane
  assert.ok(t.jev.exact_pct > t.rules.exact_pct, `jev ${t.jev.exact_pct}% must beat rules ${t.rules.exact_pct}%`);
  assert.ok(t.rules.exact_pct > t.off.exact_pct, `rules ${t.rules.exact_pct}% must beat off ${t.off.exact_pct}%`);
  assert.equal(t.lead.exact_pct, 100, "the expert label is the ceiling by construction");
  // routed below the lane that passes -- the metric that catches false savings
  assert.ok(t.jev.under_pct < t.rules.under_pct, `jev ${t.jev.under_pct}% under-routes less than rules ${t.rules.under_pct}%`);
  assert.ok(t.rules.under_pct < t.off.under_pct, `rules ${t.rules.under_pct}% under-routes less than off ${t.off.under_pct}%`);
  assert.equal(t.lead.under_pct, 0);
  // Jev spends less than the expert lead's own picks, and never more than all-strong
  assert.ok(t.jev.cost_usd < t.lead.cost_usd, "routing should be cheaper than the conservative expert picks");
  assert.ok(t.jev.cost_usd < body.scores.reduce((n, s) => n + s.all_strong_usd, 0));
  // routing its own calls is a rounding error next to crew spend
  assert.ok(body.totals.jev_decision_usd < t.jev.cost_usd / 100, `decision cost ${body.totals.jev_decision_usd} vs crew ${t.jev.cost_usd}`);
  // escalation stays inside the band the brief sets
  const rate = (t.jev.escalated / body.totals.tasks) * 100;
  assert.ok(rate >= 10 && rate <= 25, `escalation ${rate}% outside 10-25%`);
});

test("the per-scenario report names each workflow and its numbers", () => {
  const out = bf(["scenarios"]);
  assert.match(out, /# bf scenarios — 10 agent workflows, 80 tasks/);
  assert.match(out, /Ship team invitations end to end/);
  assert.match(out, /Write the v4 breaking-change migration guide/);
  assert.match(out, /## Right task to the right lane/);
  assert.match(out, /## Routed below the lane that passes \(the guardrail — lower is safer\)/);
  assert.match(out, /right lane\s+jev \d+%\s+rules \d+%\s+off \d+%\s+lead 100%/);
  assert.match(out, /under-routed\s+jev \d+%\s+rules \d+%\s+off \d+%\s+lead 0%/);
  assert.match(out, /routing time\s+jev \d+ ms for 10 plans/);
  // the replay must report the LIVE latency, not its own near-zero local time
  assert.match(out, /replayed from scenario-recording\.json/);
  assert.doesNotMatch(out, /routing time\s+jev [0-9] ms for 10 plans/);
});

test("a missing recording fails loudly instead of quietly answering with defaults", () => {
  const out = bf(["scenarios", "--record", path.join(tmp, "nope.json")], { expectFail: true });
  assert.match(out, /no recorded decisions at/);
  assert.match(out, /--live to capture them/);
});
