import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { detectFirstmateMode } from "../dist/fmmode.js";
import { estimateTokens } from "../dist/context.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");

async function fixture({ worker = false, home = false, off = false, profile = "full" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-fmmode-"));
  const ws = path.join(dir, "workspace");
  fs.mkdirSync(ws);
  if (home) {
    fs.mkdirSync(path.join(ws, "bin"));
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Firstmate\nA fixture home.\n");
    fs.writeFileSync(path.join(ws, "bin", "fm-spawn.sh"), "#!/bin/sh\n");
  }
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({
    sessionDir: path.join(dir, "sessions"), logFile: false,
    updates: { check: false, apply: false },
    context: { toolProfile: profile }, firstmate: { mode: off ? "off" : "auto" },
  }));
  const client = new Client({ name: "fmmode-test", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [entry, "--workspace", ws, "--config", cfg],
    env: { ...process.env, FM_TASK_ID: worker ? "t1" : "" }, stderr: "pipe",
  }));
  return { client, dir };
}

async function using(options, run) {
  const { client, dir } = await fixture(options);
  try { await run(client); }
  finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const call = async (client, operation, args = {}) => {
  const result = await client.callTool({ name: "bf_invoke", arguments: { operation, arguments: args } });
  return { error: !!result.isError, text: result.content.map((x) => x.text).join("\n") };
};
const discover = async (client) => JSON.parse((await client.callTool({ name: "bf_discover", arguments: {} })).content[0].text);

test("detects worker before home, primary from home signature, and off as standalone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-fmdetect-"));
  try {
    assert.equal(detectFirstmateMode(dir, "auto", "t1"), "worker");
    assert.equal(detectFirstmateMode(dir, "auto", ""), "standalone");
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Firstmate\n");
    fs.writeFileSync(path.join(dir, "bin", "fm-spawn.sh"), "");
    assert.equal(detectFirstmateMode(dir, "auto", ""), "primary");
    assert.equal(detectFirstmateMode(dir, "auto", "t1"), "worker");
    assert.equal(detectFirstmateMode(dir, "off", "t1"), "standalone");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("worker advertises two tools, has a small standing surface, and refuses owner operations", async () => {
  await using({ worker: true, home: true }, async (client) => {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((x) => x.name).sort(), ["bf_discover", "bf_invoke"]);
    const listed = await discover(client);
    assert.deepEqual(listed.operations.map((x) => x.operation).sort(), ["list_models", "panel", "review"]);
    // context_report itself is refused in worker mode, so count its two standing surfaces here.
    const instructions = "You are a Firstmate crewmate; do the work yourself. break-free is only your model transport; use panel or review only when your brief asks.";
    const tokens = tools.reduce((n, t) => n + estimateTokens(JSON.stringify(t)), 0) + estimateTokens(instructions);
    assert.ok(tokens < 1000, `worker standing surface is ${tokens} tokens`);
    for (const operation of ["delegate", "run_plan", "supervise", "context_report", "cost_report"]) {
      const result = await call(client, operation);
      assert.equal(result.error, true);
      assert.match(result.text, /Firstmate owner/);
    }
    const schema = await client.callTool({ name: "bf_discover", arguments: { operation: "delegate" } });
    assert.equal(schema.isError, true);
  });
});

test("primary exposes model operations, cost_report works, and no ledger brief is charged", async () => {
  await using({ home: true }, async (client) => {
    assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), ["bf_discover", "bf_invoke"]);
    const listed = await discover(client);
    assert.deepEqual(listed.operations.map((x) => x.operation).sort(), [
      "configure_alias", "configure_budget", "configure_fallback", "configure_provider",
      "context_report", "cost_report", "gateway_logs", "list_models", "list_providers", "test_provider",
    ]);
    const cost = await call(client, "cost_report");
    assert.equal(cost.error, false);
    const report = await call(client, "context_report");
    assert.equal(report.error, false);
    assert.doesNotMatch(report.text, /ledger resume brief/);
    const denied = await call(client, "delegate");
    assert.equal(denied.error, true);
    assert.match(denied.text, /dispatch a crewmate on break-free\/<alias>/i);
  });
});

test("mode off retains standalone tools even in a Firstmate worker", async () => {
  await using({ home: true, worker: true, off: true }, async (client) => {
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("delegate"));
    assert.ok(names.includes("ledger_resume"));
  });
});
