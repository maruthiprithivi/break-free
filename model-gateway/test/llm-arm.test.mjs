// The frontier-LLM-as-router baseline (criterion 11): its parsing, and the fact that it is given the
// same lane definitions Jev is. Offline against the mock provider — no key, no API calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockProvider } from "./mock-provider.mjs";
import { costUsd, loadConfig, priceFor } from "../dist/config.js";
import { llmRouterArm, llmRouterMessages, parseLlmRouting, scoreArm, LLM_ROUTER_CHUNK } from "../dist/bench.js";

const set = [
  { id: "t1", title: "docs", task: "Rewrite the README install section.", files: ["README.md"], file_bucket: "1", tags: ["docs"], lead_lane: "local", cheapest_passing_lane: "local", difficulty: 1, sensitive: false, needs_repo_context: false },
  { id: "t2", title: "test", task: "Add a regression test for the retry counter.", files: ["test/q.test.ts"], file_bucket: "1", tags: ["test"], lead_lane: "fast", cheapest_passing_lane: "fast", difficulty: 2, sensitive: false, needs_repo_context: false },
  { id: "t3", title: "migration", task: "Add a NOT NULL column with a backfill.", files: ["db/migrations/001.sql"], file_bucket: "2-5", tags: ["migration"], lead_lane: "strong", cheapest_passing_lane: "strong", difficulty: 3, sensitive: true, needs_repo_context: true },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-llm-"));

async function configFor(mockUrl, model = "router", provider = "gemini") {
  const file = path.join(tmp, `config-${provider}.json`);
  fs.writeFileSync(file, JSON.stringify({ providers: { [provider]: { baseUrl: mockUrl, apiKey: "test-key", defaultModel: model } }, defaults: { model: "fast" } }));
  return loadConfig({ configPath: file }).config;
}

test("parseLlmRouting survives what chat models actually return", () => {
  const ids = ["t1", "t2"];
  // fenced, with prose around it — the common shape
  const fenced = parseLlmRouting('Here you go:\n```json\n[{"id":"t1","lane":"fast"},{"id":"t2","lane":"strong"}]\n```', ids);
  assert.deepEqual([...fenced.lanes], [["t1", "fast"], ["t2", "strong"]]);
  assert.deepEqual(fenced.bad, []);
  // a different key name for the task id
  assert.equal(parseLlmRouting('[{"task_id":"t1","model":"local"}]', ids).lanes.get("t1"), "local");
  // an invented lane is not accepted
  const invented = parseLlmRouting('[{"id":"t1","lane":"super-fast"}]', ids);
  assert.equal(invented.lanes.has("t1"), false);
  assert.match(invented.bad.join("; "), /not a lane/);
  // a task the model forgot is reported, not silently dropped
  assert.match(parseLlmRouting('[{"id":"t1","lane":"fast"}]', ids).bad.join("; "), /t2: no lane returned/);
  // and a reply that is not JSON at all
  assert.match(parseLlmRouting("I think fast is right.", ids).bad.join("; "), /no JSON array/);
});

test("the arm is handed the same lane definitions Jev gets", async () => {
  // Fairness is the whole point of a baseline: a win from better prompt wording would measure nothing.
  const { config } = { config: await configFor("http://127.0.0.1:1/v1") };
  const { system, user } = llmRouterMessages(config, set);
  for (const lane of ["local", "fast", "strong", "thinker", "codex_handoff", "lead_keeps", "unclear"]) {
    assert.ok(system.includes(lane), `the prompt should define the ${lane} lane`);
  }
  assert.match(system, /NOT for:/);
  assert.match(system, /JSON array and nothing else/);
  const state = JSON.parse(user);
  assert.deepEqual(state.tasks.map((t) => t.id), ["t1", "t2", "t3"]);
});

test("the arm routes through the real client and scores like the others", async () => {
  const mock = await startMockProvider();
  const config = await configFor(`http://127.0.0.1:${mock.port}/v1`);
  try {
    const { arm, stats } = await llmRouterArm(config, set, { spec: "gemini" });
    assert.equal(arm.measured, true);
    assert.equal(stats.model, "router");
    assert.equal(stats.chunks, 1);
    assert.deepEqual(stats.failures, []);
    // the mock alternates local/strong, so half the set agrees exactly
    assert.deepEqual([...arm.outcomes].map(([id, o]) => `${id}:${o.lane}`), ["t1:local", "t2:strong", "t3:local"]);
    const m = scoreArm(config, set, arm);
    assert.equal(m.measured, true);
    // Scored against the EXPERT label (lead_lane), not against the arm's own opinion: only t1 agrees.
    assert.equal(m.agreement_exact_pct, 33.33);
    // ...and against the cheapest lane that passes, which is what the guardrail is about: the mock
    // sent the migration to `local` (under-routed) and the test to `strong` (over-routed).
    assert.equal(m.under_routing_pct, 33.33);
    assert.equal(m.over_routing_pct, 33.33);
    assert.ok(m.ms_total >= 0);
    assert.ok(m.cost_usd > 0, "a priced provider reports what the call cost");
  } finally {
    await mock.close();
  }
});

test("a provider with no price entry is reported UNPRICED rather than free", async () => {
  // Every catalog provider has a price entry, so this is the real unpriced case: a custom endpoint a
  // user added themselves. Reporting it as $0 would flatter it — and for the LLM arm specifically it
  // would flatter the baseline Jev is being compared against.
  const mock = await startMockProvider();
  const config = await configFor(`http://127.0.0.1:${mock.port}/v1`, "router", "mybox");
  try {
    const { arm, stats } = await llmRouterArm(config, set, { spec: "mybox" });
    assert.equal(arm.measured, true);
    assert.equal(stats.priced, false);
    assert.equal(arm.cost_usd, 0);
    assert.match(arm.note ?? "", /UNPRICED/);
  } finally {
    await mock.close();
  }
});

test("thinking tokens a provider hides from completion_tokens are still billed", async () => {
  // Google's shim reports the VISIBLE answer in completion_tokens while billing thinking as output:
  // one real request came back completion_tokens 2 with total_tokens 600 for a one-word answer.
  // Under-billing that would flatter break-free's own router against the baseline it is compared to,
  // so output is billed as max(completion, total - prompt). A provider whose fields agree is unchanged.
  const config = await configFor("http://127.0.0.1:1/v1");
  const hidden = costUsd(config, "gemini", "gemini-3.1-pro-preview", { prompt_tokens: 1000, completion_tokens: 2, total_tokens: 6002 });
  assert.equal(hidden.output_tokens, 5002);
  assert.equal(hidden.usd, Math.round(((1000 * 2 + 5002 * 12) / 1e6) * 1e6) / 1e6);
  const normal = costUsd(config, "deepseek", "deepseek-v4-flash", { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
  assert.equal(normal.output_tokens, 500, "a provider that reports both fields honestly is unchanged");
  assert.equal(costUsd(config, "deepseek", "deepseek-v4-flash", { prompt_tokens: 1000, completion_tokens: 500 }).output_tokens, 500, "no total reported: fall back to completion");
});

test("Gemini's published rates are in the price table", async () => {
  // The arm's cost column is only honest if the model it uses is priced. Fetched from
  // ai.google.dev/gemini-api/docs/pricing; output includes thinking tokens.
  const config = await configFor("http://127.0.0.1:1/v1");
  assert.deepEqual(priceFor(config, "gemini", "gemini-3.1-pro-preview"), { input: 2, output: 12, priced: true });
  assert.deepEqual(priceFor(config, "gemini", "gemini-3.5-flash"), { input: 1.5, output: 9, priced: true });
});

test("a chunk the model cannot answer is escalated, never guessed at", async () => {
  const mock = await startMockProvider();
  const config = await configFor(`http://127.0.0.1:${mock.port}/v1`, "boom500");
  try {
    const { arm, stats } = await llmRouterArm(config, set, { spec: "gemini" });
    assert.equal(arm.measured, true, "the arm ran; it just got nothing back");
    assert.equal(stats.failures.length, 1);
    assert.deepEqual([...arm.outcomes.values()].map((o) => o.lane), ["unclear", "unclear", "unclear"]);
    assert.ok([...arm.outcomes.values()].every((o) => o.escalated), "unanswered tasks go to the lead");
  } finally {
    await mock.close();
  }
});

test("the chunk size matches the plan the bench reports latency for", () => {
  assert.equal(LLM_ROUTER_CHUNK, 12);
});
