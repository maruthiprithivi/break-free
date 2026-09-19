// The tripwire end-to-end, through the real MCP server: a worker neuters a test, verify goes
// green, no glob matches the path, and the tripwire is the only thing that notices.
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

/** One gateway per test: config and ledger are read once at startup. */
async function startGateway(configOver = {}, wsOver = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-tw-e2e-"));
  let ws = path.join(tmp, "repo");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.mkdirSync(path.join(ws, "test"), { recursive: true });
  ws = fs.realpathSync(ws);
  fs.writeFileSync(path.join(ws, "ok.mjs"), "process.exit(0);\n");
  for (const [file, body] of Object.entries(wsOver)) fs.writeFileSync(path.join(ws, file), body);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: ws });
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sessionDir: path.join(tmp, "sessions"),
      logFile: path.join(tmp, "gateway.log"),
      defaults: { model: "fast", reviewer: "mock/good", timeoutMs: 8000, maxToolIterations: 2 },
      fallback: { chain: ["mock/good"], retriesPerCandidate: 0, retryDelayMs: 0 },
      providers: { mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" }, typesafe: { baseUrl: double.url, apiKey: "test-key" } },
      aliases: { fast: ["mock/tooly"], strong: ["mock/good"], reviewer: ["mock/good"] },
      routing: { engine: "off" },
      workers: { allowedCommands: ["node"], maxConcurrency: 1, projectInstructions: false },
      ...configOver,
    }),
  );
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", configPath], env: { ...process.env, TYPESAFE_API_KEY: "", BREAK_FREE_ROUTING: "" }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text ?? "").join("\n");
    return { text, isError: !!r.isError, json: () => JSON.parse(text), meta: () => JSON.parse(text.slice(text.lastIndexOf("\nmeta: ") + 7)) };
  };
  const close = async () => {
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { call, ws, close };
}

/** A worker turn that writes a neutered test through the real write_file tool. */
const neuter = `Add a test that the sum helper works.
CALL write_file {"path":"test/sum.test.ts","content":"it.skip('sums', () => {})"}`;

before(async () => {
  mock = await startMockProvider();
  double = await startTypeSafeDouble({});
});

after(async () => {
  await mock?.close();
  await double?.close();
});

const CHECK_RULE = { policy: { rules: [{ match: "**/*.test.ts", action: "check", reason: "read every test diff" }] } };

test("a worker that skips a test is caught even though verify goes green and no glob would", async (t) => {
  const g = await startGateway(CHECK_RULE);
  t.after(g.close);
  double.setDecisions({ h0: { test_weakened: 0.96, risk: 4, risk_confidence: 0.93 } });
  const r = await g.call("run_plan", { tasks: [{ id: "sum", task: neuter, verify: "node ok.mjs", capabilities: ["read", "write", "run"], acceptance: "a test proves the sum helper works" }] });
  const meta = r.meta();
  assert.equal(meta.results[0].status, "failed", "the tripwire must reject it");
  assert.match(meta.results[0].error, /tripwire blocked the diff/);
  assert.match(meta.results[0].error, /test\/sum\.test\.ts/);
  // the summary the lead reads names the hunk, the threshold that fired and the probability
  // "verify ok · tripwire BLOCK" is the whole point: a green suite and a blocked diff side by side
  assert.match(r.text, /\*\*sum\*\* — FAILED · verify ok · tripwire BLOCK — tripwire blocked the diff: test\/sum\.test\.ts \(risk 4\.00 >= 3\.5\)/);
  assert.equal(meta.results[0].tripwire.verdict, "block", "and the failing task still carries the evidence");
  assert.equal(meta.results[0].tripwire.blocked, 1);
  // and the worker's own verify genuinely passed — the tripwire is the only thing that caught it
  assert.equal(meta.results[0].verify.ok, true);
  assert.match(r.text, /FAILED · verify ok · tripwire BLOCK/, "the lead sees a green verify and a blocked diff together");
});

test("a clean diff of the same shape is accepted and the tripwire says it ran", async (t) => {
  const g = await startGateway(CHECK_RULE);
  t.after(g.close);
  double.setDecisions({ h0: { test_weakened: 0.02, security_touch: 0.01, destructive_data: 0, scope_creep: 0.1, risk: 0.5, risk_confidence: 0.9 } });
  const r = await g.call("run_plan", { tasks: [{ id: "sum", task: neuter, verify: "node ok.mjs", capabilities: ["read", "write", "run"] }] });
  const meta = r.meta();
  assert.equal(meta.results[0].status, "done");
  assert.equal(meta.results[0].tripwire.verdict, "allow");
  assert.deepEqual([meta.results[0].tripwire.ran, meta.results[0].tripwire.flagged, meta.results[0].tripwire.clean], [true, 0, true]);
  assert.match(r.text, /## Tripwire \(ALLOW\)/);
  assert.match(r.text, /tripwire ALLOW — 1 hunk\(s\), 0 flagged, 0 blocked/);
});

test("the tripwire is scoped by check rules: a path outside them is never sent", async (t) => {
  const g = await startGateway(CHECK_RULE);
  t.after(g.close);
  const before = double.requests.length;
  const r = await g.call("run_plan", { tasks: [{ id: "src", task: `Edit the source.\nCALL write_file {"path":"src/a.ts","content":"export const a = 1;"}`, verify: "node ok.mjs", capabilities: ["read", "write", "run"] }] });
  assert.equal(r.meta().results[0].status, "done");
  assert.equal(double.requests.length, before, "no tripwire call for a path no check rule covers");
  assert.equal(r.text.includes("## Tripwire"), false);
});

test("with no check rule at all the tripwire does not exist", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const before = double.requests.length;
  const r = await g.call("run_plan", { tasks: [{ id: "sum", task: neuter, verify: "node ok.mjs", capabilities: ["read", "write", "run"] }] });
  assert.equal(r.meta().results[0].status, "done", "nothing to block it");
  assert.equal(double.requests.length, before);
});

test("a clean tripwire can stand in for a blanket review, and says that is what it did", async (t) => {
  const g = await startGateway({ ...CHECK_RULE, tripwire: { skipPlanReview: true } });
  t.after(g.close);
  double.setDecisions({ h0: { test_weakened: 0.01, security_touch: 0.01, destructive_data: 0, scope_creep: 0.02, risk: 0.2, risk_confidence: 0.95 } });
  const beforeCalls = mock.calls.length;
  const r = await g.call("run_plan", { review: true, tasks: [{ id: "sum", task: neuter, verify: "node ok.mjs", capabilities: ["read", "write", "run"] }] });
  assert.equal(r.meta().results[0].status, "done");
  assert.equal(r.meta().results[0].review, undefined, "the full review was skipped");
  assert.equal(r.meta().results[0].tripwire.skip_plan_review, true);
  assert.match(r.text, /stands in for the blanket plan-level review/);
  // the worker's own turns are expected; a REVIEWER call is not
  const reviewerCalls = mock.calls.slice(beforeCalls).filter((c) => /independent, skeptical code reviewer/.test(c.messages.find((m) => m.role === "system")?.content ?? ""));
  assert.equal(reviewerCalls.length, 0, "no reviewer ran");
});

test("an engine that cannot answer is not treated as a clean one", async (t) => {
  const g = await startGateway(CHECK_RULE);
  t.after(g.close);
  double.setMode("server_error");
  const r = await g.call("run_plan", { tasks: [{ id: "sum", task: neuter, verify: "node ok.mjs", capabilities: ["read", "write", "run"] }] });
  const meta = r.meta();
  assert.equal(meta.results[0].status, "done", "an unavailable tripwire must not block work by itself");
  assert.match(r.text, /## Tripwire \(REVIEW\)/);
  assert.match(r.text, /tripwire could not run: unknown, so not trusted/);
  // and it must NOT report clean: unknown is not the same as safe
  assert.equal(meta.results[0].tripwire.verdict, "review");
  assert.equal(meta.results[0].tripwire.clean, false);
  double.setMode("ok");
});
