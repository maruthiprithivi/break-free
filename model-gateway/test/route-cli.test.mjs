// `bf` command-line contract: what the bench, the route table and the demo actually print.
// Every case here is offline — the Jev arm replays a recording through the real client.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "..", "dist", "cli.js");
const bench = path.join(here, "..", "bench");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-cli-"));
const configPath = path.join(tmp, "config.json");
fs.writeFileSync(configPath, JSON.stringify({ defaults: { model: "fast" } }));

/** Run `bf` the way a user would: a real process, a real exit code, real stdout. */
function bf(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      cwd: tmp,
      env: { ...process.env, MODEL_GATEWAY_CONFIG: configPath, TYPESAFE_API_KEY: "", BREAK_FREE_ROUTING: "" },
    });
    if (expectFail) throw new Error(`expected a non-zero exit for: bf ${args.join(" ")}`);
    return stdout;
  } catch (e) {
    if (!expectFail) throw new Error(`bf ${args.join(" ")} failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

test("bf help explains the three commands", () => {
  const out = bf(["help"]);
  assert.match(out, /bf route --plan/);
  assert.match(out, /bf bench route/);
  assert.match(out, /TYPESAFE_API_KEY/);
});

test("bf route prints a route table and refuses without a plan", () => {
  const out = bf(["route", "--plan", path.join(bench, "demo-plan.json"), "--engine", "rules"]);
  const lines = out.split("\n");
  assert.match(lines[0], /^task\s+lane\s+model/);
  assert.match(out, /^design\s+thinker\s+thinker\s+0\.90/m);
  assert.match(out, /^readme\s+local\s+local\s+0\.90/m);
  assert.match(out, /^changelog\s+local\s+local\s+0\.90/m);
  assert.match(out, /^migration\s+strong\s+strong\s+0\.90\s+3\s+yes\s+no\s+policy/m);
  assert.match(out, /^engine rules · 12 tasks in \d+ ms/m);
  assert.match(out, /escalated 0\/12 · policy hits 1/);
  const failed = bf(["route"], { expectFail: true });
  assert.match(failed, /usage: bf route --plan/);
});

test("bf route on the Jev engine replays its live recording and shows confidence and escalation", () => {
  // The recording is real: captured from api.typesafe.ai, then replayed through the real client.
  const out = bf(["route", "--plan", path.join(bench, "demo-plan.json"), "--engine", "jev", "--record", path.join(bench, "demo-recording.json")]);
  assert.match(out, /^design\s+thinker\s+thinker\s+0\.99/m);
  assert.match(out, /^middleware\s+lead_keeps\s+— lead\s+0\.55\s+2\s+no\s+yes\s+confidence/m);
  assert.match(out, /^flaky-test\s+thinker\s+thinker\s+0\.73/m);
  assert.match(out, /^migration\s+strong\s+strong\s+0\.95\s+2\s+yes\s+yes\s+policy/m);
  assert.match(out, /engine jev · 12 tasks in \d+ ms/);
  assert.match(out, /escalated 1\/12 · policy hits 1/);
});

test("routing off is not a route table, it is a statement of the old behaviour", () => {
  const out = bf(["route", "--plan", path.join(bench, "demo-plan.json"), "--engine", "off"]);
  assert.match(out, /routing is off: an omitted model means config\.defaults\.model/);
});

test("bf bench route scores the four routers, and pins what Jev misses as well as what it hits", () => {
  // These are MEASURED numbers: the recording in bench/jev-recording.json was captured live from
  // api.typesafe.ai, and this replays it through the real client. The brief's targets and the
  // verdicts are written out, because a target that is missed is a result, not a bug to hide.
  const body = JSON.parse(bf(["bench", "route", "--json"]));
  const by = Object.fromEntries(body.metrics.map((m) => [m.router, m]));
  assert.equal(body.meta.tasks, 60);

  // every router is present, and the one that cannot run says so instead of guessing
  assert.deepEqual(Object.keys(by).sort(), ["jev", "lead", "llm", "rules"]);
  assert.equal(by.llm.measured, false);
  assert.match(by.llm.note, /provider key/);

  // the lead is the accuracy ceiling by construction: it IS the label
  assert.equal(by.lead.agreement_exact_pct, 100);

  // Criterion 5, exact lane agreement: target >= 80%. MISSED, and here is where it goes: the
  // three meta-lanes (codex_handoff, lead_keeps, unclear) are 9 of the 60 labels and carry no
  // signal a model could read from a task description.
  assert.equal(by.jev.agreement_exact_pct, 71.67);
  assert.ok(by.jev.agreement_exact_pct < 80, "if this now clears 80, the brief's criterion 5 is met — update the issue");
  assert.equal(by.jev.crew_lane_tasks, 49);
  assert.equal(by.jev.agreement_crew_lanes_pct, 83.67, "over the lanes a router can actually judge, the target is met");
  // Criterion 5, within one tier: target >= 95%. Met.
  assert.equal(by.jev.agreement_within_one_pct, 100);
  // Criterion 4, under-routing: target <= 10%. Met.
  assert.equal(by.jev.under_routing_pct, 6.98);
  // Criterion 9, escalation band: 10-25%. Met, at the bottom edge.
  assert.equal(by.jev.escalation_pct, 10);
  // Criterion 1, cost vs all-strong: target >= 50% lower. MISSED by 0.6 points, because
  // sensitiveLane "strong" deliberately upgrades 11 of the 60 tasks.
  assert.equal(by.jev.saved_vs_all_strong_pct, 49.4);
  assert.ok(by.jev.saved_vs_all_strong_pct < 50, "if this now clears 50, criterion 1 is met — update the issue");
  // Criterion 10, policy safety: the guardrail decided 18.33% of tasks and never sent one to a
  // cheaper lane than the model proposed.
  assert.equal(by.jev.forced_pct, 18.33);

  // Jev is not just rules, which is the question the brief says decides the story
  assert.ok(by.jev.agreement_exact_pct > by.rules.agreement_exact_pct, "rules must not match Jev on agreement");
  assert.ok(by.jev.agreement_crew_lanes_pct > by.rules.agreement_crew_lanes_pct);
  assert.ok(by.jev.under_routing_pct < by.rules.under_routing_pct, "rules must under-route more than Jev");
});

test("the bench is reproducible: everything except the measured latency is identical", () => {
  const strip = (body) => JSON.stringify({ meta: body.meta, metrics: body.metrics.map(({ ms_total, ms_p50, ms_per_plan, ...rest }) => rest) });
  const a = JSON.parse(bf(["bench", "route", "--json"]));
  const b = JSON.parse(bf(["bench", "route", "--json"]));
  assert.equal(strip(a), strip(b), "agreement, cost and escalation must not move between runs");
  assert.ok(a.metrics[2].ms_per_plan >= 0, "latency is measured, so it is reported but not pinned");
  const table = bf(["bench", "route"]);
  assert.match(table, /under % is over the tasks the router was free to choose for/);
  assert.match(table, /unmeasured: llm/);
});

test("bf demo shows the same plan routed three ways, with the escalation and the guardrail", () => {
  const out = bf(["demo"]);
  assert.match(out, /# bf demo — "Add rate limiting with tests, docs, a migration and a CLI flag" \(12 tasks\)/);
  assert.match(out, /## With Jev — one call routes the whole plan/);
  assert.match(out, /## Without Jev — deterministic rules/);
  assert.match(out, /## Without Jev — routing off \(pre-routing behaviour\)/);
  assert.match(out, /## Handed back to the lead/);
  assert.match(out, /middleware: confidence \(confidence 0\.55\) — lanes strong 0\.62 fast 0\.38/);
  assert.match(out, /## Guardrail \(sensitiveLane: strong\) — these get an independent review/);
  assert.match(out, /migration: lane strong \(policy: db\/migrations\/0031_rate_limit_buckets\.sql\)/);
  assert.match(out, /Jev:\s+\$\d+\.\d+ crew \+ \$\d+\.\d+ routing — \d+(\.\d+)?% cheaper than all-strong/);
  assert.match(out, /recorded decisions replayed through the real code path/);
});

test("bf demo --sensitive-lane local is the data-residency mode", () => {
  const out = bf(["demo", "--sensitive-lane", "local"]);
  assert.match(out, /## Guardrail \(sensitiveLane: local\) — these get an independent review/);
  assert.match(out, /migration: lane local \(policy: db\/migrations\/0031_rate_limit_buckets\.sql\) — data stays on this machine/);
});

test("bf demo --json exposes the numbers a post would quote", () => {
  const body = JSON.parse(bf(["demo", "--json"]));
  assert.equal(body.summary.tasks, 12);
  assert.equal(body.summary.with_jev.escalated, 1);
  assert.equal(body.summary.with_jev.policy_hits, 1);
  assert.ok(body.summary.with_jev.routing_ms > 0);
  assert.equal(body.summary.with_jev.answered_by, "jev");
  assert.deepEqual(body.summary.with_jev.lanes, { local: 2, fast: 3, strong: 4, thinker: 2, lead_keeps: 1 });
  assert.equal(body.summary.without_jev_off.model, "fast");
  assert.ok(body.summary.all_strong_usd > body.summary.with_jev.crew_cost_usd);
  assert.equal(body.summary.assumed_tokens_per_task.input, 20000);
  assert.equal(body.with_jev.find((d) => d.id === "middleware").escalated, true);
  assert.equal(body.with_jev.find((d) => d.id === "migration").requires_review, true);
});
