// Issue #26: a model with no entry in the price table logs `cost_usd: 0`, and a live accounting
// report built on that zero flatters itself — `routing_savings` compares actual crew spend against
// the same usage replayed at `strong`, so a cheap arm that is $0 by table gap rather than by real
// saving reports a saving inflated towards 100%. These tests run the real MCP server over stdio
// against the mock provider, so what is under test is the report an operator actually reads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockProvider } from "./mock-provider.mjs";
import { loadConfig, priceFor, costUsd } from "../dist/config.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");
const UNPRICED = "mock/unpriced-model";

let mock;

before(async () => {
  mock = await startMockProvider();
});

after(async () => {
  await mock?.close();
});

/**
 * One gateway per test: the server reads its config once at startup, so a shared instance would
 * leak both config and log between tests.
 */
async function startGateway(over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-pricing-"));
  let ws = path.join(tmp, "repo");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  ws = fs.realpathSync(ws);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: ws });
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    sessionDir: path.join(tmp, "sessions"),
    logFile: path.join(tmp, "gateway.log"),
    defaults: { model: "fast", reviewer: "mock/strong", supervisor: "mock/strong", timeoutMs: 8000, maxToolIterations: 1 },
    fallback: { chain: [], retriesPerCandidate: 0, retryDelayMs: 0 },
    providers: { mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" } },
    // The cheap arm is a model the table does not know while `strong` is priced: the exact shape of
    // the live case, where a user alias pointed at a model with no entry and the whole arm read $0.
    aliases: { fast: [UNPRICED], strong: ["mock/strong"] },
    pricing: { "mock/strong": { input: 100, output: 100 } },
    ...over,
  }));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", configPath], env: { ...process.env }, stderr: "pipe" }));
  return {
    ws,
    configPath,
    call: async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content.map((c) => c.text).join("\n");
      return { text, isError: !!r.isError, json: () => JSON.parse(text), meta: () => JSON.parse(text.slice(text.lastIndexOf("\nmeta: ") + 7)) };
    },
    close: () => client.close(),
  };
}

test("an unpriced arm is surfaced as unpriced, and cannot carry a saving", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const d = await g.call("delegate", { task: "Say OK and nothing else.", model: "fast" });
  assert.equal(d.meta().cost_usd, 0, "an unpriced call bills $0 — the number the report must not trust");
  assert.equal(d.meta().unpriced, true, "the worker meta already flags it");

  const rep = (await g.call("cost_report", { days: 1 })).json();
  // The zero is attributed to a named spec instead of quietly summing into a total...
  assert.equal(rep.unpriced_calls, 1);
  assert.equal(rep.unpriced.by_spec[UNPRICED], 1);
  assert.match(rep.unpriced.note, /UNPRICED/);
  assert.match(rep.unpriced.note, new RegExp(UNPRICED.replace("/", "\\/")));
  assert.equal(rep.total_usd_is_lower_bound, true);
  assert.match(rep.pricing_note, /gap in the table, not a saving/);
  // ...and the per-provider row says which of its calls are missing a price.
  assert.equal(rep.by_provider.mock.unpriced_calls, 1);
  assert.equal(rep.by_provider.mock.usd_is_lower_bound, true);
  assert.match(rep.by_provider.mock.note, /UNPRICED/);

  // The saving is refused outright: an `actual` of $0 replayed at strong's price would report 100%.
  const s = rep.routing_savings;
  assert.equal(s.measured, false);
  assert.deepEqual(s.unpriced_specs, [UNPRICED]);
  assert.equal(s.unpriced_calls, 1);
  assert.match(s.reason, /no entry in the price table/);
  assert.equal(s.saved_pct, undefined, "no percentage is printed that a table gap would inflate");
  assert.equal(s.saved_usd, undefined);
});

test("a priced arm still reports a measured saving", async (t) => {
  // The refusal above must not be a blanket one: this is the same run with prices that exist.
  const g = await startGateway({ aliases: { fast: ["mock/priced-model"], strong: ["mock/strong"] }, pricing: { mock: { input: 100, output: 100 } } });
  t.after(g.close);
  const d = await g.call("delegate", { task: "Say OK and nothing else.", model: "fast" });
  assert.equal(d.meta().unpriced, undefined);

  const rep = (await g.call("cost_report", { days: 1 })).json();
  assert.equal(rep.unpriced_calls, 0);
  assert.equal(rep.unpriced.note, null);
  assert.equal(rep.total_usd_is_lower_bound, false);
  assert.equal(rep.by_provider.mock.unpriced_calls, 0);
  assert.ok(rep.total_usd > 0, "the priced arm's spend is a real number, not a zero");

  const s = rep.routing_savings;
  assert.equal(s.measured, true);
  assert.equal(s.unpriced_calls, 0);
  assert.ok(s.actual_crew_usd > 0);
  assert.equal(typeof s.saved_pct, "number");
});

test("configure_budget names the alias candidates that have no price entry", async (t) => {
  // The gap should surface where prices are set, not only in the report that depends on them.
  const g = await startGateway();
  t.after(g.close);
  const r = (await g.call("configure_budget", { per_day_usd: 0 })).json();
  assert.ok(r.unpriced_candidates.includes(UNPRICED), "the alias candidate with no price entry is named");
  assert.ok(!r.unpriced_candidates.includes("mock/strong"), "a priced candidate is not listed");
});

test("a probe is priced like any other call, and an unpriced probe is flagged", async (t) => {
  // A probe is a real request: logging it without a cost would be the same silent $0 this issue is
  // about — the report counted the call and charged nothing for it.
  const g = await startGateway();
  t.after(g.close);
  const unpricedProbe = (await g.call("test_provider", { spec: UNPRICED, with_tools: false })).json().results[0];
  assert.equal(unpricedProbe.ok, true);
  assert.equal(unpricedProbe.priced, false);
  assert.equal(unpricedProbe.cost_usd, 0);
  const rep = (await g.call("cost_report", { days: 1 })).json();
  assert.equal(rep.unpriced.by_spec[UNPRICED], 1, "the probe's zero is attributed, not silent");

  const pricedProbe = (await g.call("test_provider", { spec: "mock/strong", with_tools: false })).json().results[0];
  assert.equal(pricedProbe.priced, true);
  assert.ok(pricedProbe.cost_usd > 0, "a priced probe reports what it cost");
});

test("a priced model is priced, and an unknown one stays unfilled rather than invented", async () => {
  // A price is only worth adding when it is published: `deepseek-flash` has a rate (fetched from
  // api-docs.deepseek.com/quick_start/pricing, peak cache-miss input / peak output), whereas a model
  // nobody published a rate for must stay `priced: false` and be reported as such instead of
  // acquiring a made-up number that would look like a measurement.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bf-pricing-cfg-")), "config.json");
  fs.writeFileSync(file, JSON.stringify({ budget: { perDayUsd: 0 } }));
  const config = loadConfig({ configPath: file }).config;
  assert.deepEqual(priceFor(config, "deepseek", "deepseek-flash"), { input: 0.3, output: 1.2, priced: true });
  assert.deepEqual(priceFor(config, "optimus", "qwen3.5:9b"), { input: 0, output: 0, priced: false });
  // An unpriced model's spend is 0 with `priced: false` — the two facts travel together, so no
  // caller can read the zero as a price.
  assert.deepEqual(costUsd(config, "optimus", "qwen3.5:9b", { prompt_tokens: 10_000, completion_tokens: 2000 }), { usd: 0, priced: false, output_tokens: 2000 });
  assert.equal(costUsd(config, "deepseek", "deepseek-flash", { prompt_tokens: 10_000, completion_tokens: 2000 }).usd, 0.0054);
});
