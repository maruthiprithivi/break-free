// Phase 2 of issue #12 — liveness measured in tool calls.
//
// The failure this exists for: a task pinned to a frontier model fell back onto a host that
// accepted the connection and then said nothing. The worker was not failing, it was not *doing*
// anything, and nothing measured that, so it spun for thirty minutes without writing a byte.
//
// The thing under test is a clock, so the provider's *timing* is what the test controls: the
// shared mock's fixed 3 s "slow" model cannot express a threshold. Every threshold here is
// milliseconds, so the suite stays fast and does not depend on a real model being slow.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");

/**
 * A chat provider whose replies the test schedules: every response waits `turnMs`, and the first
 * `toolCalls` responses call `read_file` instead of answering. `turnMs` beyond the stall threshold
 * is how a stall is made observable — the request is simply never answered in time.
 */
function startPacedProvider({ turnMs = 0, toolCalls = 0 } = {}) {
  const calls = [];
  let answered = 0;
  const timers = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.url.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      // The watchdog aborts mid-reply; that is the subject of the test, not a failure of it.
      res.on("error", () => {});
      calls.push(JSON.parse(body));
      const n = answered++;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (res.destroyed || res.writableEnded) return;
        const withTool = n < toolCalls;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "paced-1",
            choices: [
              {
                index: 0,
                finish_reason: withTool ? "tool_calls" : "stop",
                message: withTool
                  ? { role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "read_file", arguments: '{"path":"loop.txt"}' } }] }
                  : { role: "assistant", content: "finished" },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        );
      }, turnMs);
      timers.add(timer);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        calls,
        close: () => {
          for (const t of timers) clearTimeout(t);
          timers.clear();
          server.closeAllConnections?.();
          return new Promise((r) => server.close(r));
        },
      }),
    );
  });
}

/** One gateway process per test: the config (and the liveness thresholds in it) is read at startup. */
async function startGateway({ port, workers = {}, defaults = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-stall-"));
  const ws = path.join(tmp, "repo");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "loop.txt"), "nothing to see here\n");
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sessionDir: path.join(tmp, "sessions"),
      logFile: path.join(tmp, "gateway.log"),
      defaults: { model: "paced/worker", reviewer: "paced/worker", supervisor: "paced/worker", timeoutMs: 8000, maxToolIterations: 4, ...defaults },
      fallback: { chain: [], retriesPerCandidate: 0, retryDelayMs: 0 },
      providers: { paced: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", supportsTools: true } },
      workers: { allowedCommands: ["node"], projectInstructions: false, ...workers },
    }),
  );
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", configPath] });
  const client = new Client({ name: "stall-test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join("\n");
    return { text, isError: !!r.isError, meta: () => JSON.parse(text.slice(text.lastIndexOf("\nmeta: ") + 7)) };
  };
  const logEvents = () => {
    const f = path.join(tmp, "gateway.log");
    if (!fs.existsSync(f)) return [];
    return fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  };
  return {
    call,
    ws,
    logEvents,
    close: async () => {
      await client.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test("a worker with no tool call past stallAbortMs is aborted as `stalled`, not left running", async (t) => {
  const paced = await startPacedProvider({ turnMs: 10_000 }); // never answers in time
  t.after(paced.close);
  const g = await startGateway({ port: paced.port, workers: { stallWarnMs: 50, stallAbortMs: 250 } });
  t.after(g.close);

  const started = Date.now();
  const r = await g.call("run_plan", { goal: "stall", tasks: [{ id: "hang", task: "do the thing", model: "paced/worker" }] });
  const ms = Date.now() - started;

  const row = r.meta().results[0];
  assert.equal(r.meta().ok, false);
  assert.equal(row.status, "stalled", r.text);
  assert.match(row.error, /^stalled: no tool call for \d+ms/);
  assert.equal(row.stall.tool_calls, 0);
  assert.equal(row.stall.files_written, 0);
  assert.ok(row.stall.ms_since_tool_call >= 250, JSON.stringify(row.stall));
  // distinguishable from the two other ways a task dies
  assert.equal(/timed out|verification failed/i.test(row.error), false, row.error);
  assert.match(r.text, /\*\*hang\*\* — STALLED/);
  // aborted on its own threshold, not on the 8 s provider timeout
  assert.ok(ms < 3000, `aborted on the stall threshold, not the provider timeout: ${ms}ms`);

  // the warning comes first, so a stall is visible before it is fatal
  const stalls = g.logEvents().filter((e) => e.kind === "worker.stall");
  assert.equal(stalls[0].reason, "idle", JSON.stringify(stalls));
  assert.equal(stalls.at(-1).reason, "abort", JSON.stringify(stalls));
  assert.equal(stalls.filter((e) => e.reason === "abort").length, 1, "aborted once");
});

test("stall_abort_ms: 0 on the call disables the threshold, and a timeout is not a stall", async (t) => {
  const paced = await startPacedProvider({ turnMs: 30_000 });
  t.after(paced.close);
  // The config would abort this task at 150 ms. The call says not to, which is both the "0
  // disables" check and the proof that a per-call setting reaches the engine.
  const g = await startGateway({ port: paced.port, workers: { stallAbortMs: 150 }, defaults: { timeoutMs: 400 } });
  t.after(g.close);

  const r = await g.call("run_plan", { tasks: [{ id: "slow", task: "do the thing", model: "paced/worker", stall_abort_ms: 0 }] });
  const row = r.meta().results[0];
  assert.equal(row.status, "failed", r.text);
  assert.match(row.error, /timed out after 400ms/);
  assert.equal(/stalled/.test(row.error), false, "a provider timeout must not be dressed up as a stall");
  assert.equal(row.stall, undefined);
});

test("a worker that keeps calling tools is not stalled by the clock", async (t) => {
  // Four tool calls, 250 ms each: the run outlives the 600 ms threshold while no single gap
  // between tool calls comes close to it. Anything that measures total wall-clock fails this.
  const paced = await startPacedProvider({ turnMs: 250, toolCalls: 4 });
  t.after(paced.close);
  const g = await startGateway({ port: paced.port, workers: { stallWarnMs: 0, stallAbortMs: 600 }, defaults: { maxToolIterations: 4 } });
  t.after(g.close);

  const started = Date.now();
  const r = await g.call("delegate", { task: "read loop.txt until you are done", model: "paced/worker", capabilities: ["read"] });
  const ms = Date.now() - started;

  assert.equal(r.isError, false, r.text);
  assert.equal(/stalled/.test(r.text), false, r.text);
  assert.equal(r.meta().tool_calls, 4);
  assert.ok(ms > 600, `the run took ${ms}ms, past the threshold — it survived on tool calls, not on being quick`);
});

test("a write-capable worker that has written nothing after several iterations is warned", async (t) => {
  const paced = await startPacedProvider({ toolCalls: 4 }); // calls read_file every turn, writes nothing
  t.after(paced.close);
  const g = await startGateway({ port: paced.port, workers: { stallWarnMs: 0, stallAbortMs: 0, stallWarnIterations: 2 } });
  t.after(g.close);

  const r = await g.call("delegate", { task: "investigate the thing", model: "paced/worker", capabilities: ["write"] });
  assert.equal(r.isError, false, r.text);

  const warned = g.logEvents().find((e) => e.kind === "worker.stall" && e.reason === "no-writes");
  assert.ok(warned, `no no-writes warning in ${JSON.stringify(g.logEvents().filter((e) => e.kind === "worker.stall"))}`);
  assert.equal(warned.files_written, 0);
  assert.equal(warned.tool_calls, 2, "warned at the iteration threshold, not at the end");
});
