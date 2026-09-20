// The circuit breaker: a host that is wedged must cost one timeout, not one per call.
// The bug behind this file: a fallback landed on a host that accepted TCP and then went
// silent, with timeoutMs 600000 and a retry, so a single delegation burned twenty minutes
// and every later call in the session burned twenty more.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockProvider } from "./mock-provider.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");

let mock, client, tmp, ws, configPath, sessionDir;

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  return { text, isError: !!r.isError };
};
const metaOf = (text) => JSON.parse(text.split("\nmeta: ").pop());

before(async () => {
  mock = await startMockProvider();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "breaker-test-"));
  ws = path.join(tmp, "repo");
  sessionDir = path.join(tmp, "sessions");
  fs.mkdirSync(ws, { recursive: true });
  configPath = path.join(tmp, "config.json");

  fs.writeFileSync(configPath, JSON.stringify({
    context: { toolProfile: "full" },
    sessionDir,
    logFile: false,
    // `slow` sleeps 3s, so 400ms is a timeout and not a slow answer.
    defaults: { model: "chain", timeoutMs: 400, maxSessionMessages: 8 },
    providers: {
      // Same server, two names: `wedged` always times out, `mock` always answers.
      wedged: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key", defaultModel: "slow" },
      mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" },
    },
    aliases: { chain: { candidates: ["wedged/slow", "mock/good"] } },
    fallback: { chain: [], retriesPerCandidate: 0, retryDelayMs: 0, breaker: { failures: 1, cooldownMs: 60000 } },
  }));

  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", configPath] });
  client = new Client({ name: "breaker-test", version: "1" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await mock?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a wedged provider costs one timeout, then is skipped outright", async () => {
  // The point is wall-clock, not bookkeeping: the timeout is paid once for the session.
  const t1 = Date.now();
  const first = await call("delegate", { task: "x", model: "chain" });
  const ms1 = Date.now() - t1;
  assert.ok(!first.isError, first.text);
  assert.match(metaOf(first.text).fallback_attempts.join(","), /wedged\/slow \[timeout\]/, "the first call has to discover the host is dead");
  assert.ok(ms1 >= 350, `expected a real timeout, took ${ms1}ms`);

  const t2 = Date.now();
  const second = await call("delegate", { task: "x", model: "chain" });
  const ms2 = Date.now() - t2;
  assert.ok(!second.isError, second.text);
  assert.match(metaOf(second.text).fallback_attempts.join(","), /wedged\/slow \[circuit_open\]/, "the second call must not pay the timeout again");
  assert.ok(ms2 < 250, `expected the dead host to be skipped, took ${ms2}ms`);
});

test("an open circuit skips the provider without abandoning the chain", async () => {
  const r = await call("delegate", { task: "x", model: "chain" });
  assert.ok(!r.isError, r.text);
  // Skipping a dead provider is not a reason to fail the call: the next candidate answers.
  assert.equal(metaOf(r.text).model, "mock/good");
});

test("the trip is on the fleet queue, so it is not invisible", async () => {
  const r = await call("fleet_status", {});
  const events = JSON.parse(r.text).pending ?? [];
  const trip = events.find((e) => e.kind === "provider.circuit_open");
  assert.ok(trip, `expected a provider.circuit_open event, got ${events.map((e) => e.kind).join(", ") || "none"}`);
  assert.equal(trip.id, "wedged");
});

test("strikes, half-open and recovery", async () => {
  const { Breaker } = await import("../dist/breaker.js");
  const dir = path.join(tmp, "unit");
  const cfg = { enabled: true, failures: 2, cooldownMs: 10_000 };
  const b = new Breaker(dir, cfg);
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");

  assert.equal(b.record("host", "timeout", t0), false, "one strike is not a verdict");
  assert.equal(b.openUntil("host", t0), undefined);
  assert.equal(b.record("host", "timeout", t0 + 100), true, "the second consecutive strike opens it");
  assert.equal(b.openUntil("host", t0 + 100), t0 + 100 + 10_000);

  // Half-open: the cooldown lapses, so one call is allowed through...
  assert.equal(b.openUntil("host", t0 + 20_000), undefined);
  // ...and a single further failure re-opens it, because the strikes were never forgiven.
  assert.equal(b.record("host", "timeout", t0 + 20_001), true);
  assert.ok(b.openUntil("host", t0 + 20_002));

  // Only an answer clears it.
  b.clear("host");
  assert.equal(b.openUntil("host", t0 + 20_003), undefined);
  assert.deepEqual(b.list(t0 + 20_003), []);
});

test("the open circuit survives a restart, so a dead host is not re-learned", async () => {
  const { Breaker } = await import("../dist/breaker.js");
  const dir = path.join(tmp, "persist");
  const cfg = { enabled: true, failures: 1, cooldownMs: 10_000 };
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  assert.equal(new Breaker(dir, cfg).record("host", "boom", t0), true);

  const fresh = new Breaker(dir, cfg);
  assert.equal(fresh.openUntil("host", t0 + 1), t0 + 10_000);
  assert.deepEqual(fresh.list(t0 + 1).map((c) => c.provider), ["host"]);
});

test("a corrupt state file forgets rather than throws", async () => {
  const { Breaker } = await import("../dist/breaker.js");
  const dir = path.join(tmp, "corrupt");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "breaker.json"), "{not json");
  const b = new Breaker(dir, { enabled: true, failures: 1, cooldownMs: 1000 });
  assert.equal(b.openUntil("host"), undefined, "forgetting costs one timeout; throwing costs every call");
});
