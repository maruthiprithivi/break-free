// End-to-end routing tests: the real MCP server over stdio, a mock chat provider for the crew,
// and the deterministic TypeSafe double in place of api.typesafe.ai. Offline and reproducible.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockProvider } from "./mock-provider.mjs";
import { startTypeSafeDouble } from "../dist/jev-double.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");

let mock;
let double;

const LANE_MODEL = { local: "mock/local", fast: "mock/good", strong: "mock/strong", thinker: "mock/thinker" };

/**
 * One gateway per test: the server reads its config (and its ledger) once at startup, so sharing
 * one instance across tests would leak both. Each test gets a fresh workspace, ledger and process.
 */
async function startGateway(over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-route-e2e-"));
  let ws = path.join(tmp, "repo");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  ws = fs.realpathSync(ws);
  fs.writeFileSync(path.join(ws, "ok.mjs"), "process.exit(0);\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: ws });
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      context: { toolProfile: "full" },
      sessionDir: path.join(tmp, "sessions"),
      logFile: path.join(tmp, "gateway.log"),
      defaults: { model: "fast", reviewer: "mock/good", supervisor: "mock/thinker", timeoutMs: 8000, maxToolIterations: 1 },
      fallback: { chain: ["mock/good"], retriesPerCandidate: 0, retryDelayMs: 0 },
      providers: { mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" }, typesafe: { baseUrl: double.url, apiKey: "test-key" } },
      aliases: { fast: ["mock/good"], strong: ["mock/strong"], local: ["mock/local"], thinker: ["mock/thinker"], reviewer: ["mock/good"] },
      // The mock arms must be PRICED here: an unpriced arm logs cost_usd 0, and `routing_savings`
      // now refuses to report a saving computed across one (#26) instead of printing an inflated
      // percentage — so without these entries this file's replay test would be testing that refusal
      // rather than the replay it is about.
      pricing: { mock: { input: 100, output: 100 } },
      routing: { engine: "jev", threshold: 0.7, retries: 1, retryDelayMs: 0, laneMap: LANE_MODEL },
      workers: { allowedCommands: ["node"], maxConcurrency: 2, projectInstructions: false },
      ...over,
    }),
  );
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", configPath], env: { ...process.env, TYPESAFE_API_KEY: "", BREAK_FREE_ROUTING: "" }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join("\n");
    return { text, isError: !!r.isError, json: () => JSON.parse(text), meta: () => JSON.parse(text.slice(text.lastIndexOf("\nmeta: ") + 7)) };
  };
  const ledgerDir = () => path.join(ws, ".break-free");
  const taskFiles = () => {
    const d = path.join(ledgerDir(), "tasks");
    return fs.existsSync(d) ? fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), "utf8")) : [];
  };
  const journalText = () => {
    const d = path.join(ledgerDir(), "journal");
    return fs.existsSync(d) ? fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), "utf8")).join("\n") : "";
  };
  const scorecards = () => {
    const f = path.join(ledgerDir(), "scorecards.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const close = async () => {
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { call, ws, taskFiles, journalText, scorecards, close };
}

/** The five lanes: prose, a small test, a policy-sensitive migration, a design question, and one Jev will not call. */
const PLAN = [
  { id: "doc", task: "Document the limiter in the README", files: ["README.md"], tags: ["docs"], verify: "node ok.mjs", acceptance: "a reader can configure a limit" },
  { id: "tst", task: "Add a unit test for the retry helper", files: ["test/retry.test.ts"], tags: ["tests"], verify: "node ok.mjs" },
  { id: "mig", task: "Add the migration for the rate-limit table", files: ["db/migrations/0031_rate_limit.sql"], tags: ["migration"], verify: "node ok.mjs" },
  { id: "q", task: "Decide between a fixed window and a sliding window", tags: ["design"], verify: "node ok.mjs" },
  { id: "escalate", task: "Fix the flaky scheduler test", files: ["test/scheduler.test.ts"], tags: ["tests"], verify: "node ok.mjs" },
];

const LANES = {
  doc: { lane: "local", confidence: 0.95, difficulty: 0, sensitive: 0.03, context: 0.1 },
  tst: { lane: "fast", confidence: 0.93, difficulty: 1, sensitive: 0.05, context: 0.2 },
  mig: { lane: "strong", confidence: 0.88, difficulty: 3, sensitive: 0.93, context: 0.31 },
  q: { lane: "thinker", confidence: 0.78, difficulty: 4, sensitive: 0.04, context: 0.7 },
  escalate: { lane: "fast", confidence: 0.41, difficulty: 2, sensitive: 0.08, context: 0.36, probs: { fast: 0.31, strong: 0.34, thinker: 0.29, local: 0.06 } },
};

before(async () => {
  mock = await startMockProvider();
  double = await startTypeSafeDouble({});
});

after(async () => {
  await mock?.close();
  await double?.close();
});

test("run_plan routes every model-less task in one Jev call and records why", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  double.setDecisions(LANES);
  const before = double.requests.length;
  const r = await g.call("run_plan", { goal: "add rate limiting", tasks: PLAN, track: true });
  assert.equal(r.isError, false, r.text);
  const meta = r.meta();
  assert.equal(double.requests.length - before, 1, "one round trip for the whole plan");
  assert.equal(Object.keys(double.requests.at(-1).questions).length, 20, "four typed questions per task");

  const byId = new Map(meta.results.map((x) => [x.id, x]));
  // This asserts which LANE each task was routed to. The statuses come from the mock reviewer,
  // which always says "revise" — and since #53 a reviewer asking for changes no longer reports
  // the task done, so the reviewed ones land on needs_revision.
  assert.deepEqual(
    [...byId].map(([id, x]) => [id, x.model]),
    [
      ["doc", LANE_MODEL.local],
      ["tst", LANE_MODEL.fast],
      ["mig", LANE_MODEL.strong],
      ["q", LANE_MODEL.thinker],
      ["escalate", undefined],
    ],
  );
  assert.equal(byId.get("escalate").status, "escalated");
  for (const id of ["doc", "tst", "mig", "q"]) {
    assert.ok(["done", "needs_revision"].includes(byId.get(id).status), `${id}: ${byId.get(id).status}`);
  }
  assert.equal(byId.get("doc").route.lane, "local");
  assert.equal(byId.get("q").route.confidence, 0.78);
  assert.equal(byId.get("q").route.difficulty, 4);
  assert.equal(byId.get("q").route.needs_repo_context, true);
  // the migration is policy-sensitive: raised to strong and flagged for review
  assert.equal(byId.get("mig").route.reason, "policy");
  assert.equal(byId.get("mig").route.requires_review, true);
  assert.deepEqual(byId.get("mig").route.policy_hits, ["db/migrations/0031_rate_limit.sql"]);

  // the report carries the route table, and the escalation is stated separately
  assert.match(r.text, /## Routing/);
  assert.match(r.text, /\| q \| thinker \| mock\/thinker \| 0\.78 \|/);
  assert.match(r.text, /## Escalated to you/);
  assert.match(r.text, /escalate\*\* — confidence: routed to you: confidence 0\.41 below 0\.7 \(lanes strong=0\.34 fast=0\.31 thinker=0\.29\)/);

  // ledger provenance
  const tasks = g.taskFiles().join("\n---\n");
  assert.match(tasks, /routed_by: jev/);
  assert.match(tasks, /route_lane: strong/);
  assert.match(tasks, /route_confidence: 0\.88/);
  assert.match(tasks, /route_probs: strong=0\.88/);
  assert.match(tasks, /route_ms: \d+/);
  assert.match(g.journalText(), /route mig → mock\/strong · lane strong confidence 0\.88 · sensitive \(policy: db\/migrations\/0031_rate_limit\.sql, p=0\.93\)/);
  assert.match(g.journalText(), /escalate.*escalated to the lead: confidence 0\.41 below 0\.7/);

  // the feedback loop: one scorecard line per executed task, with the gateway's own verify result
  const cards = g.scorecards();
  assert.equal(cards.length, 4, "an escalated task produced no crew result and so no scorecard");
  assert.deepEqual(cards.map((c) => [c.lane, c.verify_ok]).sort(), [["fast", true], ["local", true], ["strong", true], ["thinker", true]]);
  assert.ok(cards.every((c) => c.tags.length && typeof c.cost_usd === "number"));
});

test("an explicit model is never routed", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  double.setDecisions({ pinned: { lane: "local", confidence: 0.99 } });
  const before = double.requests.length;
  const r = await g.call("run_plan", {
    tasks: [
      { id: "pinned", task: "Document the limiter", model: "mock/thinker", verify: "node ok.mjs" },
      { id: "routed", task: "Add a unit test for the retry helper", files: ["a.test.ts"], verify: "node ok.mjs" },
    ],
    track: true,
  });
  const byId = new Map(r.meta().results.map((x) => [x.id, x]));
  assert.equal(byId.get("pinned").model, "mock/thinker");
  assert.equal(byId.get("pinned").route, undefined);
  assert.equal(byId.get("routed").model, LANE_MODEL.fast);
  const questions = Object.keys(double.requests.at(-1).questions);
  assert.equal(questions.some((q) => q.startsWith("pinned")), false, "a pinned task is not sent to the router");
  assert.equal(double.requests.length - before, 1);
});

test("a task Jev will not guess at is handed to the lead, not run", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  double.setDecisions({ escalate: LANES.escalate });
  const beforeCalls = mock.calls.length;
  const r = await g.call("run_plan", { tasks: [PLAN[4]], track: true });
  const meta = r.meta();
  assert.equal(meta.results[0].status, "escalated");
  assert.equal(meta.results[0].model, undefined);
  assert.match(meta.results[0].error, /routed to you: confidence 0\.41 below 0\.7 \(lanes strong=0\.34 fast=0\.31 thinker=0\.29\)/);
  assert.equal(mock.calls.length, beforeCalls, "no worker was started for an escalated task");
  assert.equal(r.text.includes("## Escalated to you"), true);
  const task = g.taskFiles().find((x) => x.includes("escalate"));
  assert.match(task, /owner: lead/);
  assert.match(task, /escalated to the lead: confidence 0\.41 below 0\.7/);
  assert.equal(g.scorecards().length, 0, "nothing ran, so nothing is recorded against a lane");
});

test("routing.engine off behaves exactly as before: every task on defaults.model", async (t) => {
  const g = await startGateway({ routing: { engine: "off" } });
  t.after(g.close);
  const before = double.requests.length;
  const r = await g.call("run_plan", { tasks: [PLAN[0], PLAN[1]], track: true });
  assert.equal(double.requests.length, before, "no routing call at all");
  assert.deepEqual(
    r.meta().results.map((x) => [x.model, x.route]),
    [["mock/good", undefined], ["mock/good", undefined]],
  );
  assert.equal(r.text.includes("## Routing"), false);
  assert.equal(/routed_by:/.test(g.taskFiles().join("\n")), false, "no routing provenance is invented");
});

test("the call parameter beats the config", async (t) => {
  const jevConfig = await startGateway();
  t.after(jevConfig.close);
  const off = await jevConfig.call("run_plan", { tasks: [PLAN[1]], routing: "off", track: true });
  assert.deepEqual(off.meta().results.map((x) => x.model), ["mock/good"]);
  assert.equal(off.meta().results[0].route, undefined);

  const plainConfig = await startGateway({ routing: { engine: "off" } });
  t.after(plainConfig.close);
  const rulesRun = await plainConfig.call("run_plan", { tasks: [PLAN[0], PLAN[1], PLAN[3]], routing: "rules", track: true });
  assert.deepEqual(
    rulesRun.meta().results.map((x) => [x.route.lane, x.route.engine]),
    [["local", "rules"], ["fast", "rules"], ["thinker", "rules"]],
  );
});

test("the route tool answers without running anything, and says when routing is off", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  double.setDecisions({ doc: { lane: "local", confidence: 0.95 }, q: { lane: "thinker", confidence: 0.8 } });
  const beforeCalls = mock.calls.length;
  const r = await g.call("route", { goal: "g", tasks: [{ id: "doc", task: "Document the limiter", files: ["README.md"] }, { id: "q", task: "Decide between two windows" }] });
  const body = r.json();
  assert.equal(body.answered_by, "jev");
  assert.equal(body.engine_source, "config");
  assert.deepEqual(body.decisions.map((d) => [d.id, d.lane, d.model]), [["doc", "local", "mock/local"], ["q", "thinker", "mock/thinker"]]);
  assert.equal(typeof body.decisions[0].lane_meaning, "string");
  assert.equal(body.escalated, 0);
  assert.equal(mock.calls.length, beforeCalls, "routing never starts a worker");

  const off = await startGateway({ routing: { engine: "off" } });
  t.after(off.close);
  const offBody = await off.call("route", { tasks: [{ id: "doc", task: "Document the limiter" }] });
  assert.deepEqual(offBody.json().decisions, []);
  assert.match(offBody.json().note, /routing is off/);
});

test("cost_report separates crew spend from routing spend and offers the all-strong replay", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  double.setDecisions({ doc: LANES.doc });
  await g.call("run_plan", { tasks: [PLAN[0]], track: true });
  const body = (await g.call("cost_report", { days: 1 })).json();
  const s = body.routing_savings;
  assert.equal(s.measured, true);
  assert.equal(s.priced_on, "mock/strong");
  assert.equal(typeof s.actual_crew_usd, "number");
  assert.equal(typeof s.all_strong_replay_usd, "number");
  assert.equal(typeof s.net_saved_usd, "number");
  assert.equal(typeof s.routing.usd, "number");
  assert.equal(s.routing.tasks, 1, "the routing call for that plan is counted");
  assert.equal(s.routing.escalations, 0);
  assert.match(s.assumption, /not a re-run/);
});

test("re-running a routed task with an explicit model records the override", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  double.setDecisions({ q: { lane: "thinker", confidence: 0.8 } });
  const first = await g.call("run_plan", { tasks: [PLAN[3]], track: true });
  const ledgerId = first.meta().results[0].ledger_id;
  assert.ok(ledgerId, "the plan task got a ledger id");
  assert.match(g.taskFiles().join("\n"), /route_lane: thinker/);
  // Picking a recorded task back up means addressing it by its ledger id — the documented way.
  await g.call("run_plan", { tasks: [{ ...PLAN[3], id: ledgerId, model: "mock/good" }], track: true });
  const task = g.taskFiles().find((x) => x.includes("Decide between"));
  assert.match(task, /overridden_by: mock\/good/);
  assert.match(task, /route_lane: thinker/, "the original route is kept alongside the override");
  assert.match(task, /lead overrode the thinker route with explicit model mock\/good/);
});
