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

// --- one machine, many gateways ---------------------------------------------------------
// breaker.json is shared by every gateway on the machine - 28 on one of them. Each used to read
// it once and write its whole in-memory copy back, so a gateway that loaded the file hours ago
// erased every circuit another had opened, the moment it recorded one strike against anything.

test("a circuit opened by one gateway survives another gateway's unrelated strike", async () => {
  const { Breaker } = await import("../dist/breaker.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brk-multi-"));
  const cfg = { enabled: true, failures: 2, cooldownMs: 300_000 };

  const stale = new Breaker(dir, cfg);
  assert.equal(stale.openUntil("ollama"), undefined, "loaded before anything went wrong");

  const other = new Breaker(dir, cfg);
  other.record("ollama", "timeout");
  assert.equal(other.record("ollama", "timeout"), true, "the second strike opens it");

  // The stale gateway strikes a DIFFERENT provider. It used to write {kimi:...} over the file.
  stale.record("kimi", "timeout");
  assert.ok(new Breaker(dir, cfg).openUntil("ollama") !== undefined, "ollama's open circuit is still on disk");
  assert.ok(stale.openUntil("ollama") !== undefined, "and the stale gateway now sees it too, without paying for it");
});

test("a gateway that notices an outage already open does not report it again", async () => {
  const { Breaker } = await import("../dist/breaker.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brk-noticed-"));
  const cfg = { enabled: true, failures: 2, cooldownMs: 300_000 };
  const a = new Breaker(dir, cfg), b = new Breaker(dir, cfg);

  a.record("deepseek", "timeout");
  assert.equal(a.record("deepseek", "timeout"), true, "a opens it");
  // b strikes the same provider twice more: the circuit is already open, so these are not trips,
  // and each would otherwise have appended its own provider.circuit_open row.
  assert.equal(b.record("deepseek", "timeout"), false);
  assert.equal(b.record("deepseek", "timeout"), false);
});

test("the breaker file is never left half-written for another gateway to read", async () => {
  const { Breaker } = await import("../dist/breaker.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brk-atomic-"));
  const b = new Breaker(dir, { enabled: true, failures: 5, cooldownMs: 300_000 });
  for (let i = 0; i < 20; i += 1) b.record(`p${i}`, "x");
  // Written through a rename: no temp file is left behind, and what is there parses.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), []);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "breaker.json"), "utf8"))).length, 20);
});

// --- the shared lock gives up at once on an error waiting cannot fix -------------------------
test("a lock that cannot be created for a reason other than contention fails fast", async () => {
  const { withDirLock } = await import("../dist/atomic.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  // A directory that does not exist: mkdir fails with ENOENT, which no amount of waiting fixes.
  // Every retry used to be an Atomics.wait freezing the process for the whole 2s deadline.
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lock-")), "gone", "deeper");
  const t0 = Date.now();
  assert.equal(withDirLock(missing, () => "ran"), undefined, "not acquired");
  assert.ok(Date.now() - t0 < 200, `gave up in ${Date.now() - t0}ms instead of waiting out the deadline`);
});

test("config patches from two writers both land, and the file is never half-written", async () => {
  const { saveConfigPatch } = await import("../dist/config.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-")), "config.json");
  fs.writeFileSync(file, JSON.stringify({ providers: { deepseek: { apiKey: "keep-me" } } }));
  saveConfigPatch(file, { aliases: { fast: { candidates: ["deepseek/good"] } } });
  saveConfigPatch(file, { providers: { kimi: { enabled: false } } });
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(j.providers.deepseek.apiKey, "keep-me", "an unrelated setting survives every patch");
  assert.deepEqual(j.aliases.fast.candidates, ["deepseek/good"]);
  assert.equal(j.providers.kimi.enabled, false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")), []);
});
