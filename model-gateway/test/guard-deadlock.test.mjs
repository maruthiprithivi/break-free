/**
 * The turn-end guard must never name a way out that does not exist.
 *
 * The guard blocks the end of a turn when work is still pending and tells the agent what to
 * call to collect it. Two independent changes turned that into a deadlock: the compact tool
 * profile moved `fleet_status` behind discovery, so the named tool was not advertised, and the
 * message said "call fleet_status" without `drain:true`, so even reaching it left the events
 * pending. The guard then blocked again on the identical list, every turn, with no escape.
 *
 * These tests pin the invariant rather than the two symptoms: a blocking message may only name
 * tools the agent can actually see, and reading a job's outcome must clear its wake event.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendEvents, pendingEvents, resolveJob, drainTo } from "../dist/fleet.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");
let tmp;

/** A workspace with a config, and a pending job.done nobody has collected. */
function stuckSession(toolProfile = "compact") {
  const dir = fs.mkdtempSync(path.join(tmp, "guard-"));
  const ws = path.join(dir, "repo");
  const sessionDir = path.join(dir, "sessions");
  fs.mkdirSync(ws, { recursive: true });
  const cfg = path.join(dir, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ sessionDir, logFile: false, context: { toolProfile }, providers: {} }));
  return { ws, cfg, sessionDir };
}

const names = async (c) => (await c.listTools()).tools.map((t) => t.name);
async function gateway(ws, cfg) {
  const client = new Client({ name: "guard-test", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", cfg] }));
  return client;
}

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-test-")); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test("every tool the blocking guard names is advertised under the compact profile", async () => {
  const { ws, cfg, sessionDir } = stuckSession("compact");
  appendEvents(sessionDir, [{ ts: new Date().toISOString(), kind: "job.done", id: "delegate-stuck-1", reason: "done" }], ws);

  const out = execFileSync(process.execPath, [entry, "--workspace", ws, "--config", cfg, "--fleet-check", "--hook"], { encoding: "utf8" });
  const decision = JSON.parse(out.trim());
  assert.equal(decision.decision, "block", "a pending event must still block; this test is about the way out, not the guard");
  assert.match(decision.reason, /job\.done delegate-stuck-1/, "and it still names what is pending");

  // Which words in that message are tool names is answered by the gateway itself, not by a
  // list kept here that would drift exactly as the two sides of this bug drifted.
  const [compact, full] = [await gateway(ws, cfg), await gateway(ws, stuckSession("full").cfg)];
  try {
    const advertised = new Set(await names(compact));
    const named = (await names(full)).filter((n) => decision.reason.includes(n));
    assert.ok(named.length > 0, `the guard must name a way out: ${decision.reason}`);
    for (const n of named) {
      assert.ok(advertised.has(n), `the guard tells the agent to call ${n}, which compact does not advertise - that is the deadlock`);
    }
  } finally { await compact.close(); await full.close(); }
});

test("the guard names the call that actually drains, not just the tool", async () => {
  const { ws, cfg, sessionDir } = stuckSession();
  appendEvents(sessionDir, [{ ts: new Date().toISOString(), kind: "job.done", id: "delegate-stuck-2", reason: "done" }], ws);
  const { reason } = JSON.parse(execFileSync(process.execPath, [entry, "--workspace", ws, "--config", cfg, "--fleet-check", "--hook"], { encoding: "utf8" }).trim());
  // Without drain:true the events survive the call and the next turn blocks on the same list.
  assert.match(reason, /drain:true/, "following the instruction has to end the block");
});

test("reading a job's outcome clears its wake event, and only its own", async () => {
  const { ws, sessionDir } = stuckSession();
  appendEvents(sessionDir, [
    { ts: new Date().toISOString(), kind: "job.done", id: "job-a", reason: "done" },
    { ts: new Date().toISOString(), kind: "job.done", id: "job-b", reason: "done" },
    { ts: new Date().toISOString(), kind: "job.failed", id: "job-c", reason: "failed" },
  ], ws);
  assert.equal(pendingEvents(sessionDir, ws).length, 3);

  assert.equal(resolveJob(sessionDir, "job-a"), 1);
  assert.deepEqual(pendingEvents(sessionDir, ws).map((e) => e.id), ["job-b", "job-c"], "collecting one job leaves the others alone");

  // A failure is collected by reading it too, or a failed job wedges the turn forever.
  assert.equal(resolveJob(sessionDir, "job-c"), 1);
  assert.deepEqual(pendingEvents(sessionDir, ws).map((e) => e.id), ["job-b"]);

  assert.equal(resolveJob(sessionDir, "job-a"), 0, "resolving twice is a no-op, not a rewind");
  assert.equal(resolveJob(sessionDir, "no-such-job"), 0);
});

// --- one condition, one event -----------------------------------------------------------
// `harness.idle` and a finished job are conditions, not moments: the classifier re-derives
// them from the snapshot on every check, so appending unconditionally turns one idle session
// into one event per check. A real queue held 287 copies of a single idle session, the same
// finished plan 15 times, and the guard dutifully reported all of them as outstanding work.

test("a condition that is still true does not become a second event", () => {
  const { ws, sessionDir } = stuckSession();
  const idle = (ms) => ({ ts: new Date().toISOString(), kind: "harness.idle", id: "tmux-7f28", reason: `idle for ${ms}ms` });

  assert.equal(appendEvents(sessionDir, [idle(60_000)], ws).length, 1);
  // Ten more checks of a session that is simply still idle.
  for (let i = 0; i < 10; i += 1) assert.equal(appendEvents(sessionDir, [idle(60_000 + i * 10_000)], ws).length, 0);
  assert.equal(pendingEvents(sessionDir, ws).length, 1, "still one thing to know about, however long it stays true");

  // Two gateways racing on the shared snapshot make a finished job look new again to whichever
  // wrote last. The reader cannot tell the copies apart, so it must not receive them.
  const done = { ts: new Date().toISOString(), kind: "job.done", id: "run_plan-x", reason: "done" };
  assert.equal(appendEvents(sessionDir, [done], ws).length, 1);
  assert.equal(appendEvents(sessionDir, [done], ws).length, 0);
  assert.deepEqual(pendingEvents(sessionDir, ws).map((e) => e.kind).sort(), ["harness.idle", "job.done"]);
});

test("once collected, the same condition may be raised again", () => {
  const { ws, sessionDir } = stuckSession();
  const idle = { ts: new Date().toISOString(), kind: "harness.idle", id: "tmux-7f28", reason: "idle" };
  const [first] = appendEvents(sessionDir, [idle], ws);
  assert.equal(appendEvents(sessionDir, [idle], ws).length, 0);

  // Suppressing forever would be the opposite bug: a session that goes idle again after
  // someone has dealt with it is news, and would never be reported.
  drainTo(sessionDir, first.seq, ws);
  assert.equal(pendingEvents(sessionDir, ws).length, 0);
  assert.equal(appendEvents(sessionDir, [idle], ws).length, 1, "a fresh occurrence after collection is news again");

  // The same holds for the sidecar path: a job read via job_result can legitimately recur.
  const done = { ts: new Date().toISOString(), kind: "job.done", id: "job-z", reason: "done" };
  appendEvents(sessionDir, [done], ws);
  resolveJob(sessionDir, "job-z");
  assert.equal(appendEvents(sessionDir, [done], ws).length, 1);
});

test("events are deduplicated per workspace, not across the machine", () => {
  const { sessionDir } = stuckSession();
  const done = { ts: new Date().toISOString(), kind: "job.done", id: "shared-id", reason: "done" };
  assert.equal(appendEvents(sessionDir, [done], "/repo/a").length, 1);
  // Another project's gateway must still be told about its own job, even under the same id.
  assert.equal(appendEvents(sessionDir, [done], "/repo/b").length, 1);
  assert.equal(appendEvents(sessionDir, [done], "/repo/a").length, 0);
  assert.equal(pendingEvents(sessionDir, "/repo/a").length, 1);
  assert.equal(pendingEvents(sessionDir, "/repo/b").length, 1);
});
