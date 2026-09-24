/**
 * Routing engine: policy, rules, Jev, escalation and the ledger round-trip.
 *
 * Fully deterministic and offline: the only TypeSafe endpoint is the in-process mock, no test
 * asserts on wall-clock time or randomness, and every engine call passes an explicit engine.
 */
import test, { before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { Ledger } from "../dist/ledger.js";
import { JevError, estimateTokens, systemOne } from "../dist/jev.js";
import {
  BUILTIN_SENSITIVE_PATTERNS,
  DIFFICULTY_LEVELS,
  LANES,
  LANE_SPEC,
  buildQuestions,
  buildState,
  classifyWithRules,
  effectiveLaneMap,
  fileBucket,
  formatProbs,
  parseProbs,
  planRequests,
  resolveEngine,
  routePlanTasks,
  scorecardLines,
  sensitiveHits,
} from "../dist/routing.js";
import { resolveProvider } from "../dist/config.js";
import { startTypeSafeDouble } from "../dist/jev-double.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-route-"));
let mock;
let config;

function configWith(routing, extra = {}) {
  const file = path.join(tmp, `config-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ providers: { typesafe: { baseUrl: mock.url, apiKey: "test-key" } }, routing, ...extra }));
  return loadConfig({ workspaceRoot: tmp, configPath: file }).config;
}

const task = (id, over = {}) => ({ id, title: `task ${id}`, task: `do the thing for ${id}`, ...over });

before(async () => {
  mock = await startTypeSafeDouble();
});

after(async () => {
  await mock?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.BREAK_FREE_ROUTING;
  mock.setMode("ok");
  config = configWith({ engine: "jev", threshold: 0.7, retryDelayMs: 0, retries: 2 });
});

describe("engine selection", () => {
  test("an explicit call parameter beats the env var beats the config file", () => {
    assert.deepEqual(resolveEngine("off", "jev", "rules"), { engine: "jev", source: "call" });
    assert.deepEqual(resolveEngine("off", undefined, "rules"), { engine: "rules", source: "env" });
    assert.deepEqual(resolveEngine("off", undefined, undefined), { engine: "off", source: "config" });
    // a typo in the env var must not silently disable routing
    assert.deepEqual(resolveEngine("jev", undefined, "nonsense"), { engine: "jev", source: "config" });
  });

  test("routing is off unless someone turns it on", () => {
    const fresh = loadConfig({ workspaceRoot: tmp, configPath: path.join(tmp, "does-not-exist.json") }).config;
    assert.equal(fresh.routing.engine, "off");
  });
});

describe("policy rules run before any model", () => {
  test("built-in globs catch auth, secrets, env files and migrations", () => {
    for (const f of ["src/auth/session.ts", ".env.example", "config/secrets.json", "db/migrations/001_init.sql", "infra/prod/main.tf", "certs/server.pem"]) {
      assert.ok(sensitiveHits(config, [f]).includes(f), `${f} should be sensitive`);
    }
  });

  test("ordinary source files are not sensitive", () => {
    assert.deepEqual(sensitiveHits(config, ["src/router.ts", "docs/usage.md", "test/gateway.test.mjs"]), []);
  });

  test("the user's own config and policy globs are honoured, deduplicated and sorted", () => {
    const c = configWith({ engine: "rules", sensitivePaths: ["**/ledger.ts"] }, { policy: { rules: [{ match: "**/node_modules/**", action: "deny" }] } });
    const hits = sensitiveHits(c, ["src/ledger.ts", "node_modules/x/y.js", "src/ledger.ts", "src/router.ts"]);
    assert.deepEqual(hits, ["node_modules/x/y.js", "src/ledger.ts"]);
  });

  test("a sensitive task is raised to strong and gets a review, whatever Jev proposed", async () => {
    mock.setDecisions({ auth: { lane: "fast", confidence: 0.99 } });
    const r = await routePlanTasks(config, [task("auth", { files: ["src/auth/session.ts"] })], { engine: "jev" });
    const d = r.decisions[0];
    assert.equal(d.lane, "strong");
    assert.equal(d.model, "strong");
    assert.equal(d.proposed_lane, "fast", "what the model wanted is still recorded");
    assert.equal(d.reason, "policy");
    assert.equal(d.requires_review, true, "raising the lane without a review is not a guardrail");
    assert.deepEqual(d.policy_hits, ["src/auth/session.ts"]);
    assert.equal(r.policy_hits, 1);
  });

  test("the sensitivity floor never lowers a lane the model got right", async () => {
    mock.setDecisions({ t1: { lane: "thinker", confidence: 0.9 }, t2: { lane: "local", confidence: 0.9 } });
    const r = await routePlanTasks(config, [task("t1", { files: ["src/auth/a.ts"] }), task("t2", { files: ["src/auth/b.ts"] })], { engine: "jev" });
    assert.equal(r.decisions[0].lane, "thinker", "a stronger lane is not downgraded to strong");
    assert.equal(r.decisions[1].lane, "local", "local is already the egress-safe place for the data");
    assert.equal(r.decisions[0].requires_review, true);
    assert.equal(r.decisions[1].requires_review, true);
  });

  test("routing.sensitiveLane 'local' is data residency: absolute, never remote", async () => {
    const c = configWith({ engine: "rules", sensitiveLane: "local" });
    const r = await routePlanTasks(c, [task("auth", { files: ["src/auth/session.ts"] }), task("sec", { files: [".env.example"] })], { engine: "rules" });
    assert.deepEqual(
      r.decisions.map((d) => [d.lane, d.model, d.requires_review]),
      [
        ["local", "local", true],
        ["local", "local", true],
      ],
    );
  });

  test("Jev's own sensitivity answer raises the lane when policy did not fire", async () => {
    mock.setDecisions({ t1: { lane: "fast", confidence: 0.95, sensitive: 0.93 } });
    const r = await routePlanTasks(config, [task("t1")], { engine: "jev" });
    assert.equal(r.decisions[0].lane, "strong");
    assert.equal(r.decisions[0].sensitive, true);
    assert.equal(r.decisions[0].sensitive_prob, 0.93);
    assert.equal(r.decisions[0].reason, "sensitive");
    assert.equal(r.decisions[0].requires_review, true);
  });

  test("a low sensitivity probability does not divert the lane", async () => {
    mock.setDecisions({ t1: { lane: "fast", confidence: 0.95, sensitive: 0.1 } });
    const r = await routePlanTasks(config, [task("t1")], { engine: "jev" });
    assert.equal(r.decisions[0].lane, "fast");
    assert.equal(r.decisions[0].sensitive, false);
    assert.equal(r.decisions[0].requires_review, false);
  });
});

describe("turning Jev on and off at session, project and global level", () => {
  /** A workspace with its own committed `.model-gateway.json`, and a separate user config. */
  function level(project, user = {}) {
    const ws = fs.mkdtempSync(path.join(tmp, "ws-"));
    if (Object.keys(project).length) fs.writeFileSync(path.join(ws, ".model-gateway.json"), JSON.stringify(project));
    const userFile = path.join(ws, "user.json");
    fs.writeFileSync(userFile, JSON.stringify(user));
    return loadConfig({ workspaceRoot: ws, configPath: userFile }).config;
  }

  test("global: the user config sets the engine for every repo", () => {
    assert.equal(level({}, { routing: { engine: "jev" } }).routing.engine, "jev");
    assert.equal(level({}, { routing: { engine: "rules" } }).routing.engine, "rules");
    assert.equal(level({}).routing.engine, "off", "and the default is off");
  });

  test("project: a repo can turn Jev on for itself, and it beats the global setting", () => {
    const c = level({ routing: { engine: "jev", threshold: 0.8 } }, { routing: { engine: "rules" } });
    assert.equal(c.routing.engine, "jev");
    assert.equal(c.routing.threshold, 0.8);
  });

  test("project: the user can veto it with projectMayEnableJev: false", () => {
    const c = level({ routing: { engine: "jev" } }, { routing: { engine: "rules", projectMayEnableJev: false } });
    assert.equal(c.routing.engine, "rules", "the repo's Jev request is dropped, the user's engine stands");
    // a repo may still opt itself down, or into the offline engine
    assert.equal(level({ routing: { engine: "off" } }, { routing: { engine: "jev" } }).routing.engine, "off");
    assert.equal(level({ routing: { engine: "rules" } }, { routing: { engine: "jev", projectMayEnableJev: false } }).routing.engine, "rules");
  });

  test("project: a repo cannot lift the user's restriction itself", () => {
    const c = level({ routing: { engine: "jev", projectMayEnableJev: true } }, { routing: { projectMayEnableJev: false } });
    assert.equal(c.routing.engine, "off", "the flag is read from the user config only");
    assert.notEqual(c.routing.projectMayEnableJev, true);
  });

  test("session: the call parameter and the env var beat both files", () => {
    const c = level({ routing: { engine: "jev" } }, { routing: { engine: "jev" } });
    assert.deepEqual(resolveEngine(c.routing.engine, "off", undefined), { engine: "off", source: "call" });
    assert.deepEqual(resolveEngine(c.routing.engine, undefined, "rules"), { engine: "rules", source: "env" });
    assert.deepEqual(resolveEngine(c.routing.engine, "off", "rules"), { engine: "off", source: "call" }, "the call wins over the env var");
    assert.deepEqual(resolveEngine(c.routing.engine, undefined, undefined), { engine: "jev", source: "config" });
  });

  test("engine off means no routing work at all, at every level", async () => {
    const off = level({ routing: { engine: "off" } });
    const before = mock.requests.length;
    const r = await routePlanTasks(off, [task("a"), task("b")], { engine: "off" });
    assert.deepEqual(r.decisions, []);
    assert.equal(mock.requests.length, before);
    assert.equal(r.engine, "off");
  });
});

describe("the rules engine is deterministic and needs no key", () => {
  const cases = [
    ["Update the README and CHANGELOG", "fast"],
    ["Rename getUser to fetchUser everywhere", "fast"],
    ["Add a database migration for the new column", "strong"],
    ["Design the storage layer and decide between two approaches", "thinker"],
    ["Sweep the whole repository converting the deprecated API", "codex_handoff"],
    ["Refactor the task graph under the orchestrator", "strong"],
    ["Investigate why the scheduler test is flaky", "thinker"],
    ["Add a unit test for the retry helper", "fast"],
    ["As discussed, do the thing later", "unclear"],
    ["Write the quarterly summary", "fast"],
  ];
  for (const [text, lane] of cases) {
    test(`"${text}" routes to ${lane}`, () => {
      assert.equal(classifyWithRules({ id: "x", task: text }).lane, lane);
    });
  }

  test("prose is recognised by its files, not by a keyword", () => {
    // every file is prose => local, however the text reads
    assert.deepEqual(classifyWithRules({ id: "x", task: "Document the limiter", files: ["README.md", "CHANGELOG.md"] }).lane, "local");
    // mentioning docs does not make a code task prose: a keyword cannot prove exclusivity
    assert.equal(classifyWithRules({ id: "x", task: "Add a database migration and update the docs", files: ["db/migrations/0031_x.sql"] }).lane, "strong");
  });

  test("the same input always classifies the same way", () => {
    const t = { id: "x", task: "Add a database migration", files: ["a.ts", "b.ts"] };
    assert.deepEqual(classifyWithRules(t), classifyWithRules(t));
  });

  test("a plan with no key completes on rules and says why it degraded", async () => {
    // "No key" has to be true, not assumed. The installer runs this suite on the user's own
    // machine, where TYPESAFE_API_KEY is often set - and with it set, this test made a live, paid
    // call to api.typesafe.ai and failed on whatever came back.
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
    const noKey = loadConfig({ workspaceRoot: tmp, configPath: path.join(tmp, "empty-config.json") }).config;
    const r = await routePlanTasks(noKey, [task("a", { task: "Update the README", files: ["README.md"] }), task("b", { task: "Add a migration", files: ["db/migrations/1.sql"] })], { engine: "jev" });
    assert.equal(r.engine, "jev", "the requested engine is still reported");
    assert.equal(r.answered_by, "rules");
    assert.match(r.degraded, /no API key/);
    assert.deepEqual(
      r.decisions.map((d) => d.lane),
      ["local", "strong"],
    );
    assert.equal(r.decisions[0].model, "local");
    } finally {
      if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved;
    }
  });

  test("six or more files raise difficulty and set the repo-context flag", async () => {
    const many = Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`);
    assert.equal(fileBucket(many), "6+");
    const r = await routePlanTasks(config, [task("big", { task: "Write the quarterly summary", files: many })], { engine: "rules" });
    assert.equal(r.decisions[0].difficulty >= 3, true);
    assert.equal(r.decisions[0].needs_repo_context, true);
  });
});

describe("escalation: routing refuses to guess", () => {
  test("a flat distribution below the threshold goes back to the lead with the probabilities intact", async () => {
    mock.setDecisions({ flaky: { lane: "fast", confidence: 0.41, probs: { fast: 0.31, strong: 0.34, thinker: 0.29, local: 0.06 } } });
    const r = await routePlanTasks(config, [task("flaky")], { engine: "jev" });
    const d = r.decisions[0];
    assert.equal(d.escalated, true);
    assert.equal(d.lane, "lead_keeps");
    assert.equal(d.model, null);
    assert.equal(d.proposed_lane, "fast");
    assert.equal(d.reason, "confidence");
    assert.equal(d.confidence, 0.41);
    assert.equal(d.probabilities.strong, 0.34);
    assert.equal(r.escalated, 1);
  });

  test("a confident answer is not escalated", async () => {
    mock.setDecisions({ ok1: { lane: "fast", confidence: 0.94 } });
    const r = await routePlanTasks(config, [task("ok1")], { engine: "jev" });
    assert.equal(r.decisions[0].escalated, false);
    assert.equal(r.decisions[0].model, "fast");
  });

  test("the threshold is configurable, and can be tightened", async () => {
    mock.setDecisions({ mid: { lane: "fast", confidence: 0.8 } });
    const strict = configWith({ engine: "jev", threshold: 0.85 });
    assert.equal((await routePlanTasks(strict, [task("mid")], { engine: "jev" })).decisions[0].escalated, true);
    assert.equal((await routePlanTasks(config, [task("mid")], { engine: "jev" })).decisions[0].escalated, false);
  });

  test("the unclear lane and an unmapped lane both escalate", async () => {
    mock.setDecisions({ u: { lane: "unclear", confidence: 0.95 }, l: { lane: "lead_keeps", confidence: 0.99 } });
    const r = await routePlanTasks(config, [task("u"), task("l")], { engine: "jev" });
    assert.deepEqual(
      r.decisions.map((d) => [d.lane, d.reason, d.model]),
      [
        ["lead_keeps", "unclear", null],
        ["lead_keeps", "lead_keeps", null],
      ],
    );
  });

  test("laneMap can re-point a lane or send it back to the lead", async () => {
    const c = configWith({ engine: "jev", threshold: 0.5, laneMap: { fast: "kimi/kimi-k3", local: null } });
    mock.setDecisions({ a: { lane: "fast", confidence: 0.9 }, b: { lane: "local", confidence: 0.9 } });
    const r = await routePlanTasks(c, [task("a"), task("b")], { engine: "jev" });
    assert.equal(r.decisions[0].model, "kimi/kimi-k3");
    assert.equal(r.decisions[1].model, null);
    assert.equal(r.decisions[1].escalated, true);
  });
});

describe("the TypeSafe client", () => {
  test("a whole plan is routed in ONE request, with four typed questions per task", async () => {
    const before = mock.requests.length;
    mock.setDecisions({ a: { lane: "fast", confidence: 0.9, difficulty: 1 }, b: { lane: "strong", confidence: 0.85, difficulty: 3 } });
    const r = await routePlanTasks(config, [task("a"), task("b")], { engine: "jev" });
    assert.equal(r.batch, "plan");
    assert.equal(mock.requests.length - before, 1, "one round trip for the whole plan");
    const sent = mock.requests.at(-1);
    assert.deepEqual(Object.keys(sent.questions).sort(), ["a__difficulty", "a__lane", "a__needs_repo_context", "a__sensitive", "b__difficulty", "b__lane", "b__needs_repo_context", "b__sensitive"]);
    assert.equal(sent.questions.a__lane.type, "choice");
    assert.equal(sent.questions.a__difficulty.type, "score");
    assert.equal(sent.questions.a__sensitive.type, "noul");
    // every lane is offered, with the structured what/not_for/examples criteria the docs recommend
    assert.deepEqual(Object.keys(sent.questions.a__lane.criteria).sort(), [...LANES].sort());
    assert.deepEqual(Object.keys(sent.questions.a__lane.criteria.fast).sort(), ["examples", "not_for", "what"]);
    assert.equal(sent.questions.a__difficulty.criteria.length, DIFFICULTY_LEVELS.length);
    assert.equal(r.decisions[0].difficulty, 1);
    assert.equal(r.decisions[1].difficulty, 3);
  });

  test("the state carries the plan but never raw code, and pre-buckets file counts", async () => {
    await routePlanTasks(config, [task("a", { files: ["src/one.ts", "src/two.ts"], tags: ["api"] })], { engine: "jev" });
    const sent = mock.requests.at(-1);
    const entry = sent.state.tasks[0];
    assert.equal(entry.files_touched, "2-5", "Jev cannot count reliably, so code buckets it");
    assert.deepEqual(entry.tags, ["api"]);
    assert.match(sent.state.note, /bucketed in code/);
    assert.equal(JSON.stringify(sent.state).includes("function "), false, "no raw source in the state");
  });

  test("batch:'task' sends one request per task and agrees with batch:'plan'", async () => {
    mock.setDecisions({ a: { lane: "fast", confidence: 0.9 }, b: { lane: "strong", confidence: 0.9 } });
    const perTask = configWith({ engine: "jev", threshold: 0.7, batch: "task", retryDelayMs: 0, retries: 0 });
    const before = mock.requests.length;
    const r = await routePlanTasks(perTask, [task("a"), task("b")], { engine: "jev" });
    assert.equal(r.batch, "task");
    assert.equal(mock.requests.length - before, 2);
    assert.deepEqual(
      r.decisions.map((d) => d.lane),
      ["fast", "strong"],
    );
  });

  test("429 and 529 are retried with backoff, then succeed", async () => {
    const provider = resolveProvider(config, "typesafe");
    mock.queueFailures(1);
    const r = await systemOne(config, provider, { state: "x", model: "jev-latest", questions: { "a__lane": { type: "choice", instructions: "?", criteria: { fast: "f", local: "l" } } } }, { retries: 2, retryDelayMs: 0 });
    assert.equal(r.attempts, 2);
    mock.setMode("server_error");
    await assert.rejects(() => systemOne(config, provider, { state: "x", model: "jev-latest", questions: {} }, { retries: 1, retryDelayMs: 0 }), (e) => e instanceof JevError && e.status === 529);
  });

  test("a 401 is not retried and degrades the plan to rules", async () => {
    mock.setMode("unauthorized");
    const before = mock.requests.length;
    const r = await routePlanTasks(config, [task("a", { task: "Document the limiter", files: ["README.md"] })], { engine: "jev" });
    assert.equal(r.answered_by, "rules");
    assert.match(r.degraded, /401/);
    assert.equal(r.decisions[0].lane, "local");
    assert.equal(mock.requests.length - before, 1, "a bad key must not be retried");
  });

  test("a malformed body degrades to rules instead of failing the plan", async () => {
    mock.setMode("malformed");
    const r = await routePlanTasks(config, [task("a", { task: "Add a migration" })], { engine: "jev" });
    assert.equal(r.answered_by, "rules");
    assert.match(r.degraded, /answers/);
    assert.equal(r.decisions[0].lane, "strong");
  });

  test("usage is priced at $0.042 per million input tokens, output free", async () => {
    const provider = resolveProvider(config, "typesafe");
    const r = await systemOne(config, provider, { state: "x".repeat(400), model: "jev-latest", questions: { "a__lane": { type: "choice", instructions: "?", criteria: { fast: "f" } } } }, { retries: 0 });
    assert.equal(r.priced, true);
    assert.equal(r.costUsd, Math.round(((r.usage.input_tokens * 0.042) / 1_000_000) * 1e6) / 1e6);
    assert.equal(r.usage.output_tokens, 0);
    assert.ok(r.usage.input_tokens > 0);
  });

  test("a plan too big for one request is split, and each chunk fits", async () => {
    // 60 tasks x 4 questions does not fit one context: the lane question alone carries seven
    // option rubrics. The live API answers 400 max_tokens_exceeded rather than trimming.
    const many = Array.from({ length: 60 }, (_, i) => task(`t${i}`, { task: `Do the thing for t${i}`, files: ["src/a.ts"] }));
    const tight = configWith({ engine: "jev", threshold: 0.7, retryDelayMs: 0, retries: 0, maxRequestTokens: 8000 });
    const requests = planRequests(tight, "goal", many, []);
    assert.ok(requests.length > 1, `expected several requests, got ${requests.length}`);
    assert.equal(requests.flat().length, 60, "no task is dropped by chunking");
    assert.deepEqual(requests.flat().map((t) => t.id), many.map((t) => t.id), "order is preserved");
    for (const chunk of requests) {
      const total = estimateTokens(buildState(tight, "goal", chunk, []).state) + estimateTokens(buildQuestions(chunk));
      assert.ok(total <= 8000, `chunk of ${chunk.length} is ${total} tokens`);
    }
    // a plan that fits is still exactly one request
    const roomy = configWith({ engine: "jev", maxRequestTokens: 100_000 });
    assert.equal(planRequests(roomy, "goal", many, []).length, 1);
  });

  test("chunking routes every task and reports how many requests it took", async () => {
    mock.setDecisions({ a: { lane: "fast", confidence: 0.9 }, b: { lane: "strong", confidence: 0.9 }, c: { lane: "local", confidence: 0.9 } });
    const tight = configWith({ engine: "jev", threshold: 0.7, retryDelayMs: 0, retries: 0, maxRequestTokens: 900 });
    const before = mock.requests.length;
    const r = await routePlanTasks(tight, [task("a"), task("b"), task("c")], { engine: "jev" });
    assert.ok(r.requests > 1, `expected a split, got ${r.requests}`);
    assert.equal(mock.requests.length - before, r.requests);
    assert.deepEqual(
      r.decisions.map((d) => [d.id, d.lane]),
      [
        ["a", "fast"],
        ["b", "strong"],
        ["c", "local"],
      ],
    );
  });

  test("the state is capped and trimmed in a fixed order, never dropping a task", async () => {
    const long = "x".repeat(6000);
    const tasks = [task("a", { task: long, acceptance: long, verify: "npm test", files: ["a.ts"] }), task("b", { task: long })];
    const small = configWith({ engine: "rules", maxStateTokens: 400 });
    const { state, tokens, truncated } = buildState(small, "goal", tasks, []);
    assert.equal(truncated, true);
    assert.ok(tokens <= 400, `expected <=400 tokens, got ${tokens}`);
    assert.equal(state.tasks.length, 2, "trimming must never drop a task");
    // deterministic: same input, same bytes
    assert.deepEqual(buildState(small, "goal", tasks, []).state, state);
    // under budget: nothing is touched
    const roomy = configWith({ engine: "rules", maxStateTokens: 100_000 });
    assert.equal(buildState(roomy, "goal", tasks, []).truncated, false);
    assert.equal(estimateTokens(buildState(roomy, "goal", tasks, []).state) > 0, true);
  });
});

describe("ledger: routing provenance and scorecards", () => {
  test("routing provenance survives a write/read round trip", () => {
    const ledger = new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), "bf-led-")));
    const t = ledger.createTask({
      title: "Add a migration",
      tags: ["migration"],
      routing: { routed_by: "jev", route_lane: "strong", route_confidence: 0.87, route_probs: "strong=0.87 fast=0.09", route_ms: 412 },
    });
    const back = ledger.getTask(t.id);
    assert.equal(back.routed_by, "jev");
    assert.equal(back.route_lane, "strong");
    assert.equal(back.route_confidence, 0.87);
    assert.equal(back.route_probs, "strong=0.87 fast=0.09");
    assert.equal(back.route_ms, 412);
    assert.equal(back.overridden_by, undefined);
    assert.deepEqual(parseProbs(back.route_probs), { strong: 0.87, fast: 0.09 });
    // a task with no routing stays free of empty keys
    assert.equal(ledger.createTask({ title: "plain" }).route_lane, undefined);
  });

  test("an override is recorded without losing the original route", () => {
    const ledger = new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), "bf-led-")));
    const t = ledger.createTask({ title: "x", routing: { routed_by: "rules", route_lane: "fast" } });
    ledger.updateTask(t.id, { overridden_by: "deepseek/deepseek-v4-pro" });
    const back = ledger.getTask(t.id);
    assert.equal(back.overridden_by, "deepseek/deepseek-v4-pro");
    assert.equal(back.route_lane, "fast");
  });

  test("scorecards aggregate pass rates per lane and skip malformed lines", () => {
    const ledger = new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), "bf-led-")));
    const rec = (lane, ok) => ledger.scorecardAppend({ task: "T-001", lane, model: `m/${lane}`, tags: ["migration"], verify_ok: ok, attempts: 1, ms: 10, cost_usd: 0.001, at: "2026-09-19T00:00:00.000Z" });
    rec("fast", false);
    rec("fast", false);
    rec("strong", true);
    fs.appendFileSync(path.join(ledger.dir, "scorecards.jsonl"), "{not json\n");
    const lines = scorecardLines(ledger.scorecards(), ["migration"], 3);
    assert.deepEqual(lines, ["migration: fast 0/2 verify pass, strong 1/1"]);
  });

  test("scorecard lines need a real signal: one record, or records with no verify, are ignored", () => {
    const base = { plan: undefined, model: "m", attempts: 1, ms: 1, cost_usd: 0, at: "" };
    assert.deepEqual(scorecardLines([{ ...base, task: "a", lane: "fast", tags: ["x"], verify_ok: true }], ["x"], 3), []);
    assert.deepEqual(scorecardLines([{ ...base, task: "a", lane: "fast", tags: ["x"], verify_ok: null }, { ...base, task: "b", lane: "fast", tags: ["x"], verify_ok: null }], ["x"], 3), []);
    assert.deepEqual(scorecardLines([{ ...base, task: "a", lane: "fast", tags: ["x"], verify_ok: true }, { ...base, task: "b", lane: "fast", tags: ["x"], verify_ok: false }], [], 3), []);
  });

  test("the journal records one line per decision and the task carries the lane", () => {
    const ledger = new Ledger(fs.mkdtempSync(path.join(os.tmpdir(), "bf-led-")));
    ledger.journal("route auth → local · lane local confidence 0.93 · sensitive (policy: src/auth/session.ts) · by policy in 380ms");
    const lines = Ledger.journalIn(ledger.dir)[0].lines;
    assert.equal(lines.length, 1);
    assert.match(lines[0], /route auth → local · lane local confidence 0\.93/);
  });
});

describe("frontmatter-safe encodings", () => {
  test("probabilities round-trip and stay scalar", () => {
    const s = formatProbs({ fast: 0.8333, strong: 0.11, local: 0.0567, thinker: 0.0001 });
    assert.equal(s, "fast=0.83 strong=0.11 local=0.06");
    assert.deepEqual(parseProbs(s), { fast: 0.83, strong: 0.11, local: 0.06 });
    // the ledger's frontmatter writer must not need to quote or escape it
    for (const ch of ['"', ":", "{", "}", "[", "]", ","]) assert.equal(s.includes(ch), false);
    assert.equal(parseProbs(undefined), null);
    assert.equal(parseProbs("garbage"), null);
  });

  test("the lane map defaults are complete and every lane is described", () => {
    const map = effectiveLaneMap(config);
    for (const lane of LANES) assert.ok(lane in map, `${lane} missing from laneMap`);
    for (const lane of LANES) {
      assert.ok(LANE_SPEC[lane].what.length > 20);
      assert.ok(LANE_SPEC[lane].not_for.length > 10);
      assert.ok(LANE_SPEC[lane].examples.length > 10);
    }
    assert.equal(map.lead_keeps, null);
    assert.equal(map.unclear, null);
    assert.equal(BUILTIN_SENSITIVE_PATTERNS.length >= 10, true);
  });
});

describe("questions are the constants a human reviews", () => {
  test("every question names the subtask it is about, by its path in the state", () => {
    // TypeSafe does not send the question key to the model, so the instruction IS the only thing
    // identifying which of the plan's tasks is being judged. Without this, "this subtask" is
    // ambiguous across a plan and every answer describes the plan as a whole.
    const qs = buildQuestions([task("core"), task("docs", { title: "Update the README" })]);
    for (const [key, q] of Object.entries(qs)) {
      const i = key.split("__")[0] === "core" ? 0 : 1;
      assert.match(q.instructions, new RegExp(`ONLY the subtask at state\\.tasks\\[${i}\\]`), `${key} must point at its slot`);
      assert.match(q.instructions, /Ignore every other subtask/);
    }
    assert.match(qs.docs__lane.instructions, /id `docs`, titled "Update the README"/);
  });

  test("every question states one thing, literally", () => {
    const qs = buildQuestions([task("a")]);
    assert.match(qs.a__lane.instructions, /cheaper one/);
    assert.match(qs.a__lane.instructions, /unclear/);
    assert.match(qs.a__sensitive.instructions, /migration/);
    assert.equal(qs.a__sensitive.criteria.true.length > 0, true);
    assert.equal(qs.a__sensitive.criteria.false.length > 0, true);
  });
});
