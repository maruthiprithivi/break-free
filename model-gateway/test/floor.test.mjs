// The tier floor: fallback must never silently substitute a model that cannot do the job.
// A task pinned to a capable model once landed on an 8B local one and produced nothing for
// thirty minutes, so these assert the floor refuses rather than degrades.
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
  return { text, isError: !!r.isError, json: () => JSON.parse(text) };
};
const metaOf = (text) => JSON.parse(text.split("\nmeta: ").pop());

before(async () => {
  mock = await startMockProvider();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "floor-test-"));
  ws = path.join(tmp, "repo");
  sessionDir = path.join(tmp, "sessions");
  fs.mkdirSync(ws, { recursive: true });
  configPath = path.join(tmp, "config.json");

  fs.writeFileSync(configPath, JSON.stringify({
    sessionDir,
    logFile: false,
    defaults: { model: "capable", timeoutMs: 1500, maxSessionMessages: 8 },
    // `capable` answers, `weak` also answers: the only thing separating them is tier,
    // so a refusal can only come from the floor and not from a transport failure.
    tiers: { "mockbad/good": 3, "mock/good": 1, "mock/boom500": 2, "mock2/good": 2 },
    providers: {
      mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" },
      mockbad: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "wrong" },
      mock2: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" },
    },
    aliases: {
      // tier 3 first (always fails auth), tier 1 behind it
      capable: { candidates: ["mockbad/good", "mock/good"] },
      // both tier 2: the first dies, the second answers, and nothing was given up
      sametier: { candidates: ["mock/boom500", "mock2/good"] },
    },
    fallback: { chain: [], retriesPerCandidate: 0, retryDelayMs: 0 },
  }));

  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", configPath] });
  client = new Client({ name: "floor-test", version: "1" }, { capabilities: {} });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await mock?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the floor refuses rather than silently dropping a tier", async () => {
  const r = await call("delegate", { task: "x", model: "capable" });
  // The tier 1 candidate can answer perfectly well. It is excluded because it is
  // below the floor derived from the model that was actually asked for.
  assert.match(r.text, /tier 3/);
  assert.match(r.text, /mock\/good \(tier 1\)/);
  assert.match(r.text, /min_tier|allow_downgrade/);
});

test("allow_downgrade opts in, and the downgrade is reported", async () => {
  const r = await call("delegate", { task: "x", model: "capable", allow_downgrade: true });
  assert.ok(!r.isError, r.text);
  const m = metaOf(r.text);
  assert.equal(m.model, "mock/good");
  assert.equal(m.requested_model, "capable");
  assert.equal(m.tier, 1);
  assert.equal(m.downgraded, true, "a tier 3 request answered by tier 1 must say so");
});

test("min_tier overrides the derived floor in both directions", async () => {
  // Down: accept tier 1 explicitly, without blanket allow_downgrade.
  const down = await call("delegate", { task: "x", model: "capable", min_tier: 1 });
  assert.ok(!down.isError, down.text);
  assert.equal(metaOf(down.text).model, "mock/good");

  // Up: demand tier 3 of a chain whose usable member is tier 1.
  const up = await call("delegate", { task: "x", model: "mock/good", min_tier: 3 });
  assert.match(up.text, /tier 3/);
});

test("a same-tier fallback is not a downgrade", async () => {
  const r = await call("delegate", { task: "x", model: "sametier" });
  assert.ok(!r.isError, r.text);
  const m = metaOf(r.text);
  assert.equal(m.tier, 2);
  assert.equal(m.downgraded, false, "falling back within a tier must stay silent");
});
